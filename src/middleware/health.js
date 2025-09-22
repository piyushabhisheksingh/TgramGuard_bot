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

const IST_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatIstTimestamp(iso) {
  if (!iso) return '-';
  try {
    const dt = typeof iso === 'string' ? new Date(iso) : iso;
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '-';
    return `${IST_FORMATTER.format(dt)} IST`;
  } catch {
    return '-';
  }
}

function avg(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + Number(v || 0), 0) / arr.length;
}

function std(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const mean = avg(arr);
  if (!Number.isFinite(mean)) return 0;
  const variance = arr.reduce((acc, v) => {
    const diff = Number(v || 0) - mean;
    return acc + diff * diff;
  }, 0) / arr.length;
  return Math.sqrt(Math.max(0, variance));
}

function mentionHTML(user) {
  const id = user?.id;
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'user';
  if (!Number.isFinite(id)) return esc(name);
  return `<a href="tg://user?id=${id}">${esc(name)}</a>`;
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
    if (s.bot_admin_ids.includes(userId)) return true;
  } catch {}
  // Also allow chat administrators/owner to use admin commands
  try {
    const chatId = ctx.chat?.id || ctx.message?.chat?.id || ctx.callbackQuery?.message?.chat?.id;
    if (Number.isFinite(chatId)) {
      const member = await ctx.api.getChatMember(chatId, userId);
      const status = member?.status;
      if (status === 'administrator' || status === 'creator') return true;
    }
  } catch {}
  return false;
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

