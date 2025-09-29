import { Composer } from 'grammy';
import { logAction, getBotStats, getGroupStats, getUserGroupCount, getUserGroupLinks, getChatPresenceUserIds, removeChatPresenceUsers, getUserPresenceChatIds } from '../logger.js';
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
  setGlobalBlacklistEntry,
  removeGlobalBlacklistEntry,
  listGlobalBlacklist,
  getBlacklistEntry,
} from '../store/settings.js';
import { consumeReview } from '../logger.js';
import { addSafeTerms, addExplicitTerms } from '../filters/customTerms.js';
import { defaultCommands, adminCommands, ownerPrivateCommands } from '../commands/menu.js';
import { addExplicitRuntime, containsExplicit } from '../filters.js';

const groupKickAbortState = new Map(); // chatId -> { abort, startedAt, startedBy, abortedBy, abortedAt }

const taskQueue = [];
let activeTask = null;
let taskCounter = 0;

const PRIORITY_MAP = {
  low: -10,
  normal: 0,
  default: 0,
  medium: 5,
  high: 10,
  urgent: 20,
  critical: 100,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePriority(priority) {
  if (priority === true) return PRIORITY_MAP.high;
  if (priority === false || priority == null) return PRIORITY_MAP.default;
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority;
  if (typeof priority === 'string') {
    const key = priority.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PRIORITY_MAP, key)) return PRIORITY_MAP[key];
    const parsed = Number(priority);
    if (Number.isFinite(parsed)) return parsed;
  }
  return PRIORITY_MAP.default;
}

function pruneQueue() {
  for (let i = taskQueue.length - 1; i >= 0; i -= 1) {
    if (taskQueue[i]?.cancelled) taskQueue.splice(i, 1);
  }
}

function isQueueIdle() {
  pruneQueue();
  return !activeTask && taskQueue.length === 0;
}

function selectNextTask() {
  pruneQueue();
  if (!taskQueue.length) return null;
  let bestIndex = -1;
  let bestTask = null;
  for (let i = 0; i < taskQueue.length; i += 1) {
    const candidate = taskQueue[i];
    if (!candidate || candidate.cancelled) continue;
    if (!bestTask) {
      bestTask = candidate;
      bestIndex = i;
      continue;
    }
    const candidatePriority = Number.isFinite(candidate.priority) ? candidate.priority : PRIORITY_MAP.default;
    const bestPriority = Number.isFinite(bestTask.priority) ? bestTask.priority : PRIORITY_MAP.default;
    if (candidatePriority > bestPriority) {
      bestTask = candidate;
      bestIndex = i;
      continue;
    }
    const candidateSeq = Number.isFinite(candidate.seq) ? candidate.seq : Number.MAX_SAFE_INTEGER;
    const bestSeq = Number.isFinite(bestTask.seq) ? bestTask.seq : Number.MAX_SAFE_INTEGER;
    if (candidatePriority === bestPriority && candidateSeq < bestSeq) {
      bestTask = candidate;
      bestIndex = i;
    }
  }
  if (bestIndex === -1) {
    taskQueue.length = 0;
    return null;
  }
  const [nextTask] = taskQueue.splice(bestIndex, 1);
  return nextTask || null;
}

function processNextTask() {
  if (activeTask) return;
  const nextTask = selectNextTask();
  if (!nextTask) return;
  activeTask = nextTask;
  Promise.resolve()
    .then(() => nextTask.run?.())
    .catch((err) => {
      console.error('[taskQueue] task failed:', err?.message || err);
      if (typeof nextTask.onError === 'function') {
        try { nextTask.onError(err); } catch (nested) {
          console.error('[taskQueue] onError failed:', nested?.message || nested);
        }
      }
    })
    .finally(() => {
      activeTask = null;
      processNextTask();
    });
}

function enqueueTask(task, { priority = 0 } = {}) {
  const prio = normalizePriority(priority);
  const entry = task;
  entry.priority = prio;
  entry.seq = ++taskCounter;
  entry.cancelled = Boolean(entry.cancelled);
  taskQueue.push(entry);
  processNextTask();
  return entry;
}

function clearTaskQueue({ abortActive = false } = {}) {
  while (taskQueue.length) {
    const task = taskQueue.shift();
    if (typeof task.cancel === 'function') {
      try { task.cancel({ reason: 'reset' }); } catch (err) {
        console.warn('[taskQueue] failed to cancel queued task:', err?.message || err);
      }
    }
    task.cancelled = true;
  }
  pruneQueue();
  if (abortActive && activeTask && typeof activeTask.cancel === 'function') {
    try { activeTask.cancel({ reason: 'reset' }); } catch (err) {
      console.warn('[taskQueue] failed to cancel active task:', err?.message || err);
    }
  }
}

function findQueuedGroupKick(chatId) {
  pruneQueue();
  return taskQueue.find((task) => task.type === 'group_kick_all' && task.chatId === chatId && !task.cancelled);
}

