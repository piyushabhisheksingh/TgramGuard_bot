import { Composer } from 'grammy';
import { recordActivity, getUserSummary, isOptedOut, setOptOut, getUserProfile, recordProfileSnapshot, applyAIMetrics } from '../store/health.js';
import { textHasLink, containsExplicit } from '../filters.js';
import { computeHealthScore, computeDisciplineScore, categorize, aiAssessment, buildStyleTraits, aiPersonalityAssessment } from '../health/score.js';
import { classifyText as aiClassifyText } from '../ai/provider_openai.js';
import { getSettings } from '../store/settings.js';
import { getSupabase } from '../store/supabase.js';

function esc(s = '') {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isBotOwner(ctx) {
  const userId = ctx.from?.id;
  const ownerId = Number(process.env.BOT_OWNER_ID || NaN);
  return Number.isFinite(ownerId) && userId === ownerId;
}

async function isBotAdminOrOwner(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isBotOwner(ctx)) return true;
  try {
    const s = await getSettings();
    return s.bot_admin_ids.includes(userId);
  } catch { return false; }
}

function buildSuggestions(summary) {
  const tips = [];
  const lateHours = summary.top_hours.filter(h => h >= 0 && (h <= 5 || h >= 22));
  const earlyHours = summary.top_hours.filter(h => h >= 6 && h <= 9);
  if (lateHours.length >= 2) tips.push('You seem active late at night. Aim for consistent sleep by reducing screen time after 11 PM.');
  if (earlyHours.length >= 2) tips.push('Great early activity pattern. Keep a regular wake-up time and hydrate early.');
  if (summary.week_count > 500) tips.push('High weekly chat activity detected. Consider scheduled focus blocks away from screens.');
  if (summary.avg_message_len > 300) tips.push('Your messages are quite long on average. Try concise notes and short breaks to avoid fatigue.');
  if (summary.streak_days >= 7) tips.push('You have a 7+ day activity streak. Add short outdoor breaks to balance screen time.');
  if (tips.length === 0) tips.push('Nice balanced routine. Keep regular sleep, hydrate well, and move every hour.');
  return tips;
}

function buildPersonalitySuggestions(profile) {
  const tips = [];
  const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
  if ((profile?.changes?.name || 0) >= 3) tips.push('Frequent name changes can confuse others. Keep a consistent display name for a stable identity.');
  if ((profile?.changes?.username || 0) >= 3) tips.push('Sticking to one username helps people find and trust you.');
  if (profile?.username && /\d{3,}/.test(profile.username)) tips.push('A simpler username without long digit sequences looks more professional.');
  const bio = String(profile?.bio || '');
  if (bio) {
    if (textHasLink(bio)) tips.push('Avoid links in your bio to reduce distraction and appear less promotional.');
    if (containsExplicit(bio)) tips.push('Keep your bio clean and respectful.');
    if (bio.length > 200) tips.push('Shorten your bio to the essentials for a clearer impression.');
  } else {
    tips.push('Add a short, positive bio that reflects your interests.');
  }
  // Ancient Indian wisdom inspired suggestions
  tips.push('Try 5–10 minutes of pranayama (deep breathing) daily to boost focus.');
  tips.push('A short morning yoga stretch or Surya Namaskar can energize your day.');
  tips.push('Practice 5 minutes of meditation to cultivate calm and clarity.');
  // Deduplicate
  const seen = new Set();
  return tips.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
}

