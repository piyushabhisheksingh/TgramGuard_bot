import { Composer } from 'grammy';
import { logAction, getBotStats, getGroupStats, getUserGroupCount, getUserGroupLinks } from '../logger.js';
import { RULE_KEYS, DEFAULT_RULES, DEFAULT_LIMITS } from '../rules.js';
import {
  addBotAdmin,
  removeBotAdmin,
  setGlobalRule,
  setChatRule,
  getSettings,
  getEffectiveRules,
  setGlobalMaxLenLimit,
  setChatMaxLenLimit,
  getEffectiveMaxLen,
  addChatWhitelistUser,
  removeChatWhitelistUser,
  getChatWhitelist,
  getChatRules,
  getChatMaxLen,
} from '../store/settings.js';
import { consumeReview } from '../logger.js';
import { addSafeTerms, addExplicitTerms } from '../filters/customTerms.js';
import { addExplicitRuntime } from '../filters.js';

// Utilities shared with security middleware (re-implemented minimal)
async function isChatAdminWithBan(ctx, userId) {
  const chatId = ctx.chat?.id;
  if (!chatId || !userId) return false;
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (!member) return false;
    if (member.status === 'creator') return true;
    if (member.status === 'administrator') {
      return Boolean(member.can_restrict_members ?? true);
    }
    return false;
  } catch (_) {
    return false;
  }
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
  } catch {
    return false;
  }
}

function formatRulesStatus(globalRules, chatRules, effective, limits) {
  const lines = [];
  lines.push('Rules status:');
  for (const k of RULE_KEYS) {
    const g = globalRules[k] ? 'ON' : 'off';
    const c = chatRules?.[k];
    const cStr = c === undefined ? '-' : c ? 'ON' : 'off';
    const e = effective[k] ? 'ON' : 'off';
    lines.push(`- ${k}: effective ${e} (global ${g}, chat ${cStr})`);
  }
  // Limits
  lines.push('Limits:');
  lines.push(
    `- max_len: effective ${limits.effectiveMax} (global ${limits.globalMax}, chat ${limits.chatMax ?? '-'})`
  );
  return lines.join('\n');
}