// Build targeted suggestions based on health/discipline scores and style traits
function buildScoreBasedTips(summary, health, discipline, catH, catD, styleTraits = []) {
  const tips = [];
  const seen = new Set();
  const add = (tip) => {
    if (!tip) return;
    const text = tip.trim();
    if (!text) return;
    if (seen.has(text)) return;
    seen.add(text);
    tips.push(text);
  };

  // Health-oriented suggestions by category
  if (health.score < 40) {
    add('Reset sleep rhythm: fix a wind-down by 10:30 PM and keep screens away 60–90 minutes before bed.');
    add('Use pranayama and 5 minutes of meditation before sleep to calm the nervous system.');
    add('Create quiet chat hours after 11 PM so your mind can recover.');
  } else if (health.score < 55) {
    add('Stabilise your day with a consistent wake time, micro‑breaks each hour, and steady hydration.');
    add('Add light stretching or Surya Namaskars in the evening to release tension.');
  } else if (health.score < 70) {
    add('You are close to balanced—add short movement breaks and batch notifications to avoid constant context switching.');
  } else if (health.score < 85) {
    add('Nice balance—lock one weekly device‑free block to keep recovery strong.');
  } else {
    add('Excellent balance—maintain your sattvic routine and mindful breaks.');
  }

  // Discipline-oriented suggestions by category
  if (discipline.score < 55) {
    add('Calm your tone: drop all‑caps, reduce exclamation bursts, and keep sentences clear.');
    add('Cut back on link drops—share context first, then a single resource.');
    add('Practice ahimsa and satya: pause, breathe, then respond with respectful words.');
  } else if (discipline.score < 70) {
    add('Polish your tone with shorter messages and fewer exclamation points.');
  } else if (discipline.score >= 85) {
    add('Great communication discipline—keep it steady.');
  }

  const factors = health?.factors || {};

  const sleepMeta = factors.sleepBalance || {};
  if ((sleepMeta.lateRatio ?? 0) >= 0.3) add('Set a digital sunset—mute chats after 10:30 PM and leave devices outside the bedroom.');
  else if ((sleepMeta.lateRatio ?? 0) > 0 && (sleepMeta.lateRatio ?? 0) <= 0.08 && health.score >= 60) add('Keep protecting your sleep window; it is keeping your energy high.');

  const restMeta = factors.restBalance || {};
  if ((restMeta.restDays7 ?? 0) <= 1 && (restMeta.activeDays7 ?? 0) >= 5) add('Block one full offline day this week—treat it as recovery sadhana.');
  if ((restMeta.activeDays30 ?? 0) >= 24) add('Plan intentional pauses every few days; even half-day retreats help your mind reset.');
  if ((restMeta.restDays7 ?? 0) >= 3 && health.score >= 55) add('Great rest cadence—use one rest day for a walk, sunlight, or gentle yoga.');

  const loadMeta = factors.activityLoad || {};
  if ((loadMeta.weekCount || 0) > 650) add('Schedule deep-focus slots with chats closed and delegate routine updates to avoid overload.');
  else if ((loadMeta.weekCount || 0) > 0 && (loadMeta.weekCount || 0) < 80) add('Engage intentionally 2–3 times a week so conversations stay meaningful, not scattered.');

  const rhythmMeta = factors.dailyRhythm || {};
  if ((rhythmMeta.cv || 0) >= 0.9) add('Anchor key conversations to fixed slots; keep evenings lighter so energy stays level.');
  else if ((rhythmMeta.cv || 0) <= 0.35 && health.score >= 60) add('Your daily rhythm is stable—keep using check-in blocks rather than constant monitoring.');

  const weekendMeta = factors.weekendRest || {};
  if ((weekendMeta.weekendRatio || 0) >= 0.4) add('Protect weekends: set auto-replies or wrap up threads by Friday night.');
  if ((weekendMeta.weekendRatio || 0) <= 0.1 && (health.score >= 55 || discipline.score >= 55)) add('Lovely weekend downtime—keep one optional offline ritual like nature walks or a hobby.');

  const burstMeta = factors.burstBalance || {};
  if ((burstMeta.peakHourRatio || 0) >= 0.28) add('Spread replies across the day; try 2–3 short check-in windows instead of one big binge.');
  else if ((burstMeta.peakHourRatio || 0) <= 0.16 && (burstMeta.totalActivity || 0) >= 40) add('Nice pacing—continue batching responses so focus blocks remain clear.');

  const intensityMeta = factors.intensity || {};
  if ((intensityMeta.avgPerActiveDay || 0) > 160) add('Batch replies and take a 3-minute stretch after every ~30 messages to preserve stamina.');

  const dayMeta = factors.daytimeBalance || {};
  if ((dayMeta.daytimeRatio || 0) > 0 && (dayMeta.daytimeRatio || 0) < 0.5) add('Shift more conversations to daylight; put a hard stop on chats post 10 PM.');

  const lengthMeta = factors.messageLength || {};
  if ((lengthMeta.avgLen || 0) > 320) add('Break long updates into short bullets; it saves cognitive load for you and readers.');

  const toneMeta = factors.communicationTone || {};
  if ((toneMeta.uppercaseRatio || 0) >= 0.15) add('Swap ALL CAPS for calm sentences—people mirror your energy.');
  if ((toneMeta.exclamPerMsg || 0) >= 1) add('Limit exclamation bursts; one well-placed “!” is plenty.');
  if ((toneMeta.toxicRatio || 0) >= 0.08) add('Choose mindful words—count to five before replying when annoyed.');
  if ((toneMeta.politeRatio || 0) >= 0.08 && discipline.score >= 60) add('Keep sprinkling gratitude; your polite tone uplifts the group.');

  // Style-specific nudges
  const st = new Set(styleTraits || []);
  if (st.has('shouty')) add('Use normal case—ALL CAPS can feel intense to others.');
  if (st.has('promotional')) add('Limit links/self-promo; lead with value and context.');
  if (st.has('verbose')) add('Aim for shorter messages or bullet points to avoid fatigue.');
  if (st.has('excitable')) add('Trim exclamation marks; a calmer tone improves clarity.');
  if (st.has('concise')) add('Your concise style is effective—keep it up.');
  if (st.has('emotive')) add('Balance emojis with clear text so meaning stays sharp.');
  if (st.has('inquisitive')) add('Great curiosity—channel it into thoughtful questions that move conversations forward.');

  return tips;
}