export function healthMiddleware() {
  const composer = new Composer();
  const adviseCooldownMs = Number(process.env.HEALTH_ADVISE_COOLDOWN_MS || 24 * 60 * 60 * 1000); // default 24h
  const lastAdvice = new Map(); // userId -> ts

  // Activity tracking across common update types
  composer.on('message', async (ctx) => {
    const userId = ctx.from?.id; const chatId = ctx.chat?.id;
    const text = ctx.message?.text || ctx.message?.caption || '';
    const len = text.length;
    await recordActivity({ userId, chatId, type: 'message', textLen: len, when: new Date(), content: text });
    // Optional AI moderation analysis to enrich comms metrics
    try {
      const enabled = String(process.env.AI_ENABLE || '').toLowerCase();
      const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
      if ((enabled === '1' || enabled === 'true') && provider === 'openai' && text) {
        const r = await aiClassifyText(text);
        if (r && Number.isFinite(userId)) {
          const s = r.scores || {};
          const tox = (s['harassment'] || 0) + (s['harassment/threatening'] || 0) + (s['hate'] || 0) + (s['hate/threatening'] || 0) + (s['violence'] || 0) + (s['insult'] || 0);
          const sex = s['sexual'] || 0;
          await applyAIMetrics(userId, { toxicity: tox, sexual: sex });
        }
      }
    } catch {}
    // Profile snapshot tracking (name/username/bio changes)
    try {
      if (Number.isFinite(userId)) {
        const profile = await getUserProfile(userId);
        const lastChk = profile?.last_checked_ts ? Date.parse(profile.last_checked_ts) : 0;
        const bioTtl = Number(process.env.HEALTH_BIO_CHECK_MS || 6 * 60 * 60 * 1000); // 6h
        let bio = profile?.bio || '';
        if (!Number.isFinite(lastChk) || (Date.now() - lastChk) > bioTtl) {
          try { const ch = await ctx.api.getChat(userId); if (ch?.bio) bio = ch.bio; } catch {}
        }
        await recordProfileSnapshot({ userId, first_name: ctx.from?.first_name, last_name: ctx.from?.last_name, username: ctx.from?.username, bio });
      }
    } catch {}
    // Auto-guide severe category members occasionally
    if (Number.isFinite(userId)) {
      try {
        if (await isOptedOut(userId)) return;
        const now = Date.now();
        const last = lastAdvice.get(userId) || 0;
        if (now - last < adviseCooldownMs) return;
        const summary = await getUserSummary(userId);
        if (!summary) return;
        const health = computeHealthScore(summary);
        const discipline = await computeDisciplineScore(userId, chatId);
        const catH = categorize(health.score);
        const catD = categorize(discipline.score);
        const severe = (catH.label === 'Severe') || (catD.label === 'Severe');
        if (!severe) return;
        lastAdvice.set(userId, now);
        const ai = await aiAssessment(summary, discipline);
        const aiStyle = await aiPersonalityAssessment(summary);
        const tips = [
          'Consider a consistent sleep window and reduce late-night screen time.',
          'Take short breaks every hour and hydrate regularly.',
          'Keep messages concise and plan focus blocks away from chats.'
        ];
        const pTips = buildPersonalitySuggestions(summary.profile || {});
        const msg = [
          '<b>Gentle Reminder</b> — your recent activity suggests you could benefit from a healthier routine.',
          `Health score: <b>${health.score}</b> (${catH.label}); Discipline score: <b>${discipline.score}</b> (${catD.label}).`,
          aiStyle ? aiStyle : undefined,
          ai ? ai : `Tips:\n• ${esc(tips.concat(pTips.slice(0, 3)).join('\n• '))}`,
          'Use /health for a personal snapshot or /health_optout to disable.',
        ].filter(Boolean).join('\n');
        try { await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch {}
      } catch {}
    }
  });

  composer.on('edited_message', async (ctx) => {
    const userId = ctx.from?.id; const chatId = ctx.chat?.id;
    const text = ctx.editedMessage?.text || ctx.editedMessage?.caption || '';
    const len = text.length;
    await recordActivity({ userId, chatId, type: 'edit', textLen: len, when: new Date(), content: text });
  });

  composer.on('callback_query', async (ctx) => {
    const userId = ctx.from?.id; const chatId = ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    await recordActivity({ userId, chatId, type: 'callback', textLen: 0, when: new Date() });
    return ctx.answerCallbackQuery();
  });

  composer.on('poll_answer', async (ctx) => {
    const userId = ctx.pollAnswer?.user?.id; const chatId = 0; // chat unknown for poll_answer
    if (Number.isFinite(userId)) await recordActivity({ userId, chatId, type: 'poll', textLen: 0, when: new Date() });
  });

  // Commands: /health, /health_user, /health_optout, /health_optin
  composer.command('health', async (ctx) => {
    const uid = ctx.from?.id;
    if (!Number.isFinite(uid)) return;
    if (await isOptedOut(uid)) return ctx.reply('Health tracking is disabled for you. Use /health_optin to enable.');
    const summary = await getUserSummary(uid);
    if (!summary) return ctx.reply('No activity yet. Come back after some usage.');
    const tips = buildSuggestions(summary);
    const pTips = buildPersonalitySuggestions(summary.profile || {});
    const styleTraits = buildStyleTraits(summary);
    const health = computeHealthScore(summary);
    const discipline = await computeDisciplineScore(uid, ctx.chat?.id);
    const catH = categorize(health.score);
    const catD = categorize(discipline.score);
    const ai = await aiAssessment(summary, discipline);
    const aiStyle = await aiPersonalityAssessment(summary);
    const hourFmt = (h) => `${String(h).padStart(2, '0')}:00`;
    const lines = [
      `<b>Your Health Routine Snapshot</b>`,
      `Last seen: <code>${esc(summary.last_seen || '-')}</code>`,
      `7-day activity: <b>${summary.week_count}</b> · 30-day: <b>${summary.month_count}</b> · Streak: <b>${summary.streak_days}d</b>`,
      `Top hours: ${summary.top_hours.length ? summary.top_hours.map(hourFmt).join(', ') : '-'}`,
      `Avg message length: <b>${summary.avg_message_len}</b> chars`,
      `Profile: name changes <b>${summary?.profile?.changes?.name || 0}</b>, username changes <b>${summary?.profile?.changes?.username || 0}</b>, bio changes <b>${summary?.profile?.changes?.bio || 0}</b>`,
      `Health score: <b>${health.score}</b> (${catH.label}) · Discipline score: <b>${discipline.score}</b> (${catD.label})`,
      styleTraits.length ? `Style: ${esc(styleTraits.join(', '))}` : undefined,
      '',
      '<b>Suggestions</b>',
      ...(aiStyle ? [esc(aiStyle)] : []),
      ...(ai ? [esc(ai)] : tips.concat(pTips.slice(0, 3)).map(t => `• ${esc(t)}`)),
    ];
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  composer.command('health_user', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const tokens = ctx.message.text.trim().split(/\s+/, 2);
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    if (!Number.isFinite(targetId) && tokens[1]) targetId = Number(tokens[1]);
    if (!Number.isFinite(targetId)) return ctx.reply('Usage: reply with /health_user or /health_user <user_id>');
    if (await isOptedOut(targetId)) return ctx.reply('User has opted out of health tracking.');
    const summary = await getUserSummary(targetId);
    if (!summary) return ctx.reply('No activity recorded for that user.');
    const tips = buildSuggestions(summary);
    const pTips = buildPersonalitySuggestions(summary.profile || {});
    const styleTraits = buildStyleTraits(summary);
    const health = computeHealthScore(summary);
    const discipline = await computeDisciplineScore(targetId, ctx.chat?.id);
    const catH = categorize(health.score);
    const catD = categorize(discipline.score);
    const ai = await aiAssessment(summary, discipline);
    const aiStyle = await aiPersonalityAssessment(summary);
    const hourFmt = (h) => `${String(h).padStart(2, '0')}:00`;
    const lines = [
      `<b>User ${targetId} — Health Snapshot</b>`,
      `Last seen: <code>${esc(summary.last_seen || '-')}</code>`,
      `7-day: <b>${summary.week_count}</b> · 30-day: <b>${summary.month_count}</b> · Streak: <b>${summary.streak_days}d</b>`,
      `Top hours: ${summary.top_hours.length ? summary.top_hours.map(hourFmt).join(', ') : '-'}`,
      `Avg msg length: <b>${summary.avg_message_len}</b> chars`,
      `Profile: name changes <b>${summary?.profile?.changes?.name || 0}</b>, username changes <b>${summary?.profile?.changes?.username || 0}</b>, bio changes <b>${summary?.profile?.changes?.bio || 0}</b>`,
      `Health score: <b>${health.score}</b> (${catH.label}) · Discipline score: <b>${discipline.score}</b> (${catD.label})`,
      styleTraits.length ? `Style: ${esc(styleTraits.join(', '))}` : undefined,
      '',
      '<b>Suggestions</b>',
      ...(aiStyle ? [esc(aiStyle)] : []),
      ...(ai ? [esc(ai)] : tips.concat(pTips.slice(0, 3)).map(t => `• ${esc(t)}`)),
    ];
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  composer.command('health_optout', async (ctx) => {
    const uid = ctx.from?.id; if (!Number.isFinite(uid)) return;
    await setOptOut(uid, true);
    return ctx.reply('Health tracking disabled for you. Use /health_optin to re-enable.');
  });

  composer.command('health_optin', async (ctx) => {
    const uid = ctx.from?.id; if (!Number.isFinite(uid)) return;
    await setOptOut(uid, false);
    return ctx.reply('Health tracking enabled. Use /health for your snapshot.');
  });

  // Top 10 unhealthy in current chat (admins/owner only). Requires Supabase.
  composer.command('health_top_unhealthy', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const chatId = ctx.chat?.id;
    if (!Number.isFinite(chatId)) return;
    const sb = getSupabase();
    if (!sb) return ctx.reply('This command requires Supabase (SUPABASE_URL/KEY).');
    try {
      const { data: pres } = await sb
        .from('user_chat_presence')
        .select('user_id')
        .eq('chat_id', String(chatId))
        .limit(500);
      const ids = Array.from(new Set((pres || []).map(r => String(r.user_id))));
      if (!ids.length) return ctx.reply('No presence data for this chat yet.');
      const { data: rows } = await sb
        .from('health_profiles')
        .select('user_id,data')
        .in('user_id', ids);
      const items = [];
      for (const r of rows || []) {
        const uid = Number(r.user_id);
        const doc = r.data || {};
        // Build minimal summary for health score
        const daily = doc.daily_counts || {};
        const now = new Date();
        const todayKey = (d) => {
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(d.getUTCDate()).padStart(2, '0');
          return `${y}-${m}-${dd}`;
        };
        let w7 = 0, w30 = 0, streak = 0;
        for (let i = 0; i < 30; i++) {
          const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
          const key = todayKey(d);
          const c = daily[key] || 0;
          if (i < 7) w7 += c;
          w30 += c;
          if (c > 0 && streak === i) streak += 1;
        }
        const act = Array.isArray(doc.activity_by_hour) ? doc.activity_by_hour : Array.from({length:24},()=>0);
        const hours = act.map((v, h) => ({ h, v })).sort((a, b) => (b.v - a.v));
        const topHours = hours.slice(0, 3).filter(x => (x.v || 0) > 0).map(x => x.h);
        const summary = {
          week_count: w7,
          month_count: w30,
          streak_days: streak,
          top_hours: topHours,
          avg_message_len: doc.messages ? Math.round((doc.chars_sum || 0) / doc.messages) : (doc.avg_message_len || 0),
          sessions: { total: (doc.sessions_by_hour || []).reduce((a,b)=>a+(b||0),0), by_hour: doc.sessions_by_hour || [], late_total: (doc.sessions_by_hour||[]).reduce((acc,v,h)=>acc+((h<=5||h>=22)?(v||0):0),0) },
          comms: doc.comms || {},
        };
        const h = computeHealthScore(summary);
        const dsc = await computeDisciplineScore(uid, chatId);
        const severity = (100 - h.score) + (100 - dsc.score);
        items.push({ userId: uid, severity, health: h.score, discipline: dsc.score });
      }
      items.sort((a, b) => (b.severity - a.severity));
      const top = items.slice(0, 10);
      if (!top.length) return ctx.reply('No candidates found.');
      const lines = top.map((it, i) => `${i + 1}. <code>${it.userId}</code> — sev: <b>${Math.round(it.severity)}</b>, health: ${it.health}, discipline: ${it.discipline}`);
      return ctx.reply([`<b>Top ${top.length} unhealthy users in this chat</b>`, ...lines].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      return ctx.reply(`Failed to compute: ${e?.message || e}`);
    }
  });

  // Top 10 unhealthy globally (admins/owner only). Requires Supabase.
  composer.command('health_top_unhealthy_global', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const sb = getSupabase();
    if (!sb) return ctx.reply('This command requires Supabase (SUPABASE_URL/KEY).');
    try {
      // Limit to a reasonable number to avoid heavy scans
      const { data: rows } = await sb
        .from('health_profiles')
        .select('user_id,data')
        .limit(500);
      const items = [];
      for (const r of rows || []) {
        const uid = Number(r.user_id);
        const doc = r.data || {};
        const daily = doc.daily_counts || {};
        const now = new Date();
        const todayKey = (d) => {
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(d.getUTCDate()).padStart(2, '0');
          return `${y}-${m}-${dd}`;
        };
        let w7 = 0, w30 = 0, streak = 0;
        for (let i = 0; i < 30; i++) {
          const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
          const key = todayKey(d);
          const c = daily[key] || 0;
          if (i < 7) w7 += c;
          w30 += c;
          if (c > 0 && streak === i) streak += 1;
        }
        const act = Array.isArray(doc.activity_by_hour) ? doc.activity_by_hour : Array.from({length:24},()=>0);
        const hours = act.map((v, h) => ({ h, v })).sort((a, b) => (b.v - a.v));
        const topHours = hours.slice(0, 3).filter(x => (x.v || 0) > 0).map(x => x.h);
        const summary = {
          week_count: w7,
          month_count: w30,
          streak_days: streak,
          top_hours: topHours,
          avg_message_len: doc.messages ? Math.round((doc.chars_sum || 0) / doc.messages) : (doc.avg_message_len || 0),
          sessions: { total: (doc.sessions_by_hour || []).reduce((a,b)=>a+(b||0),0), by_hour: doc.sessions_by_hour || [], late_total: (doc.sessions_by_hour||[]).reduce((acc,v,h)=>acc+((h<=5||h>=22)?(v||0):0),0) },
          comms: doc.comms || {},
        };
        const h = computeHealthScore(summary);
        // Discipline score without chatId: global violations perspective
        const dsc = await computeDisciplineScore(uid, null);
        const severity = (100 - h.score) + (100 - dsc.score);
        items.push({ userId: uid, severity, health: h.score, discipline: dsc.score });
      }
      items.sort((a, b) => (b.severity - a.severity));
      const top = items.slice(0, 10);
      if (!top.length) return ctx.reply('No candidates found.');
      const lines = top.map((it, i) => `${i + 1}. <code>${it.userId}</code> — sev: <b>${Math.round(it.severity)}</b>, health: ${it.health}, discipline: ${it.discipline}`);
      return ctx.reply([`<b>Top ${top.length} unhealthy users (global)</b>`, ...lines].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (e) {
      return ctx.reply(`Failed to compute: ${e?.message || e}`);
    }
  });

  return composer;
}