export function settingsMiddleware() {
  const composer = new Composer();

  // Small helpers for pretty HTML formatting
  const esc = (s = '') =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  const formatKV = (obj = {}) =>
    Object.entries(obj)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .map(([k, v]) => `• <code>${esc(k)}</code>: <b>${v}</b>`) // bullet lines
      .join('\n');

  // -------- Bot/Group stats builders & keyboards --------
  function botStatsKeyboard(format) {
    return {
      inline_keyboard: [[
        { text: `Format: ${format === 'pretty' ? 'Pretty ✅' : 'Pretty'}`, callback_data: `bstats:pretty` },
        { text: `Format: ${format === 'compact' ? 'Compact ✅' : 'Compact'}`, callback_data: `bstats:compact` },
      ]],
    };
  }

  async function buildBotStatsMessage(format = 'pretty') {
    const mod = await import('../logger.js');
    const daily = await mod.getBotStatsPeriod(1);
    const weekly = await mod.getBotStatsPeriod(7);
    if (format === 'compact') {
      const topV = Object.entries(weekly.byViolation).sort((a,b)=> (b[1]||0)-(a[1]||0)).slice(0,3)
        .map(([k,v])=> `${esc(k)}=${v}`).join(', ');
      const topA = Object.entries(weekly.byAction).sort((a,b)=> (b[1]||0)-(a[1]||0)).slice(0,2)
        .map(([k,v])=> `${esc(k)}=${v}`).join(', ');
      return [
        '<b>📊 Bot</b>',
        `today: <b>${daily.total}</b>`,
        `7d: <b>${weekly.total}</b>`,
        topV ? `topV(7d): <code>${topV}</code>` : '',
        topA ? `topA(7d): <code>${topA}</code>` : '',
      ].filter(Boolean).join(' | ');
    }
    const html = [
      `<b>📊 Bot Stats</b>`,
      '',
      `<b>🗓 Today</b> — Total: <b>${daily.total}</b>`,
      formatKV(daily.byViolation) ? `• <i>By violation</i>\n${formatKV(daily.byViolation)}` : '',
      formatKV(daily.byAction) ? `• <i>By action</i>\n${formatKV(daily.byAction)}` : '',
      '',
      `<b>🗓 Last 7 Days</b> — Total: <b>${weekly.total}</b>`,
      formatKV(weekly.byViolation) ? `• <i>By violation</i>\n${formatKV(weekly.byViolation)}` : '',
      formatKV(weekly.byAction) ? `• <i>By action</i>\n${formatKV(weekly.byAction)}` : '',
    ].filter(Boolean).join('\n');
    return html;
  }

  function groupStatsKeyboard(format) {
    return {
      inline_keyboard: [[
        { text: `Format: ${format === 'pretty' ? 'Pretty ✅' : 'Pretty'}`, callback_data: `gstats:pretty` },
        { text: `Format: ${format === 'compact' ? 'Compact ✅' : 'Compact'}`, callback_data: `gstats:compact` },
      ]],
    };
  }

  async function buildGroupStatsMessage(ctx, format = 'pretty') {
    const mod = await import('../logger.js');
    const daily = await mod.getGroupStatsPeriod(ctx.chat.id, 1);
    const weekly = await mod.getGroupStatsPeriod(ctx.chat.id, 7);
    const title = esc(ctx.chat.title || ctx.chat.id);
    if (format === 'compact') {
      const topV = Object.entries(weekly.byViolation).sort((a,b)=> (b[1]||0)-(a[1]||0)).slice(0,3)
        .map(([k,v])=> `${esc(k)}=${v}`).join(', ');
      return [
        `👥 <b>${title}</b>`,
        `today: <b>${daily.total}</b>`,
        `7d: <b>${weekly.total}</b>`,
        topV ? `topV(7d): <code>${topV}</code>` : '',
      ].filter(Boolean).join(' | ');
    }
    const html = [
      `<b>👥 Group Stats</b> — ${title}`,
      '',
      `<b>🗓 Today</b> — Total: <b>${daily.total}</b>`,
      formatKV(daily.byViolation) ? `• <i>By violation</i>\n${formatKV(daily.byViolation)}` : '',
      formatKV(daily.byAction) ? `• <i>By action</i>\n${formatKV(daily.byAction)}` : '',
      '',
      `<b>🗓 Last 7 Days</b> — Total: <b>${weekly.total}</b>`,
      formatKV(weekly.byViolation) ? `• <i>By violation</i>\n${formatKV(weekly.byViolation)}` : '',
      formatKV(weekly.byAction) ? `• <i>By action</i>\n${formatKV(weekly.byAction)}` : '',
    ].filter(Boolean).join('\n');
    return html;
  }

  async function fetchUserStats(targetId, chatIdOrNull) {
    const mod = await import('../logger.js');
    const daily = await mod.getUserStatsPeriod(targetId, chatIdOrNull, 1);
    const weekly = await mod.getUserStatsPeriod(targetId, chatIdOrNull, 7);
    const lifetime = await mod.getUserLifetimeStats(targetId, chatIdOrNull);
    const dailyAvg = weekly.total / 7;
    const weekly28 = await mod.getUserStatsPeriod(targetId, chatIdOrNull, 28);
    const weeklyAvg = weekly28.total / 4; // per-week avg over last 28 days
    const risk = mod.computeRiskScore(weekly.byViolation);
    const weeklyTop = Object.entries(weekly.byViolation).sort((a,b)=> (b[1]||0)-(a[1]||0))[0]?.[0] || '-';
    return { daily, weekly, lifetime, dailyAvg, weeklyAvg, risk, weeklyTop };
  }

  function userStatsKeyboard(uid, scope, format) {
    return {
      inline_keyboard: [
        [
          { text: `Scope: ${scope === 'chat' ? 'Chat ✅' : 'Chat'}`, callback_data: `ustats:${uid}:chat:${format}` },
          { text: `Scope: ${scope === 'global' ? 'Global ✅' : 'Global'}`, callback_data: `ustats:${uid}:global:${format}` },
        ],
        [
          { text: `Format: ${format === 'pretty' ? 'Pretty ✅' : 'Pretty'}`, callback_data: `ustats:${uid}:${scope}:pretty` },
          { text: `Format: ${format === 'compact' ? 'Compact ✅' : 'Compact'}`, callback_data: `ustats:${uid}:${scope}:compact` },
        ],
      ],
    };
  }

  // -------- Review callbacks for explicit detections --------
  const RISKY = ['ass','cum','cock','dick','tit','shit','sex','gand','lund','chut','jhant','jhaat','jhat'];
  function tokenize(text = '') {
    return String(text)
      .split(/[^\p{L}\p{N}@#._-]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && t.length <= 64);
  }
  function extractRiskyTokens(text = '', limit = 10) {
    const tokens = tokenize(text);
    const out = [];
    const seen = new Set();
    for (const t of tokens) {
      const low = t.toLowerCase();
      if (!RISKY.some((r) => low.includes(r))) continue;
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(t);
      if (out.length >= limit) break;
    }
    return out;
  }

  composer.callbackQuery(/^rv:(ok|bad|addp|addw):([A-Za-z0-9_-]+)$/i, async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
    const [, kind, id] = ctx.match;
    const review = consumeReview(id);
    if (!review) {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      return ctx.answerCallbackQuery({ text: 'Review expired', show_alert: false });
    }
    if (kind === 'ok') {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
      return ctx.answerCallbackQuery({ text: 'Marked valid', show_alert: false });
    }
    let cands = [];
    if (kind === 'addp') {
      // Safelist entire phrase (trim + cap length)
      const phrase = String(review.text || '').slice(0, 160).trim();
      if (phrase) cands = [phrase];
    } else if (kind === 'addw') {
      // Safelist risky tokens from phrase
      cands = extractRiskyTokens(review.text, 20);
    } else {
      // legacy 'bad' path → risky tokens small batch
      cands = extractRiskyTokens(review.text, 5);
    }
    const { added, persisted, dbError } = await addSafeTerms(cands);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch {}
    const msg = added
      ? `Safelisted ${added} term(s)${persisted ? ' · DB saved' : dbError ? ' · DB error' : ''}`
      : 'No suitable terms found';
    return ctx.answerCallbackQuery({ text: msg, show_alert: false });
  });

  // -------- /abuse command: add explicit phrases/words --------
  function parseQuoted(input = '') {
    const out = [];
    const re = /"([^"]{2,100})"|'([^']{2,100})'|([^,\n]{2,100})/g;
    let m;
    while ((m = re.exec(input))) {
      const s = (m[1] || m[2] || m[3] || '').trim();
      if (s) out.push(s);
      if (out.length >= 10) break;
    }
    return out.map((s) => s.trim()).filter(Boolean);
  }

  composer.command('abuse', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('Admins only.');
    const args = ctx.match || '';
    let candidates = parseQuoted(args);
    if ((!candidates || !candidates.length) && ctx.msg?.reply_to_message) {
      const rep = ctx.msg.reply_to_message;
      const text = rep.text || rep.caption || '';
      // Heuristic: extract tokens with risky substrings
      const risky = ['ass','cum','cock','dick','tit','shit','sex','gand','lund','chut','jhant','jhaat','jhat'];
      const tokens = String(text)
        .split(/[^\p{L}\p{N}@#._-]+/u)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && t.length <= 50);
      const seen = new Set();
      for (const t of tokens) {
        const low = t.toLowerCase();
        if (!risky.some((r) => low.includes(r))) continue;
        if (seen.has(low)) continue;
        seen.add(low);
        candidates.push(t);
        if (candidates.length >= 10) break;
      }
    }
    if (!candidates.length) {
      return ctx.reply('Usage: /abuse "word or phrase" (or reply to a message with /abuse)');
    }
    // Apply at runtime and persist
    addExplicitRuntime(candidates);
    const added = await addExplicitTerms(candidates);
    return ctx.reply(`Added ${added} phrase(s) to explicit list.`);
  });

  async function buildUserStatsMessage(ctx, targetId, scope = 'chat', format = 'pretty') {
    const mod = await import('../logger.js');
    const chatIdOrNull = scope === 'global' ? null : ctx.chat?.id;
    const { daily, weekly, lifetime, dailyAvg, weeklyAvg, risk, weeklyTop } = await fetchUserStats(targetId, chatIdOrNull);
    const funnyPrefix = (await mod.buildFunnyPrefix(risk < 3 ? 'Low' : risk < 10 ? 'Medium' : 'High', weeklyTop)) || '';
    if (format === 'compact') {
      const parts = [];
      parts.push(`${funnyPrefix}<b>User</b> <code>${esc(targetId)}</code>`);
      parts.push(`scope: <i>${scope}</i>`);
      parts.push(`today: <b>${daily.total}</b>`);
      parts.push(`7d: <b>${weekly.total}</b>`);
      parts.push(`avg(d): <b>${isFinite(dailyAvg) ? dailyAvg.toFixed(2) : '0.00'}</b>`);
      parts.push(`avg(w): <b>${isFinite(weeklyAvg) ? weeklyAvg.toFixed(2) : '0.00'}</b>`);
      parts.push(`life: <b>${lifetime.total}</b>`);
      parts.push(`risk: <b>${risk.toFixed(2)}</b>`);
      const top3 = Object.entries(weekly.byViolation).sort((a,b)=> (b[1]||0)-(a[1]||0)).slice(0,3)
        .map(([k,v])=> `${esc(k)}=${v}`).join(', ');
      if (top3) parts.push(`top: <code>${top3}</code>`);
      return parts.join(' | ');
    }
    const riskLabel = (s) => (s < 3 ? 'Low' : s < 10 ? 'Medium' : 'High');
    const topViolations = Object.entries(weekly.byViolation)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`);
    const header = `${funnyPrefix}User stats for <code>${esc(targetId)}</code> ${esc(scope === 'global' ? 'across all chats' : 'in this chat')}`;
    const html = [
      `<b>${header}</b>`,
      '',
      `<b>🗓 Today</b> — Total: <b>${daily.total}</b>`,
      '',
      `<b>🗓 Last 7 Days</b> — Total: <b>${weekly.total}</b>`,
      `• Daily avg: <b>${isFinite(dailyAvg) ? dailyAvg.toFixed(2) : '0.00'}</b> — Weekly avg: <b>${isFinite(weeklyAvg) ? weeklyAvg.toFixed(2) : '0.00'}</b>`,
      `• Lifetime total: <b>${lifetime.total}</b>`,
      `• Risk score (7d): <b>${risk.toFixed(2)}</b> (<i>${riskLabel(risk)}</i>)`,
      topViolations.length ? `• <i>Top violations (7d)</i>\n${topViolations.map((s)=>`  • <code>${esc(s)}</code>`).join('\n')}` : '',
      '',
      `• <i>7d by violation</i>\n${formatKV(weekly.byViolation)}`,
    ]
      .filter(Boolean)
      .join('\n');
    return html;
  }

  // Help
  composer.command(['settings', 'help'], async (ctx) => {
    const msg = [
      'Settings commands:',
      'Bot owner only:',
      '  /botadmin_add <user_id> — or reply to a user to add as bot admin',
      '  /botadmin_remove <user_id> — or reply to a user to remove from bot admins',
      'Bot owner or bot admin:',
      '  /rule_global_enable <rule> — enable a rule globally',
      '  /rule_global_disable <rule> — disable a rule globally',
      '  /maxlen_global_set <n> — set global max length limit',
      '  /user_groups [user_id] [limit] — show user presence count and group links',
      '  /bot_stats — show bot-wide moderation stats',
      'Group owner/admin (with ban rights), bot admin or owner:',
      '  /rule_chat_enable <rule> — enable a rule for this chat',
      '  /rule_chat_disable <rule> — disable a rule for this chat',
      '  /maxlen_chat_set <n> — set max length limit for this chat',
      '  /whitelist_add <user_id> — or reply to a user to whitelist',
      '  /whitelist_remove <user_id> — or reply to a user to unwhitelist',
      '  /whitelist_list — show chat whitelist',
      '  /group_stats — show this chat’s moderation stats',
      '  /user_stats [user_id] — show user stats (reply or pass id; defaults to you)',
      '  /top_violators [days] [global] — list top 10 violators',
      '  /rules_status — show global/chat/effective rule status',
      '',
      `Rules: ${RULE_KEYS.join(', ')}`,
    ].join('\n');
    return ctx.reply(msg);
  });

  // Bot-wide stats (owner or bot admin)
  composer.command('bot_stats', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const tokens = ctx.message.text.trim().split(/\s+/);
    const format = tokens.includes('compact') ? 'compact' : 'pretty';
    const html = await buildBotStatsMessage(format);
    return ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: botStatsKeyboard(format) });
  });

  // Per-chat stats (chat admin with ban rights, or bot admin/owner)
  composer.command('group_stats', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const tokens = ctx.message.text.trim().split(/\s+/);
    const format = tokens.includes('compact') ? 'compact' : 'pretty';
    const html = await buildGroupStatsMessage(ctx, format);
    return ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: groupStatsKeyboard(format) });
  });

  // Top violators (per chat by default). Anyone can view
  composer.command('top_violators', async (ctx) => {
    const tokens = ctx.message.text.trim().split(/\s+/);
    const daysTok = tokens.slice(1).find((t) => /^(\d+)$/.test(t));
    const days = daysTok ? Number(daysTok) : 7;
    const globalFlag = tokens.includes('global');
    const mod = await import('../logger.js');
    const list = await mod.getTopViolators(days, globalFlag ? null : ctx.chat.id, 10);
    if (!list.length) return ctx.reply('No violations found for the selected period.');
    const rows = list.map((u, i) => {
      const topV = Object.entries(u.byViolation||{}).sort((a,b)=> (b[1]||0)-(a[1]||0))[0]?.[0] || '-';
      return `${i+1}. <a href="tg://user?id=${u.userId}">${esc(u.userId)}</a> — total: <b>${u.total}</b>, risk: <b>${u.risk.toFixed(2)}</b>, top: <code>${esc(topV)}</code>`;
    });
    const scope = globalFlag ? 'across all chats' : 'in this chat';
    const html = [`<b>Top ${list.length} violators (${esc(scope)}, last ${days}d)</b>`, ...rows].join('\n');
    return ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  // Toggle handlers for bot/group stats
  composer.callbackQuery(/^bstats:(pretty|compact)$/i, async (ctx) => {
    const [, format] = ctx.match;
    const html = await buildBotStatsMessage(format);
    try {
      await ctx.editMessageText(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: botStatsKeyboard(format) });
    } catch (_) {
      await ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: botStatsKeyboard(format) });
    }
    return ctx.answerCallbackQuery();
  });

  // User groups (presence + links) — owner or bot admin only
  composer.command('user_groups', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const tokens = ctx.message.text.trim().split(/\s+/);
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    let limit = 20;
    let offset = 0;
    // Parse args: numeric id and/or limit
    for (const t of tokens.slice(1)) {
      const n = Number(t);
      if (Number.isFinite(n)) {
        if (!targetId) targetId = n; else if (!limit) limit = n; else offset = n;
      }
    }
    if (!Number.isFinite(targetId)) targetId = ctx.from?.id;
    if (!Number.isFinite(targetId)) return;
    try {
      const count = await getUserGroupCount(targetId);
      const groups = await getUserGroupLinks(ctx, targetId, { limit, offset });
      const title = `User ${targetId} is present in ${count} group(s).`;
      const start = Math.min(offset + 1, Math.max(count, 1));
      const end = Math.min(offset + groups.length, count);
      const header = `${title}\nShowing ${start}-${end} of ${count}`;
      const lines = groups.length ? groups.map((g, i) => `${offset + i + 1}. ${g.link || `chat:${g.chat_id}`}${g.title ? ` — ${g.title}` : ''}`) : ['No links available (bot may lack rights).'];
      const prevOff = Math.max(0, offset - limit);
      const nextOff = offset + limit < count ? offset + limit : offset;
      const kb = {
        inline_keyboard: [[
          { text: '⏮️ Prev', callback_data: `ugroups:${targetId}:${prevOff}:${limit}` },
          { text: 'Next ⏭️', callback_data: `ugroups:${targetId}:${nextOff}:${limit}` },
        ]],
      };
      return ctx.reply([header, ...lines].join('\n'), { reply_markup: kb, disable_web_page_preview: true });
    } catch (e) {
      return ctx.reply(`Failed to fetch presence: ${e?.message || e}`);
    }
  });

  // Pagination handler for user_groups
  composer.callbackQuery(/^ugroups:(\d+):(\d+):(\d+)$/i, async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.answerCallbackQuery();
    const [, uid, off, lim] = ctx.match;
    const userId = Number(uid);
    const offset = Number(off);
    const limit = Number(lim) || 20;
    try {
      const count = await getUserGroupCount(userId);
      const groups = await getUserGroupLinks(ctx, userId, { limit, offset });
      const title = `User ${userId} is present in ${count} group(s).`;
      const start = Math.min(offset + 1, Math.max(count, 1));
      const end = Math.min(offset + groups.length, count);
      const header = `${title}\nShowing ${start}-${end} of ${count}`;
      const lines = groups.length ? groups.map((g, i) => `${offset + i + 1}. ${g.link || `chat:${g.chat_id}`}${g.title ? ` — ${g.title}` : ''}`) : ['No links available (bot may lack rights).'];
      const prevOff = Math.max(0, offset - limit);
      const nextOff = offset + limit < count ? offset + limit : offset;
      const kb = {
        inline_keyboard: [[
          { text: '⏮️ Prev', callback_data: `ugroups:${userId}:${prevOff}:${limit}` },
          { text: 'Next ⏭️', callback_data: `ugroups:${userId}:${nextOff}:${limit}` },
        ]],
      };
      try {
        await ctx.editMessageText([header, ...lines].join('\n'), { reply_markup: kb, disable_web_page_preview: true });
      } catch {
        await ctx.reply([header, ...lines].join('\n'), { reply_markup: kb, disable_web_page_preview: true });
      }
    } catch (_) {}
    return ctx.answerCallbackQuery();
  });

  composer.callbackQuery(/^gstats:(pretty|compact)$/i, async (ctx) => {
    const [, format] = ctx.match;
    const html = await buildGroupStatsMessage(ctx, format);
    try {
      await ctx.editMessageText(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: groupStatsKeyboard(format) });
    } catch (_) {
      await ctx.reply(html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: groupStatsKeyboard(format) });
    }
    return ctx.answerCallbackQuery();
  });

  // User stats (per-chat, with optional "global" flag). Anyone can view.
  composer.command('user_stats', async (ctx) => {
    const tokens = ctx.message.text.trim().split(/\s+/);
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    // Accept numeric id in args
    for (const t of tokens.slice(1)) {
      const n = Number(t);
      if (Number.isFinite(n)) { targetId = n; break; }
    }
    // Default to caller
    if (!Number.isFinite(targetId)) targetId = ctx.from?.id;
    if (!Number.isFinite(targetId)) return;
    const scope = tokens.includes('global') ? 'global' : 'chat';
    const format = tokens.includes('compact') ? 'compact' : 'pretty';
    const html = await buildUserStatsMessage(ctx, targetId, scope, format);
    return ctx.reply(html, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: userStatsKeyboard(targetId, scope, format),
    });
  });

  // Global user stats command (alias)
  composer.command('user_stats_global', async (ctx) => {
    const tokens = ctx.message.text.trim().split(/\s+/);
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    for (const t of tokens.slice(1)) {
      const n = Number(t);
      if (Number.isFinite(n)) { targetId = n; break; }
    }
    if (!Number.isFinite(targetId)) targetId = ctx.from?.id;
    if (!Number.isFinite(targetId)) return;
    const html = await buildUserStatsMessage(ctx, targetId, 'global', 'pretty');
    return ctx.reply(html, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: userStatsKeyboard(targetId, 'global', 'pretty'),
    });
  });

  // Interactive scope/format switcher via inline buttons
  composer.callbackQuery(/^ustats:(\d+):(chat|global):(pretty|compact)$/i, async (ctx) => {
    const [, uid, scope, format] = ctx.match;
    const html = await buildUserStatsMessage(ctx, Number(uid), scope, format);
    try {
      await ctx.editMessageText(html, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: userStatsKeyboard(Number(uid), scope, format),
      });
    } catch (_) {
      await ctx.reply(html, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: userStatsKeyboard(Number(uid), scope, format),
      });
    }
    return ctx.answerCallbackQuery();
  });

  // Admin management (owner only)
  composer.command('botadmin_add', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const replyFrom = ctx.message?.reply_to_message?.from;
    let id = replyFrom?.id;
    if (!Number.isFinite(id)) {
      const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
      id = Number(idStr);
    }
    if (!Number.isFinite(id)) {
      return ctx.reply('Usage: Reply to a user with /botadmin_add, or provide /botadmin_add <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be promoted to bot admin.');
    }
    await addBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_add', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Added bot admin: ${id}` });
    return ctx.reply(`Added bot admin: ${id}`);
  });

  composer.command('botadmin_remove', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const replyFrom = ctx.message?.reply_to_message?.from;
    let id = replyFrom?.id;
    if (!Number.isFinite(id)) {
      const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
      id = Number(idStr);
    }
    if (!Number.isFinite(id)) {
      return ctx.reply('Usage: Reply to a user with /botadmin_remove, or provide /botadmin_remove <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots are not in the bot admin list.');
    }
    await removeBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_remove', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Removed bot admin: ${id}` });
    return ctx.reply(`Removed bot admin: ${id}`);
  });

  // Global rule toggles (owner or bot admin)
  composer.command('rule_global_enable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, true);
    await logAction(ctx, { action: 'rule_global_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} globally` });
    return ctx.reply(`Enabled ${rule} globally.`);
  });

  composer.command('rule_global_disable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, false);
    await logAction(ctx, { action: 'rule_global_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} globally` });
    return ctx.reply(`Disabled ${rule} globally.`);
  });

  // Chat rule toggles (chat admin with ban rights, or bot admin/owner)
  composer.command('rule_chat_enable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, true);
    await logAction(ctx, { action: 'rule_chat_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} for chat` });
    return ctx.reply(`Enabled ${rule} for this chat.`);
  });

  composer.command('rule_chat_disable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, false);
    await logAction(ctx, { action: 'rule_chat_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} for chat` });
    return ctx.reply(`Disabled ${rule} for this chat.`);
  });

  // Status
  composer.command('rules_status', async (ctx) => {
    const s = await getSettings();
    const chatId = String(ctx.chat.id);
    const effective = await getEffectiveRules(chatId);
    const chatRules = await getChatRules(chatId);
    const effectiveMax = await getEffectiveMaxLen(chatId);
    const globalMax = s.global_limits?.max_len ?? DEFAULT_LIMITS.max_len;
    const chatMax = await getChatMaxLen(chatId);
    const msg = formatRulesStatus(s.global_rules, chatRules, effective, {
      effectiveMax,
      globalMax,
      chatMax,
    });
    return ctx.reply(msg);
  });

  // Global and chat max_len setters
  composer.command('maxlen_global_set', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('Usage: /maxlen_global_set <number>');
    await setGlobalMaxLenLimit(n);
    await logAction(ctx, { action: 'maxlen_global_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Global max_len=${Math.trunc(n)}` });
    return ctx.reply(`Global max length limit set to ${Math.trunc(n)}.`);
  });

  composer.command('maxlen_chat_set', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('Usage: /maxlen_chat_set <number>');
    await setChatMaxLenLimit(String(ctx.chat.id), n);
    await logAction(ctx, { action: 'maxlen_chat_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Chat max_len=${Math.trunc(n)}` });
    return ctx.reply(`Chat max length limit set to ${Math.trunc(n)}.`);
  });

  // Chat whitelist commands (chat admin with ban rights, or bot admin/owner)
  composer.command('whitelist_add', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    // Prefer reply target if command is used as a reply
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    if (!Number.isFinite(targetId)) {
      const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
      targetId = Number(arg);
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('Usage: Reply to a user with /whitelist_add, or provide /whitelist_add <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be whitelisted.');
    }
    await addChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_add', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Whitelisted user ${targetId}` });
    return ctx.reply(`User ${targetId} added to whitelist for this chat.`);
  });

  composer.command('whitelist_remove', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    // Prefer reply target if command is used as a reply
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    if (!Number.isFinite(targetId)) {
      const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
      targetId = Number(arg);
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('Usage: Reply to a user with /whitelist_remove, or provide /whitelist_remove <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be whitelisted.');
    }
    await removeChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_remove', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Removed user ${targetId} from whitelist` });
    return ctx.reply(`User ${targetId} removed from whitelist for this chat.`);
  });

  composer.command('whitelist_list', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const list = await getChatWhitelist(String(ctx.chat.id));
    if (!list.length) return ctx.reply('Whitelist is empty for this chat.');
    return ctx.reply(`Whitelisted user IDs:\n${list.join('\n')}`);
  });

  // Bot command menu management
  // Set up command list for users and for all chat administrators
  composer.command('set_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      // Default (all users) concise commands
      await ctx.api.setMyCommands(
        [
          { command: 'start', description: 'Add bot to a group' },
          { command: 'help', description: 'Show help and commands' },
          { command: 'ping', description: 'Check bot availability' },
          { command: 'settings', description: 'Show settings help' },
          { command: 'rules_status', description: 'Show rules status' },
          { command: 'group_stats', description: 'Show this chat\'s stats' },
          { command: 'user_stats', description: 'Show your stats (or reply/id)' },
          { command: 'user_stats_global', description: 'Show your global stats' },
          { command: 'top_violators', description: 'List top violators' },
        ],
        { scope: { type: 'default' } }
      );

      // Admin commands menu for all chat administrators
      await ctx.api.setMyCommands(
        [
          { command: 'rules_status', description: 'Show rules status' },
          { command: 'group_stats', description: 'Show this chat\'s stats' },
          { command: 'user_stats', description: 'Show user stats (reply/id)' },
          { command: 'user_stats_global', description: 'Show global user stats' },
          { command: 'rule_chat_enable', description: 'Enable a rule in this chat' },
          { command: 'rule_chat_disable', description: 'Disable a rule in this chat' },
          { command: 'maxlen_chat_set', description: 'Set max message length for chat' },
          { command: 'whitelist_add', description: 'Whitelist a user ID in this chat' },
          { command: 'whitelist_remove', description: 'Remove a whitelisted user ID' },
          { command: 'whitelist_list', description: 'List chat whitelist' },
          { command: 'top_violators', description: 'List top violators' },
        ],
        { scope: { type: 'all_chat_administrators' } }
      );

      // Owner-level commands (optional): set for all private chats to reduce clutter in groups
      await ctx.api.setMyCommands(
        [
          { command: 'bot_stats', description: 'Show bot-wide stats' },
          { command: 'botadmin_add', description: 'Add a bot admin (owner only)' },
          { command: 'botadmin_remove', description: 'Remove a bot admin' },
          { command: 'rule_global_enable', description: 'Enable a rule globally' },
          { command: 'rule_global_disable', description: 'Disable a rule globally' },
          { command: 'maxlen_global_set', description: 'Set global max length' },
          { command: 'user_stats', description: 'Show user stats (reply/id)' },
          { command: 'user_stats_global', description: 'Show global user stats' },
          { command: 'user_groups', description: 'Show user group presence' },
          { command: 'set_mycommands', description: 'Publish command menus' },
          { command: 'remove_mycommands', description: 'Clear command menus' },
        ],
        { scope: { type: 'all_private_chats' } }
      );

      return ctx.reply('Bot commands have been set.');
    } catch (e) {
      return ctx.reply(`Failed to set commands: ${e?.description || e?.message || e}`);
    }
  });

  // Remove command menu (default and admin scopes)
  composer.command('remove_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      await ctx.api.deleteMyCommands({ scope: { type: 'default' } });
      await ctx.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });
      return ctx.reply('Bot commands have been removed.');
    } catch (e) {
      return ctx.reply(`Failed to remove commands: ${e?.description || e?.message || e}`);
    }
  });

  return composer;
}