export function healthMiddleware() {
  const composer = new Composer();
  const adviseCooldownMs = Number(process.env.HEALTH_ADVISE_COOLDOWN_MS || 24 * 60 * 60 * 1000); // default 24h
  const lastAdvice = new Map(); // userId -> ts

  // Activity tracking across common update types
  composer.on('message', async (ctx, next) => {
    try {
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
          const styleTraits = buildStyleTraits(summary);
          const scoreTips = buildScoreBasedTips(summary, health, discipline, catH, catD, styleTraits);
          const pTips = buildPersonalitySuggestions(summary.profile || {});
          const highlights = (health.highlights || []).slice(0, 2);
          const weekendRatio = Number(summary?.daily?.weekend_ratio ?? NaN);
          const std7 = Number(summary?.daily?.last7?.std ?? NaN);
          const pacingLine = Number.isFinite(weekendRatio) || Number.isFinite(std7)
            ? `<b>Pacing:</b> ${Number.isFinite(weekendRatio) ? `weekend <b>${Math.round(weekendRatio * 100)}%</b>` : ''}${Number.isFinite(weekendRatio) && Number.isFinite(std7) ? ' · ' : ''}${Number.isFinite(std7) ? `7d std <b>${Math.round(std7)}</b>` : ''}`
            : undefined;
          const msg = [
            `🧘 ${mentionHTML(ctx.from)} — <b>Gentle Reminder</b>`,
            `<b>Scores:</b> Health <b>${health.score}</b> (${catH.label}) · Discipline <b>${discipline.score}</b> (${catD.label})`,
            highlights.length ? `<b>Focus:</b> ${esc(highlights.join('; '))}` : undefined,
            pacingLine,
            aiStyle ? `<b>Style:</b> ${esc(aiStyle)}` : undefined,
            ai ? `<b>Tips:</b> ${esc(ai)}` : `<b>Tips:</b>\n• ${esc(scoreTips.concat(pTips.slice(0, 2)).slice(0, 5).join('\n• '))}`,
            '<i>Use /health for a full snapshot or /health_optout to disable.</i>',
          ].filter(Boolean).join('\n');
          try { await ctx.reply(msg, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch {}
        } catch {}
      }
    } finally {
      await next();
    }
  });

  composer.on('edited_message', async (ctx, next) => {
    try {
      const userId = ctx.from?.id; const chatId = ctx.chat?.id;
      const text = ctx.editedMessage?.text || ctx.editedMessage?.caption || '';
      const len = text.length;
      await recordActivity({ userId, chatId, type: 'edit', textLen: len, when: new Date(), content: text });
    } finally {
      await next();
    }
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
    const styleTraits = buildStyleTraits(summary);
    const pTips = buildPersonalitySuggestions(summary.profile || {});
    const health = computeHealthScore(summary);
    const discipline = await computeDisciplineScore(uid, ctx.chat?.id);
    const catH = categorize(health.score);
    const catD = categorize(discipline.score);
    const ai = await aiAssessment(summary, discipline);
    const aiStyle = await aiPersonalityAssessment(summary);
    const scoreTips = buildScoreBasedTips(summary, health, discipline, catH, catD, styleTraits);
    const highlights = (health.highlights || []).slice(0, 3);
    const weekendRatio = Number(summary?.daily?.weekend_ratio ?? NaN);
    const std7 = Number(summary?.daily?.last7?.std ?? NaN);
    const pacingLine = Number.isFinite(weekendRatio) || Number.isFinite(std7)
      ? `<b>Pacing:</b> ${Number.isFinite(weekendRatio) ? `weekend <b>${Math.round(weekendRatio * 100)}%</b>` : ''}${Number.isFinite(weekendRatio) && Number.isFinite(std7) ? ' · ' : ''}${Number.isFinite(std7) ? `7d std <b>${Math.round(std7)}</b>` : ''}`
      : undefined;
    const hourFmt = (h) => `${String(h).padStart(2, '0')}:00`;
    const lines = [
      `🧭 <b>Your Health Snapshot</b> — ${mentionHTML(ctx.from)}`,
      `<b>Last seen:</b> <code>${esc(formatIstTimestamp(summary.last_seen))}</code>`,
      `<b>Activity:</b> 7d <b>${summary.week_count}</b> · 30d <b>${summary.month_count}</b> · Streak <b>${summary.streak_days}d</b>`,
      `<b>Top hours:</b> ${summary.top_hours.length ? summary.top_hours.map(hourFmt).join(', ') : '-'}`,
      `<b>Avg length:</b> <b>${summary.avg_message_len}</b> chars` ,
      `<b>Profile changes:</b> name <b>${summary?.profile?.changes?.name || 0}</b> · username <b>${summary?.profile?.changes?.username || 0}</b> · bio <b>${summary?.profile?.changes?.bio || 0}</b>`,
      `<b>Scores:</b> Health <b>${health.score}</b> (${catH.label}) · Discipline <b>${discipline.score}</b> (${catD.label})`,
      highlights.length ? `<b>Drivers:</b> ${esc(highlights.join('; '))}` : undefined,
      pacingLine,
      styleTraits.length ? `<b>Style:</b> ${esc(styleTraits.join(', '))}` : undefined,
      '',
      '✅ <b>Suggestions</b>',
      ...(aiStyle ? [`<i>${esc(aiStyle)}</i>`] : []),
      ...(ai ? [`<i>${esc(ai)}</i>`] : scoreTips.concat(pTips.slice(0, 3)).map(t => `• ${esc(t)}`)),
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
    const styleTraits = buildStyleTraits(summary);
    const pTips = buildPersonalitySuggestions(summary.profile || {});
    const health = computeHealthScore(summary);
    const discipline = await computeDisciplineScore(targetId, ctx.chat?.id);
    const catH = categorize(health.score);
    const catD = categorize(discipline.score);
    const ai = await aiAssessment(summary, discipline);
    const aiStyle = await aiPersonalityAssessment(summary);
    const scoreTips = buildScoreBasedTips(summary, health, discipline, catH, catD, styleTraits);
    const highlights = (health.highlights || []).slice(0, 3);
    const weekendRatio = Number(summary?.daily?.weekend_ratio ?? NaN);
    const std7 = Number(summary?.daily?.last7?.std ?? NaN);
    const pacingLine = Number.isFinite(weekendRatio) || Number.isFinite(std7)
      ? `<b>Pacing:</b> ${Number.isFinite(weekendRatio) ? `weekend <b>${Math.round(weekendRatio * 100)}%</b>` : ''}${Number.isFinite(weekendRatio) && Number.isFinite(std7) ? ' · ' : ''}${Number.isFinite(std7) ? `7d std <b>${Math.round(std7)}</b>` : ''}`
      : undefined;
    const hourFmt = (h) => `${String(h).padStart(2, '0')}:00`;
    const lines = [
      `🧭 <b>Health Snapshot</b> — ${mentionHTML(replyFrom || { id: targetId, first_name: 'User' })}`,
      `<b>Last seen:</b> <code>${esc(formatIstTimestamp(summary.last_seen))}</code>`,
      `<b>Activity:</b> 7d <b>${summary.week_count}</b> · 30d <b>${summary.month_count}</b> · Streak <b>${summary.streak_days}d</b>`,
      `<b>Top hours:</b> ${summary.top_hours.length ? summary.top_hours.map(hourFmt).join(', ') : '-'}`,
      `<b>Avg length:</b> <b>${summary.avg_message_len}</b> chars`,
      `<b>Profile changes:</b> name <b>${summary?.profile?.changes?.name || 0}</b> · username <b>${summary?.profile?.changes?.username || 0}</b> · bio <b>${summary?.profile?.changes?.bio || 0}</b>`,
      `<b>Scores:</b> Health <b>${health.score}</b> (${catH.label}) · Discipline <b>${discipline.score}</b> (${catD.label})`,
      highlights.length ? `<b>Drivers:</b> ${esc(highlights.join('; '))}` : undefined,
      pacingLine,
      styleTraits.length ? `<b>Style:</b> ${esc(styleTraits.join(', '))}` : undefined,
      '',
      '✅ <b>Suggestions</b>',
      ...(aiStyle ? [`<i>${esc(aiStyle)}</i>`] : []),
      ...(ai ? [`<i>${esc(ai)}</i>`] : scoreTips.concat(pTips.slice(0, 3)).map(t => `• ${esc(t)}`)),
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
        let active7 = 0, active30 = 0, longestBreak = 0, currentBreak = 0;
        const last7Counts = [];
        const last30Counts = [];
        let weekendTotal = 0;
        let weekdayTotal = 0;
        let weekendActiveDays = 0;
        let weekdayActiveDays = 0;
        for (let i = 0; i < 30; i++) {
          const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
          const key = todayKey(d);
          const c = daily[key] || 0;
          if (i < 7) w7 += c;
          w30 += c;
          if (c > 0 && streak === i) streak += 1;
          if (c > 0) {
            if (i < 7) active7 += 1;
            active30 += 1;
            currentBreak = 0;
          } else {
            currentBreak += 1;
            if (currentBreak > longestBreak) longestBreak = currentBreak;
          }
          if (i < 7) last7Counts.push(c);
          last30Counts.push(c);
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) {
            weekendTotal += c;
            if (c > 0) weekendActiveDays += 1;
          } else {
            weekdayTotal += c;
            if (c > 0) weekdayActiveDays += 1;
          }
        }
        const act = Array.isArray(doc.activity_by_hour) ? doc.activity_by_hour : Array.from({length:24},()=>0);
        const hours = act.map((v, h) => ({ h, v })).sort((a, b) => (b.v - a.v));
        const topHours = hours.slice(0, 3).filter(x => (x.v || 0) > 0).map(x => x.h);
        const dayStats7 = {
          average: Number(avg(last7Counts).toFixed(2)),
          std: Number(std(last7Counts).toFixed(2)),
          max: Math.max(0, ...last7Counts),
          min: last7Counts.length ? Math.min(...last7Counts) : 0,
          zeros: last7Counts.filter((v) => (v || 0) === 0).length,
        };
        const dayStats30 = {
          average: Number(avg(last30Counts).toFixed(2)),
          std: Number(std(last30Counts).toFixed(2)),
          max: Math.max(0, ...last30Counts),
          min: last30Counts.length ? Math.min(...last30Counts) : 0,
          zeros: last30Counts.filter((v) => (v || 0) === 0).length,
        };
        const weekendRatio = w30 > 0 ? Number((weekendTotal / w30).toFixed(3)) : 0;
        const summary = {
          week_count: w7,
          month_count: w30,
          streak_days: streak,
          active_days: { last7: active7, last30: active30 },
          longest_break_days: longestBreak,
          top_hours: topHours,
          activity_by_hour: act,
          avg_message_len: doc.messages ? Math.round((doc.chars_sum || 0) / doc.messages) : (doc.avg_message_len || 0),
          sessions: { total: (doc.sessions_by_hour || []).reduce((a,b)=>a+(b||0),0), by_hour: doc.sessions_by_hour || [], late_total: (doc.sessions_by_hour||[]).reduce((acc,v,h)=>acc+((h<=5||h>=22)?(v||0):0),0) },
          comms: doc.comms || {},
          totals: { messages: doc.messages || 0, events: doc.total_events || 0 },
          daily: {
            last7: dayStats7,
            last30: dayStats30,
            weekend_ratio: weekendRatio,
            weekend_activity: weekendTotal,
            weekday_activity: weekdayTotal,
            weekend_active_days: weekendActiveDays,
            weekday_active_days: weekdayActiveDays,
          },
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
        let active7 = 0, active30 = 0, longestBreak = 0, currentBreak = 0;
        const last7Counts = [];
        const last30Counts = [];
        let weekendTotal = 0;
        let weekdayTotal = 0;
        let weekendActiveDays = 0;
        let weekdayActiveDays = 0;
        for (let i = 0; i < 30; i++) {
          const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
          const key = todayKey(d);
          const c = daily[key] || 0;
          if (i < 7) w7 += c;
          w30 += c;
          if (c > 0 && streak === i) streak += 1;
          if (c > 0) {
            if (i < 7) active7 += 1;
            active30 += 1;
            currentBreak = 0;
          } else {
            currentBreak += 1;
            if (currentBreak > longestBreak) longestBreak = currentBreak;
          }
          if (i < 7) last7Counts.push(c);
          last30Counts.push(c);
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) {
            weekendTotal += c;
            if (c > 0) weekendActiveDays += 1;
          } else {
            weekdayTotal += c;
            if (c > 0) weekdayActiveDays += 1;
          }
        }
        const act = Array.isArray(doc.activity_by_hour) ? doc.activity_by_hour : Array.from({length:24},()=>0);
        const hours = act.map((v, h) => ({ h, v })).sort((a, b) => (b.v - a.v));
        const topHours = hours.slice(0, 3).filter(x => (x.v || 0) > 0).map(x => x.h);
        const dayStats7 = {
          average: Number(avg(last7Counts).toFixed(2)),
          std: Number(std(last7Counts).toFixed(2)),
          max: Math.max(0, ...last7Counts),
          min: last7Counts.length ? Math.min(...last7Counts) : 0,
          zeros: last7Counts.filter((v) => (v || 0) === 0).length,
        };
        const dayStats30 = {
          average: Number(avg(last30Counts).toFixed(2)),
          std: Number(std(last30Counts).toFixed(2)),
          max: Math.max(0, ...last30Counts),
          min: last30Counts.length ? Math.min(...last30Counts) : 0,
          zeros: last30Counts.filter((v) => (v || 0) === 0).length,
        };
        const weekendRatio = w30 > 0 ? Number((weekendTotal / w30).toFixed(3)) : 0;
        const summary = {
          week_count: w7,
          month_count: w30,
          streak_days: streak,
          active_days: { last7: active7, last30: active30 },
          longest_break_days: longestBreak,
          top_hours: topHours,
          activity_by_hour: act,
          avg_message_len: doc.messages ? Math.round((doc.chars_sum || 0) / doc.messages) : (doc.avg_message_len || 0),
          sessions: { total: (doc.sessions_by_hour || []).reduce((a,b)=>a+(b||0),0), by_hour: doc.sessions_by_hour || [], late_total: (doc.sessions_by_hour||[]).reduce((acc,v,h)=>acc+((h<=5||h>=22)?(v||0):0),0) },
          comms: doc.comms || {},
          totals: { messages: doc.messages || 0, events: doc.total_events || 0 },
          daily: {
            last7: dayStats7,
            last30: dayStats30,
            weekend_ratio: weekendRatio,
            weekend_activity: weekendTotal,
            weekday_activity: weekdayTotal,
            weekend_active_days: weekendActiveDays,
            weekday_active_days: weekdayActiveDays,
          },
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