// Utilities shared with security middleware (re-implemented minimal)
async function isChatAdminWithBan(ctx, userId) {
  const chatId = ctx.chat?.id;
  if (!chatId || !userId) return false;
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (!member) return false;
    if (member.status === 'creator') return true;
    if (member.status === 'administrator') {
      // Require explicit ban/restrict permission; default to false if unknown
      return Boolean(member.can_restrict_members);
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

  // Reply helper that auto-deletes bot's own messages (configurable)
  async function replyEphemeral(ctx, text, options = {}) {
    const enabled = String(process.env.BOT_REPLY_CLEANUP || '').toLowerCase();
    const doCleanup = enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
    const seconds = Number(process.env.BOT_REPLY_CLEANUP_SECONDS || 60);
    const sent = await ctx.reply(text, options);
    if (doCleanup && sent?.chat?.id && sent?.message_id) {
      const chatId = sent.chat.id;
      const mid = sent.message_id;
      setTimeout(() => { ctx.api.deleteMessage(chatId, mid).catch(() => {}); }, Math.max(1, Math.trunc(seconds)) * 1000);
    }
    return sent;
  }

  const BLACKLIST_MUTE_PERMS = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
  };

  const BL_DELAY_MIN = Math.max(0, Number(process.env.BLACKLIST_ENFORCE_DELAY_MIN_MS || 0));
  const BL_DELAY_MAX_RAW = Number(process.env.BLACKLIST_ENFORCE_DELAY_MAX_MS || 0);
  const BL_DELAY_MAX = Number.isFinite(BL_DELAY_MAX_RAW) && BL_DELAY_MAX_RAW >= BL_DELAY_MIN ? BL_DELAY_MAX_RAW : BL_DELAY_MIN;
  const nextBlacklistDelay = () => {
    if (BL_DELAY_MAX <= BL_DELAY_MIN) return BL_DELAY_MIN;
    return BL_DELAY_MIN + Math.random() * (BL_DELAY_MAX - BL_DELAY_MIN);
  };

  const GROUP_KICK_BLOCKED_IDS = new Set([
    '-1001916027284',
    '-1001609321266',
    '-1001222500158',
    '-1001668607951',
    '-1002228738904',
    '-1002385443108',
    '-1002152437320',
    '-1001647329280',
    '-1001689743389',
    '-1002102776935',
    '-1001752208777',
    '-1001765844802',
    '-1001580772252',
    '-1001597005557',
    '-1001637645619',
    '-1001576137499',
  ]);

  async function enforceBlacklistAcrossChats(ctx, userId, action) {
    const chatIds = await getUserPresenceChatIds(userId);
    const details = {
      total: chatIds.length,
      applied: [],
      failures: [],
    };
    if (!chatIds.length) return details;
    for (const chatId of chatIds) {
      let chatMeta;
      try {
        chatMeta = await ctx.api.getChat(chatId);
      } catch {}
      try {
        if (action === 'mute') {
          await ctx.api.restrictChatMember(chatId, userId, { permissions: BLACKLIST_MUTE_PERMS });
          details.applied.push({ chatId, title: chatMeta?.title, mode: 'mute' });
        } else {
          await ctx.api.banChatMember(chatId, userId, { until_date: Math.floor(Date.now() / 1000) + 60 });
          try {
            await ctx.api.unbanChatMember(chatId, userId);
          } catch {}
          try {
            await removeChatPresenceUsers(chatId, [userId]);
          } catch {}
          details.applied.push({ chatId, title: chatMeta?.title, mode: 'kick' });
        }
      } catch (err) {
        const reason = String(err?.description || err?.message || err || '').slice(0, 200);
        details.failures.push({ chatId, title: chatMeta?.title, reason });
      }
      const delayMs = Math.floor(nextBlacklistDelay());
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return details;
  }

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
      const topV = Object.entries(weekly.byViolation).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 3)
        .map(([k, v]) => `${esc(k)}=${v}`).join(', ');
      const topA = Object.entries(weekly.byAction).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 2)
        .map(([k, v]) => `${esc(k)}=${v}`).join(', ');
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
      const topV = Object.entries(weekly.byViolation).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 3)
        .map(([k, v]) => `${esc(k)}=${v}`).join(', ');
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
    const weeklyTop = Object.entries(weekly.byViolation).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]?.[0] || '-';
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
  const RISKY = ['ass', 'cum', 'cock', 'dick', 'tit', 'shit', 'sex', 'gand', 'lund', 'chut', 'jhant', 'jhaat', 'jhat'];
  function tokenize(text = '') {
    return String(text)
      .split(/[^\p{L}\p{N}@#._-]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && t.length <= 64);
  }
  function extractRiskyTokens(text = '', limit = 300) {
    const tokens = tokenize(text);
    let out = [];
    for (const t of tokens) {
      const low = t.toLowerCase();
      if (containsExplicit(low)) {
        out = [...out, low];
        if (out.length >= limit) break;
      };
    }
    return out;
  }

  // Single "Safelist" action: extract risky tokens from the content and add
  composer.callbackQuery(/^rv:(ok|add):([A-Za-z0-9_-]+)$/i, async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
    const [, kind, id] = ctx.match;
    let review = consumeReview(id);
    if (!review) {
      // Fallback: parse the phrase from the logged message content
      try {
        const m = ctx.callbackQuery?.message;
        const txt = (m?.text || m?.caption || '').toString();
        const line = txt.split(/\r?\n/).find((l) => /\bContent:\b/i.test(l));
        if (line) {
          const phrase = line.replace(/^.*?Content:\s*/i, '').trim();
          if (phrase) review = { text: phrase };
        }
      } catch { }
      if (!review) {
        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { }
        return ctx.answerCallbackQuery({ text: 'Review expired', show_alert: false });
      }
    }
    if (kind === 'ok') {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { }
      return ctx.answerCallbackQuery({ text: 'Marked valid', show_alert: false });
    }
    // Safelist risky tokens from the phrase (no whole-phrase safelisting)
    const cands = extractRiskyTokens(review.text, 300);
    const { added, persisted, dbError } = await addSafeTerms(cands);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { }
    const msg = added
      ? `Safelisted ${added} term(s)${persisted ? ' · DB saved' : dbError ? ' · DB error' : ''}`
      : 'No suitable terms found';
    return ctx.answerCallbackQuery({ text: msg, show_alert: false });
  });

  // -------- Safelist suggestions (auto from logs) --------
  const suggStore = new Map(); // id -> { until, terms: string[] }
  const SUGG_TTL_MS = 15 * 60 * 1000;

  composer.command('safelist_suggest', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    const parts = String(ctx.match || '').trim().split(/\s+/).filter(Boolean);
    const scope = (parts[0] || 'chat').toLowerCase();
    const limit = Number(parts[1] || 20) || 20;
    const chatScope = scope === 'global' ? null : ctx.chat?.id;
    try {
      const mod = await import('../logger.js');
      const list = await mod.getSafeSuggestions({ chatId: chatScope, limit, horizon: 800 });
      if (!list.length) return ctx.reply('ℹ️ <b>No suggestions found</b>', { parse_mode: 'HTML' });
      const id = Math.random().toString(36).slice(2);
      const until = Date.now() + SUGG_TTL_MS;
      suggStore.set(id, { until, terms: list.map((x) => x.term) });
      const lines = list.map((x) => `• <code>${esc(x.term)}</code> — <b>${x.count}</b>`).join('\n');
      const kb = {
        inline_keyboard: [
          [{ text: 'Safelist Top 5', callback_data: `sfs:add:${id}:5:${scope}` }, { text: 'Top 10', callback_data: `sfs:add:${id}:10:${scope}` }],
          [{ text: 'Safelist All', callback_data: `sfs:add:${id}:all:${scope}` }],
        ],
      };
      return ctx.reply([
        `<b>Safelist Suggestions (${scope})</b>`,
        lines,
        '',
        `<i>Tap a button to add these words${scope === 'global' ? ' globally' : ' for this chat (persisted globally)'}.</i>`,
      ].join('\n'), { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    } catch (e) {
      return ctx.reply('Failed to build suggestions.');
    }
  });

  composer.callbackQuery(/^sfs:add:([A-Za-z0-9_-]+):(\d+|all):(chat|global)$/i, async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.answerCallbackQuery({ text: 'Admins only', show_alert: true });
    const [, id, countStr, scope] = ctx.match;
    const row = suggStore.get(id);
    if (!row || row.until < Date.now()) {
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { }
      return ctx.answerCallbackQuery({ text: 'Suggestions expired', show_alert: false });
    }
    const terms = row.terms.slice(0, countStr === 'all' ? row.terms.length : Number(countStr || 0));
    const { added, persisted, dbError } = await addSafeTerms(terms);
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { }
    return ctx.answerCallbackQuery({ text: added ? `Safelisted ${added} term(s)${persisted ? ' · DB saved' : dbError ? ' · DB error' : ''}` : 'No terms added', show_alert: false });
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

  function parseCommandArgs(ctx) {
    try {
      const text = ctx.message?.text || ctx.msg?.text || '';
      // Strip "/abuse" and optional @botusername, then leading whitespace
      return text.replace(/^\/(?:abuse)(?:@\w+)?\s*/i, '');
    } catch { return ''; }
  }

  composer.command('abuse', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    const args = parseCommandArgs(ctx);
    let candidates = parseQuoted(args);
    if ((!candidates || !candidates.length) && ctx.msg?.reply_to_message) {
      const rep = ctx.msg.reply_to_message;
      const text = rep.text || rep.caption || '';
      // Heuristic: extract tokens with risky substrings
      const tokens = tokenize(text);
      candidates.push(...tokens);
    }
    if (!candidates.length) {
      return ctx.reply('💡 <b>Usage:</b> <code>/abuse "word or phrase"</code> (or reply to a message with <code>/abuse</code>)', { parse_mode: 'HTML' });
    }
    // Apply at runtime and persist
    addExplicitRuntime(candidates);
    const added = await addExplicitTerms(candidates);
    return ctx.reply(`✅ <b>Added</b> <b>${added}</b> phrase(s) to explicit list.`, { parse_mode: 'HTML' });
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
      const top3 = Object.entries(weekly.byViolation).sort((a, b) => (b[1] || 0) - (a[1] || 0)).slice(0, 3)
        .map(([k, v]) => `${esc(k)}=${v}`).join(', ');
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
      topViolations.length ? `• <i>Top violations (7d)</i>\n${topViolations.map((s) => `  • <code>${esc(s)}</code>`).join('\n')}` : '',
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
      '  /blacklist_add <user_id> [kick|mute] [reason] — add to global blacklist',
      '  /blacklist_remove <user_id> — remove from global blacklist',
      '  /blacklist_list — show global blacklist entries',
      '',
      `Rules: ${RULE_KEYS.join(', ')}`,
    ].join('\n');
    return replyEphemeral(ctx, msg);
  });

  // Bot-wide stats (owner or bot admin)
  composer.command('bot_stats', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const tokens = ctx.message.text.trim().split(/\s+/);
    const format = tokens.includes('compact') ? 'compact' : 'pretty';
    const html = await buildBotStatsMessage(format);
    return replyEphemeral(ctx, html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: botStatsKeyboard(format) });
  });

  // Per-chat stats (chat admin with ban rights, or bot admin/owner)
  composer.command('group_stats', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const tokens = ctx.message.text.trim().split(/\s+/);
    const format = tokens.includes('compact') ? 'compact' : 'pretty';
    const html = await buildGroupStatsMessage(ctx, format);
    return replyEphemeral(ctx, html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: groupStatsKeyboard(format) });
  });

  // Top violators (per chat by default). Anyone can view
  composer.command('top_violators', async (ctx) => {
    const tokens = ctx.message.text.trim().split(/\s+/);
    const daysTok = tokens.slice(1).find((t) => /^(\d+)$/.test(t));
    const days = daysTok ? Number(daysTok) : 7;
    const globalFlag = tokens.includes('global');
    const mod = await import('../logger.js');
    const list = await mod.getTopViolators(days, globalFlag ? null : ctx.chat.id, 10);
    if (!list.length) return ctx.reply('ℹ️ <b>No violations found</b> for the selected period.', { parse_mode: 'HTML' });
    // Resolve names best-effort (per-chat: via getChatMember; global: via getChat if possible)
    const rows = await Promise.all(list.map(async (u, i) => {
      const topV = Object.entries(u.byViolation || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]?.[0] || '-';
      let label = String(u.userId);
      try {
        if (!globalFlag && ctx.chat?.id) {
          const m = await ctx.api.getChatMember(ctx.chat.id, Number(u.userId));
          const name = [m?.user?.first_name, m?.user?.last_name].filter(Boolean).join(' ');
          if (name) label = name; else if (m?.user?.username) label = `@${m.user.username}`;
        } else {
          try {
            const ch = await ctx.api.getChat(Number(u.userId));
            const name = [ch?.first_name, ch?.last_name].filter(Boolean).join(' ');
            if (name) label = name; else if (ch?.username) label = `@${ch.username}`;
          } catch { }
        }
      } catch { }
      const anchor = `<a href="tg://user?id=${u.userId}">${esc(label)}</a>`;
      return `${i + 1}. ${anchor} — total: <b>${u.total}</b>, risk: <b>${u.risk.toFixed(2)}</b>, top: <code>${esc(topV)}</code>`;
    }));
    const scope = globalFlag ? 'across all chats' : 'in this chat';
    const html = [`<b>Top ${list.length} violators (${esc(scope)}, last ${days}d)</b>`, ...rows].join('\n');
    return replyEphemeral(ctx, html, { parse_mode: 'HTML', disable_web_page_preview: true });
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
      return replyEphemeral(ctx, `<b>${esc(header)}</b>\n${esc(lines.join('\n'))}`, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    } catch (e) {
      return replyEphemeral(ctx, `❌ <b>Failed to fetch presence:</b> <code>${esc(e?.message || String(e))}</code>`, { parse_mode: 'HTML' });
    }
  });

  // Pagination handler for user_groups
  composer.command('group_kick_all', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('ℹ️ Run this command in a private chat with the bot.');
    }
    if (!(await isBotAdminOrOwner(ctx))) {
      return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    }
    const tokens = ctx.message.text.trim().split(/\s+/).slice(1);
    const inspectDefaultRaw = Number(process.env.GROUP_KICK_INSPECT_LIMIT);
    const DEFAULT_INSPECT_LIMIT = Number.isFinite(inspectDefaultRaw) ? Math.max(1, inspectDefaultRaw) : 25;
    let rawId = null;
    let confirm = false;
    let inspect = false;
    let inspectLimit = DEFAULT_INSPECT_LIMIT;
    for (const tok of tokens) {
      const lower = String(tok || '').toLowerCase();
      const numeric = Number(tok);
      if (!rawId && Number.isFinite(numeric)) {
        rawId = tok;
        continue;
      }
      if (lower === 'confirm' || lower === '--confirm') {
        confirm = true;
        continue;
      }
      if (lower === 'inspect' || lower === '--inspect' || lower === 'preview') {
        inspect = true;
        continue;
      }
      const limitMatch = lower.match(/^limit=(\d{1,3})$/);
      if (limitMatch) {
        inspectLimit = Math.min(200, Math.max(1, Number(limitMatch[1])));
        continue;
      }
    }
    if (!rawId || (!confirm && !inspect)) {
      const usage = [
        '⚠️ <b>Usage:</b> <code>/group_kick_all &lt;chat_id&gt; confirm</code>',
        'Chat ID must be the numeric Telegram ID (e.g. <code>-1001234567890</code>).',
        'The bot removes everyone it has seen in that chat except admins and itself.',
        'Preview with <code>/group_kick_all &lt;chat_id&gt; inspect [limit=25]</code> before confirming.',
        'Use <code>/group_kick_all_abort &lt;chat_id&gt;</code> to cancel a running purge.',
      ].join('\n');
      return ctx.reply(usage, { parse_mode: 'HTML' });
    }
    const chatId = Number(rawId);
    if (!Number.isFinite(chatId)) {
      return ctx.reply('❌ <b>Invalid chat ID.</b> Provide a numeric ID like <code>-1001234567890</code>.', { parse_mode: 'HTML' });
    }
    if (GROUP_KICK_BLOCKED_IDS.has(String(chatId))) {
      return ctx.reply('⛔ <b>This chat ID is protected</b>; bulk removal is disabled for this group.', { parse_mode: 'HTML' });
    }
    const abortKey = String(chatId);
    const existing = groupKickAbortState.get(abortKey);
    if (existing && !existing.completed && !existing.abort) {
      return ctx.reply('⚠️ A /group_kick_all operation is already running for this chat. Use /group_kick_all_abort to stop it.', { parse_mode: 'HTML' });
    }
    let chat = null;
    try {
      chat = await ctx.api.getChat(chatId);
    } catch (e) {
      const msg = e?.description || e?.message || String(e);
      return ctx.reply(`❌ <b>Failed to access chat:</b> <code>${esc(msg)}</code>`, { parse_mode: 'HTML' });
    }
    if (chat?.type !== 'supergroup' && chat?.type !== 'group') {
      return ctx.reply('❌ <b>Target chat must be a group or supergroup.</b>', { parse_mode: 'HTML' });
    }
    let adminIds = new Set();
    let botMember = null;
    try {
      const admins = await ctx.api.getChatAdministrators(chatId);
      adminIds = new Set(admins.map((a) => a.user?.id).filter((v) => Number.isFinite(v)));
      botMember = admins.find((a) => a?.user?.id === ctx.me?.id) || null;
    } catch {}
    if (!botMember) {
      try {
        botMember = await ctx.api.getChatMember(chatId, ctx.me?.id);
      } catch {}
    }
    const canRestrict = Boolean(botMember?.status === 'administrator' && botMember?.can_restrict_members);
    if (!canRestrict && confirm) {
      return ctx.reply('⛔ <b>I need Ban Users permission in that group to run /group_kick_all.</b>', { parse_mode: 'HTML' });
    }
    const memberIds = await getChatPresenceUserIds(chatId);
    if (!memberIds.length) {
      return ctx.reply('ℹ️ <b>No stored member list for this chat.</b> Presence tracking via Supabase is required.', { parse_mode: 'HTML' });
    }
    const meId = ctx.me?.id;
    const seen = Array.from(new Set(memberIds.filter((id) => Number.isFinite(id))));
    const targets = [];
    let skippedAdmins = 0;
    let skippedBot = 0;
    for (const id of seen) {
      if (id === meId) {
        skippedBot += 1;
        continue;
      }
      if (adminIds.has(id)) {
        skippedAdmins += 1;
        continue;
      }
      targets.push(id);
    }
    if (!targets.length) {
      return ctx.reply('ℹ️ <b>Nothing to remove.</b> Only admins or the bot are recorded for that chat.', { parse_mode: 'HTML' });
    }
    if (inspect) {
      const limit = Math.max(1, Math.min(inspectLimit, targets.length));
      const sampleIds = targets.slice(0, limit);
      const sampleLines = [];
      for (let i = 0; i < sampleIds.length; i += 1) {
        const userId = sampleIds[i];
        let infoText = '';
        let noteText = '';
        try {
          const member = await ctx.api.getChatMember(chatId, userId);
          const user = member?.user;
          if (user) {
            const names = [];
            const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
            if (full) names.push(esc(full));
            if (user.username) names.push(`@${esc(user.username)}`);
            infoText = names.join(' · ');
          }
          if (member?.status) {
            const status = String(member.status);
            if (status && status !== 'member') {
              const statusMap = {
                administrator: 'admin',
                creator: 'owner',
                left: 'left',
                kicked: 'kicked',
                restricted: 'restricted',
              };
              const label = statusMap[status] || status;
              noteText = `status: ${esc(label)}`;
            }
          }
        } catch (err) {
          const msg = String(err?.description || err?.message || err || '');
          if (/user not found|member not found|chat member not found|USER_ID_INVALID/i.test(msg)) {
            noteText = 'already absent';
          } else {
            noteText = `error: ${esc(msg.slice(0, 70))}`;
          }
        }
        const detailParts = [];
        if (infoText) detailParts.push(infoText);
        if (noteText) detailParts.push(noteText === 'already absent' ? 'already absent' : `<i>${noteText}</i>`);
        const detail = detailParts.length ? ` — ${detailParts.join(' · ')}` : '';
        sampleLines.push(`${i + 1}. <code>${userId}</code>${detail}`);
      }
      const headerLines = [
        `👁️ <b>Inspecting purge targets for</b> <code>${esc(chat?.title || String(chatId))}</code>`,
        `<b>Tracked members:</b> ${seen.length}`,
        `<b>Potential removals:</b> ${targets.length}`,
        skippedAdmins ? `🛡️ <b>Admins skipped:</b> ${skippedAdmins}` : null,
        skippedBot ? `🤖 <b>Bot ID skipped:</b> ${skippedBot}` : null,
        `Showing first ${limit} target${limit === 1 ? '' : 's'}.`,
      ].filter(Boolean);
      if (targets.length > limit) {
        headerLines.push(`… ${targets.length - limit} more target${targets.length - limit === 1 ? '' : 's'} not shown.`);
      }
      if (!canRestrict) {
        headerLines.push('⚠️ <b>Bot lacks Ban permission</b>; purge will fail until permissions are fixed.');
      }
      headerLines.push('Use <code>/group_kick_all &lt;chat_id&gt; confirm</code> when ready.');
      const previewText = [headerLines.join('\n'), '', sampleLines.join('\n')].filter(Boolean).join('\n');
      await ctx.reply(previewText, { parse_mode: 'HTML', disable_web_page_preview: true });
      if (!confirm) return;
    }
    const currentState = {
      abort: false,
      started: false,
      startedAt: null,
      startedBy: ctx.from?.id,
      abortedBy: null,
      abortedAt: null,
      completed: false,
    };
    groupKickAbortState.set(abortKey, currentState);
    let aborted = false;

    const runPurge = async () => {
      currentState.started = true;
      currentState.startedAt = Date.now();
      try {
        const header = [
          `🚨 <b>Purging members from:</b> <code>${esc(chat?.title || String(chatId))}</code>`,
          `<b>Seen members:</b> ${seen.length}`,
          `<b>Attempting removals:</b> ${targets.length}`,
          adminIds.size ? `🛡️ <b>Admins recorded:</b> ${adminIds.size}` : null,
        ].filter(Boolean).join('\n');
        await ctx.reply(header, { parse_mode: 'HTML' });
        const parseDelay = (value, fallback) => {
          const n = Number(value);
          const base = Number.isFinite(n) ? n : fallback;
          return Math.max(0, base || 0);
        };
        const minDelayMs = parseDelay(process.env.GROUP_KICK_DELAY_MIN_MS, 0);
        const maxDelayMs = Math.max(minDelayMs, parseDelay(process.env.GROUP_KICK_DELAY_MAX_MS, 300));
        const concurrency = Math.max(1, Number(process.env.GROUP_KICK_CONCURRENCY || 5));
        const workerCount = Math.min(concurrency, targets.length || concurrency);
        const nextDelayMs = () => {
          if (maxDelayMs <= minDelayMs) return minDelayMs;
          return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
        };
        const kicked = [];
        const failures = [];
        let alreadyGone = 0;
        const alreadyGoneIds = [];
        let cursor = 0;
        let processed = 0;
        let progressMessage = null;
        let lastProgressAt = 0;
        let progressChain = Promise.resolve();
        const PROGRESS_INTERVAL_MS = Math.max(5000, Number(process.env.GROUP_KICK_PROGRESS_INTERVAL_MS || 15000));
        const PROGRESS_EVERY = Math.max(5, Number(process.env.GROUP_KICK_PROGRESS_EVERY || 25));

        const formatProgress = ({ final = false } = {}) => {
          const title = esc(chat?.title || String(chatId));
          const pct = Math.min(100, Math.floor((processed / targets.length) * 100));
          const lines = [];
          lines.push(final ? (aborted ? '⛔ <b>Purge stopped</b>' : '✅ <b>Purge complete</b>') : '🚨 <b>Purge running…</b>');
          lines.push(`<b>Chat:</b> <code>${title}</code>`);
          lines.push(`<b>Processed:</b> ${processed}/${targets.length} (${pct}%)`);
          if (kicked.length) lines.push(`• Removed: <b>${kicked.length}</b>`);
          if (alreadyGone) lines.push(`• Already absent: <b>${alreadyGone}</b>`);
          if (failures.length) lines.push(`• Failures: <b>${failures.length}</b>`);
          if (skippedAdmins) lines.push(`• Skipped admins: <b>${skippedAdmins}</b>`);
          if (skippedBot) lines.push(`• Skipped bot: <b>${skippedBot}</b>`);
          if (!final && currentState.abort) lines.push('⏳ Waiting for workers to stop…');
          return lines.join('\n');
        };

        const queueProgressUpdate = ({ force = false, final = false } = {}) => {
          progressChain = progressChain.then(async () => {
            if (!force) {
              const now = Date.now();
              const intervalOk = now - lastProgressAt >= PROGRESS_INTERVAL_MS;
              const batchOk = processed % PROGRESS_EVERY === 0;
              if (!intervalOk && !batchOk) return;
              lastProgressAt = now;
            }
            const text = formatProgress({ final });
            try {
              if (!progressMessage) {
                progressMessage = await ctx.reply(text, { parse_mode: 'HTML' });
              } else {
                const editChatId = progressMessage?.chat?.id ?? ctx.chat?.id;
                if (!editChatId) throw new Error('missing chat id for progress edit');
                const edited = await ctx.api.editMessageText(editChatId, progressMessage.message_id, text, { parse_mode: 'HTML' });
                if (edited && typeof edited === 'object') progressMessage = edited;
              }
              lastProgressAt = Date.now();
            } catch (err) {
              const desc = String(err?.description || err?.message || err || '');
              const isUnchanged = /message is not modified/i.test(desc);
              if (!isUnchanged) {
                if (/message to edit not found/i.test(desc)) {
                  progressMessage = null;
                }
                console.warn('[group_kick_all] progress update failed:', desc);
              }
            }
          }).catch((err) => {
            console.warn('[group_kick_all] progress update chain failed:', err?.message || err);
          });
          return progressChain;
        };

        await queueProgressUpdate({ force: true });

        const attemptKick = async (userId) => {
          let attempt = 0;
          const maxAttempts = 3;
          while (attempt < maxAttempts) {
            attempt += 1;
            try {
              await ctx.api.banChatMember(chatId, userId, { until_date: Math.floor(Date.now() / 1000) + 60 });
              kicked.push(userId);
              try {
                await ctx.api.unbanChatMember(chatId, userId);
              } catch {}
              return;
          } catch (err) {
            const desc = String(err?.description || err?.message || err || '');
            const isGone = /user not found/i.test(desc) || /member not found/i.test(desc) || /USER_ID_INVALID/i.test(desc);
            if (isGone) {
              alreadyGone += 1;
              alreadyGoneIds.push(userId);
              return;
            }
            const retryAfterSec = Number(err?.parameters?.retry_after || 0);
            const tooMany = Number(err?.error_code) === 429 || /too many requests/i.test(desc);
            const insufficient = /not enough rights|rights to restrict|administrator rights required|have to be an admin/i.test(desc);
            if (insufficient) {
              failures.push({ userId, reason: desc.slice(0, 160) });
              currentState.abort = true;
              aborted = true;
              return;
            }
            if (tooMany && attempt < maxAttempts) {
              const waitMs = (retryAfterSec > 0 ? retryAfterSec * 1000 : Math.pow(2, attempt) * 500);
              await sleep(waitMs);
              continue;
            }
              failures.push({ userId, reason: desc.slice(0, 160) });
              return;
            }
          }
        };

        const runWorker = async () => {
          while (true) {
            if (currentState.abort) {
              aborted = true;
              break;
            }
            const idx = cursor++;
            if (idx >= targets.length) break;
            const userId = targets[idx];
            if (currentState.abort) {
              aborted = true;
              break;
            }
            await attemptKick(userId);
            processed += 1;
            queueProgressUpdate();
            if (currentState.abort) {
              aborted = true;
              break;
            }
            const delayMs = Math.floor(nextDelayMs());
            if (delayMs > 0) await sleep(delayMs);
          }
        };

        const workers = Array.from({ length: workerCount }, () => runWorker());
        await Promise.all(workers);
        processed = Math.min(targets.length, processed);
        await queueProgressUpdate({ force: true, final: true });
        await progressChain.catch(() => {});
        const pruneIds = Array.from(new Set([...kicked, ...alreadyGoneIds]));
        let presenceRemoved = 0;
        let presenceError;
        if (pruneIds.length) {
          try {
            const res = await removeChatPresenceUsers(chatId, pruneIds);
            presenceRemoved = Number(res?.removed || 0);
            if (res?.error) presenceError = res.error;
          } catch (err) {
            presenceError = err;
          }
        }
        const summaryParts = [
          `✅ <b>Removed:</b> ${kicked.length}`,
          skippedAdmins ? `🛡️ <b>Skipped admins:</b> ${skippedAdmins}` : null,
          skippedBot ? `🤖 <b>Skipped bot ID:</b> ${skippedBot}` : null,
          alreadyGone ? `🚪 <b>Already absent:</b> ${alreadyGone}` : null,
          failures.length ? `⚠️ <b>Failures:</b> ${failures.length}` : null,
        ].filter(Boolean).join('\n');
        const failureLines = failures.slice(0, 5).map((f) => `• <code>${f.userId}</code> — ${esc(f.reason)}`);
        const extraLines = [];
        if (aborted) {
          extraLines.push('⛔ <b>Operation aborted.</b> Remaining members were not processed.');
          if (currentState.abortedBy) {
            extraLines.push(`⏹️ <b>Aborted by:</b> <code>${currentState.abortedBy}</code>`);
          }
        }
        if (pruneIds.length) {
          extraLines.push(`🗃️ <b>Presence records pruned:</b> ${presenceRemoved}`);
          if (presenceError) {
            const msg = String(presenceError?.message || presenceError || '').slice(0, 160);
            extraLines.push(`⚠️ <b>Presence cleanup error:</b> <code>${esc(msg)}</code>`);
          }
        }
        const body = (() => {
          const main = extraLines.length ? [summaryParts, ...extraLines].join('\n') : summaryParts;
          if (!failureLines.length) return main;
          return [main, '', '<b>Failure samples</b>', ...failureLines].join('\n');
        })();
        await ctx.reply(body, { parse_mode: 'HTML' });
        const noticeParts = [
          '⚠️ Cleanup complete.',
          kicked.length ? `Removed ${kicked.length} member${kicked.length === 1 ? '' : 's'}.` : null,
          alreadyGone ? `${alreadyGone} already absent.` : null,
        ].filter(Boolean).join(' ');
        if (noticeParts) {
          try {
            // await ctx.api.sendMessage(chatId, noticeParts, { disable_web_page_preview: true });
          } catch {}
        }
        try {
          await logAction(ctx, {
            action: 'group_kick_all',
            action_type: 'admin',
            violation: '-',
            chat: { id: chatId, title: chat?.title, username: chat?.username },
            content: `removed=${kicked.length}; skipped_admins=${skippedAdmins}; skipped_bot=${skippedBot}; already_gone=${alreadyGone}; failures=${failures.length}; presence_removed=${presenceRemoved}; presence_error=${presenceError ? String(presenceError?.message || presenceError).slice(0, 120) : 'none'}; aborted=${aborted}`,
          });
        } catch {}
      } finally {
        currentState.completed = true;
        groupKickAbortState.delete(abortKey);
      }
    };

    const task = {
      type: 'group_kick_all',
      chatId,
      startedBy: ctx.from?.id,
      run: runPurge,
      cancel: ({ reason, abortedBy } = {}) => {
        currentState.abort = true;
        currentState.abortedBy = abortedBy ?? currentState.abortedBy;
        currentState.abortedAt = Date.now();
        currentState.completed = true;
        task.cancelled = true;
        groupKickAbortState.delete(abortKey);
      },
      onError: (err) => {
        try {
          ctx.reply(`❌ <b>Group purge failed:</b> <code>${esc(err?.message || err)}</code>`, { parse_mode: 'HTML' });
        } catch {}
      },
    };

    const idleBefore = isQueueIdle();
    enqueueTask(task, { priority: 'critical' });
    if (!idleBefore) {
      await ctx.reply('⏳ Another task is running. Your purge has been queued with priority.', { parse_mode: 'HTML' });
    }
  });

  composer.command('group_kick_all_abort', async (ctx) => {
    if (ctx.chat?.type !== 'private') {
      return ctx.reply('ℹ️ Run this command in a private chat with the bot.');
    }
    if (!(await isBotAdminOrOwner(ctx))) {
      return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    }
    const tokens = ctx.message.text.trim().split(/\s+/);
    const rawId = tokens[1];
    if (!rawId) {
      return ctx.reply('⚠️ <b>Usage:</b> <code>/group_kick_all_abort &lt;chat_id&gt;</code>', { parse_mode: 'HTML' });
    }
    const chatId = Number(rawId);
    if (!Number.isFinite(chatId)) {
      return ctx.reply('❌ <b>Invalid chat ID.</b> Provide a numeric ID like <code>-1001234567890</code>.', { parse_mode: 'HTML' });
    }
    const abortKey = String(chatId);
    const state = groupKickAbortState.get(abortKey);
    const queuedTask = findQueuedGroupKick(chatId);
    if (queuedTask && (!state || !state.started)) {
      const idx = taskQueue.indexOf(queuedTask);
      if (idx >= 0) taskQueue.splice(idx, 1);
      queuedTask.cancel?.({ abortedBy: ctx.from?.id });
      queuedTask.cancelled = true;
      groupKickAbortState.delete(abortKey);
      return ctx.reply('⛔ <b>Purge removed from queue before it started.</b>', { parse_mode: 'HTML' });
    }
    if (!state || state.completed) {
      return ctx.reply('ℹ️ <b>No active /group_kick_all run found for that chat.</b>', { parse_mode: 'HTML' });
    }
    if (state.abort) {
      return ctx.reply('ℹ️ <b>An abort has already been requested.</b>', { parse_mode: 'HTML' });
    }
    state.abort = true;
    state.abortedBy = ctx.from?.id ?? null;
    state.abortedAt = Date.now();
    return ctx.reply('⛔ <b>Abort requested.</b> The purge will stop after the current member is processed.', { parse_mode: 'HTML' });
  });

  composer.command('blacklist_add', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    const replyFrom = ctx.message?.reply_to_message?.from;
    const raw = ctx.message?.text?.replace(/^\/blacklist_add(?:@\w+)?\s*/i, '') || '';
    const parts = raw.split(/\s+/).filter(Boolean);
    let targetId = replyFrom?.id;
    let action = 'kick';
    const reasonParts = [];
    for (const tok of parts) {
      const lower = tok.toLowerCase();
      const num = Number(tok);
      if (!Number.isFinite(targetId) && Number.isFinite(num)) {
        targetId = num;
        continue;
      }
      if (lower === 'kick' || lower === 'mute') {
        action = lower;
        continue;
      }
      reasonParts.push(tok);
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('⚠️ <b>Usage:</b> <code>/blacklist_add &lt;user_id&gt; [kick|mute] [reason]</code> (or reply to a user).', { parse_mode: 'HTML' });
    }
    const reason = reasonParts.join(' ').trim();
    const entry = await setGlobalBlacklistEntry(targetId, {
      action,
      reason,
      addedBy: ctx.from?.id,
      addedAt: new Date().toISOString(),
    });
    const enforcement = await enforceBlacklistAcrossChats(ctx, targetId, entry.action);
    const lines = [
      `✅ <b>Added user</b> <code>${targetId}</code> to global blacklist.`,
      `• Action: <code>${esc(entry.action)}</code>`,
      reason ? `• Reason: <i>${esc(reason)}</i>` : null,
      enforcement.total ? `• Groups evaluated: <b>${enforcement.total}</b>` : '• No presence data; enforcement will trigger on next activity.',
      enforcement.applied.length ? `• Applied in: <b>${enforcement.applied.length}</b> group(s)` : null,
      enforcement.failures.length ? `• Failures: <b>${enforcement.failures.length}</b>` : null,
    ].filter(Boolean);
    if (enforcement.applied.length) {
      const sample = enforcement.applied.slice(0, 5).map((row) => `  ◦ ${esc(row.title || String(row.chatId))} (${row.mode})`);
      lines.push('<b>Applied samples</b>');
      lines.push(...sample);
      if (enforcement.applied.length > sample.length) lines.push(`  … ${enforcement.applied.length - sample.length} more`);
    }
    if (enforcement.failures.length) {
      const sampleFail = enforcement.failures.slice(0, 5).map((row) => `  ◦ ${esc(row.title || String(row.chatId))}: <code>${esc(row.reason)}</code>`);
      lines.push('<b>Failures</b>');
      lines.push(...sampleFail);
      if (enforcement.failures.length > sampleFail.length) lines.push(`  … ${enforcement.failures.length - sampleFail.length} more`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    try {
      await logAction(ctx, {
        action: 'global_blacklist_add',
        action_type: 'admin',
        violation: 'blacklist',
        user: { id: targetId },
        chat: ctx.chat,
        content: `action=${entry.action}; reason=${reason || '-'}; groups_total=${enforcement.total}; applied=${enforcement.applied.length}; failures=${enforcement.failures.length}`,
      });
    } catch {}
  });

  composer.command('blacklist_remove', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    const replyFrom = ctx.message?.reply_to_message?.from;
    const raw = ctx.message?.text?.replace(/^\/blacklist_remove(?:@\w+)?\s*/i, '') || '';
    const parts = raw.split(/\s+/).filter(Boolean);
    let targetId = replyFrom?.id;
    for (const tok of parts) {
      const num = Number(tok);
      if (!Number.isFinite(targetId) && Number.isFinite(num)) {
        targetId = num;
      }
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('⚠️ <b>Usage:</b> <code>/blacklist_remove &lt;user_id&gt;</code> (or reply to a user).', { parse_mode: 'HTML' });
    }
    const existed = await getBlacklistEntry(targetId);
    const removed = await removeGlobalBlacklistEntry(targetId);
    if (!removed) {
      return ctx.reply(`ℹ️ <b>User</b> <code>${targetId}</code> is not on the global blacklist.`, { parse_mode: 'HTML' });
    }
    await ctx.reply(`✅ <b>Removed</b> <code>${targetId}</code> from the global blacklist.`, { parse_mode: 'HTML' });
    try {
      await logAction(ctx, {
        action: 'global_blacklist_remove',
        action_type: 'admin',
        violation: 'blacklist',
        user: { id: targetId },
        chat: ctx.chat,
        content: `previous_action=${existed?.action || '-'}; had_entry=${existed ? 'yes' : 'no'}`,
      });
    } catch {}
  });

  composer.command('blacklist_list', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return ctx.reply('⛔ <b>Admins only</b>', { parse_mode: 'HTML' });
    const entries = await listGlobalBlacklist();
    if (!entries.length) {
      return ctx.reply('ℹ️ <b>The global blacklist is empty.</b>', { parse_mode: 'HTML' });
    }
    const lines = entries
      .sort((a, b) => (a.userId > b.userId ? 1 : -1))
      .slice(0, 50)
      .map((entry) => {
        const ts = entry.addedAt ? new Date(entry.addedAt).toISOString() : '-';
        const reason = entry.reason ? ` — <i>${esc(entry.reason)}</i>` : '';
        return `• <code>${entry.userId}</code> → <code>${esc(entry.action)}</code>${reason} (since ${esc(ts)})`;
      });
    if (entries.length > 50) {
      lines.push(`… ${entries.length - 50} more not shown`);
    }
    return ctx.reply(['<b>Global blacklist entries</b>', ...lines].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
  });
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
        await ctx.editMessageText(`<b>${esc(header)}</b>\n${esc(lines.join('\n'))}`, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
      } catch {
        await replyEphemeral(ctx, `<b>${esc(header)}</b>\n${esc(lines.join('\n'))}`, { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
      }
    } catch (_) { }
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
      return ctx.reply('💡 <b>Usage:</b> Reply to a user with <code>/botadmin_add</code>, or provide <code>/botadmin_add &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('🤖 Bots cannot be promoted to bot admin.', { parse_mode: 'HTML' });
    }
    await addBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_add', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Added bot admin: ${id}` });
    return ctx.reply(`✅ <b>Added bot admin:</b> <code>${id}</code>`, { parse_mode: 'HTML' });
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
      return ctx.reply('💡 <b>Usage:</b> Reply to a user with <code>/botadmin_remove</code>, or provide <code>/botadmin_remove &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('🤖 Bots are not in the bot admin list.', { parse_mode: 'HTML' });
    }
    await removeBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_remove', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Removed bot admin: ${id}` });
    return ctx.reply(`🗑️ <b>Removed bot admin:</b> <code>${id}</code>`, { parse_mode: 'HTML' });
  });

  // Global rule toggles (owner or bot admin)
  composer.command('rule_global_enable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`❓ <b>Unknown rule.</b> Use one of: <code>${RULE_KEYS.join(', ')}</code>`, { parse_mode: 'HTML' });
    await setGlobalRule(rule, true);
    await logAction(ctx, { action: 'rule_global_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} globally` });
    return ctx.reply(`✅ <b>Enabled</b> <code>${rule}</code> globally.`, { parse_mode: 'HTML' });
  });

  composer.command('rule_global_disable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`❓ <b>Unknown rule.</b> Use one of: <code>${RULE_KEYS.join(', ')}</code>`, { parse_mode: 'HTML' });
    await setGlobalRule(rule, false);
    await logAction(ctx, { action: 'rule_global_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} globally` });
    return ctx.reply(`🚫 <b>Disabled</b> <code>${rule}</code> globally.`, { parse_mode: 'HTML' });
  });

  // Chat rule toggles (chat admin with ban rights, or bot admin/owner)
  composer.command('rule_chat_enable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`❓ <b>Unknown rule.</b> Use one of: <code>${RULE_KEYS.join(', ')}</code>`, { parse_mode: 'HTML' });
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, true);
    await logAction(ctx, { action: 'rule_chat_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} for chat` });
    return ctx.reply(`✅ <b>Enabled</b> <code>${rule}</code> for this chat.`, { parse_mode: 'HTML' });
  });

  composer.command('rule_chat_disable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`❓ <b>Unknown rule.</b> Use one of: <code>${RULE_KEYS.join(', ')}</code>`, { parse_mode: 'HTML' });
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, false);
    await logAction(ctx, { action: 'rule_chat_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} for chat` });
    return ctx.reply(`🚫 <b>Disabled</b> <code>${rule}</code> for this chat.`, { parse_mode: 'HTML' });
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
    return replyEphemeral(ctx, `📋 <b>Rules status</b>\n${esc(msg)}`, { parse_mode: 'HTML' });
  });

  // Global and chat max_len setters
  composer.command('maxlen_global_set', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('💡 <b>Usage:</b> <code>/maxlen_global_set &lt;number&gt;</code>', { parse_mode: 'HTML' });
    await setGlobalMaxLenLimit(n);
    await logAction(ctx, { action: 'maxlen_global_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Global max_len=${Math.trunc(n)}` });
    return replyEphemeral(ctx, `✅ <b>Global max length limit:</b> <code>${Math.trunc(n)}</code>`, { parse_mode: 'HTML' });
  });

  composer.command('maxlen_chat_set', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('💡 <b>Usage:</b> <code>/maxlen_chat_set &lt;number&gt;</code>', { parse_mode: 'HTML' });
    await setChatMaxLenLimit(String(ctx.chat.id), n);
    await logAction(ctx, { action: 'maxlen_chat_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Chat max_len=${Math.trunc(n)}` });
    return replyEphemeral(ctx, `✅ <b>Chat max length limit:</b> <code>${Math.trunc(n)}</code>`, { parse_mode: 'HTML' });
  });

  // (auto-delete settings removed)

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
      return ctx.reply('💡 <b>Usage:</b> Reply to a user with <code>/whitelist_add</code>, or provide <code>/whitelist_add &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('🤖 Bots cannot be whitelisted.', { parse_mode: 'HTML' });
    }
    await addChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_add', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Whitelisted user ${targetId}` });
    return replyEphemeral(ctx, `✅ <b>Whitelisted</b> user <code>${targetId}</code> for this chat.`, { parse_mode: 'HTML' });
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
      return ctx.reply('💡 <b>Usage:</b> Reply to a user with <code>/whitelist_remove</code>, or provide <code>/whitelist_remove &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('🤖 Bots cannot be whitelisted.', { parse_mode: 'HTML' });
    }
    await removeChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_remove', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Removed user ${targetId} from whitelist` });
    return replyEphemeral(ctx, `🗑️ <b>Removed</b> user <code>${targetId}</code> from whitelist.`, { parse_mode: 'HTML' });
  });

  composer.command('whitelist_list', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const list = await getChatWhitelist(String(ctx.chat.id));
    if (!list.length) return replyEphemeral(ctx, 'ℹ️ <b>Whitelist is empty for this chat.</b>', { parse_mode: 'HTML' });
    return replyEphemeral(ctx, `✅ <b>Whitelisted user IDs:</b>\n${list.map((id)=>`• <code>${id}</code>`).join('\n')}`, { parse_mode: 'HTML' });
  });

  // Bot command menu management
  // Set up command list for users and for all chat administrators
  composer.command('set_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      // Default (all users) concise commands
      await ctx.api.setMyCommands(defaultCommands, { scope: { type: 'default' } });

      // Admin commands menu for all chat administrators
      await ctx.api.setMyCommands(adminCommands, { scope: { type: 'all_chat_administrators' } });

      // Owner-level commands (optional): set for all private chats to reduce clutter in groups
      await ctx.api.setMyCommands(ownerPrivateCommands, { scope: { type: 'all_private_chats' } });

      return replyEphemeral(ctx, '✅ <b>Bot commands have been set.</b>', { parse_mode: 'HTML' });
    } catch (e) {
      return replyEphemeral(ctx, `❌ <b>Failed to set commands:</b> <code>${esc(e?.description || e?.message || String(e))}</code>`, { parse_mode: 'HTML' });
    }
  });

  // Remove command menu (default and admin scopes)
  composer.command('remove_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      await ctx.api.deleteMyCommands({ scope: { type: 'default' } });
      await ctx.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });
      return replyEphemeral(ctx, '🗑️ <b>Bot commands have been removed.</b>', { parse_mode: 'HTML' });
    } catch (e) {
      return ctx.reply(`Failed to remove commands: ${e?.description || e?.message || e}`);
    }
  });

  return composer;
}
