// Simple centralized logger to send moderation/admin actions to a log chat
// Configure via env:
// - LOG_CHAT_ID: Telegram chat ID (group/channel) where logs will be sent
// - LOG_ENABLE: true/1/yes/on to enable (defaults to enabled if LOG_CHAT_ID present)
// Stats persistence:
// - If Supabase is configured, daily per-bot and per-chat counters are stored and used for daily/weekly stats.

function boolFromEnv(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatUser(user) {
  if (!user) return '-';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'user';
  const mention = user.id ? `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>` : escapeHtml(name);
  const uname = user.username ? ` (@${escapeHtml(user.username)})` : '';
  return `${mention}${uname} [${user.id ?? '?'}]`;
}

function formatChat(chat) {
  if (!chat) return '-';
  const title = escapeHtml(chat.title || '');
  const id = chat.id ?? '?';
  let link = '';
  if (chat.username) {
    const u = escapeHtml(chat.username);
    link = ` — <a href="https://t.me/${u}">@${u}</a>`;
  }
  return `${title} [${id}]${link}`;
}

// --- In‑memory stats ---
const stats = {
  total: 0,
  byViolation: Object.create(null),
  byAction: Object.create(null),
  perChat: new Map(), // chatId -> { total, byViolation: {}, byAction: {} }
};

function inc(mapObj, key, n = 1) {
  if (!key) key = '-';
  mapObj[key] = (mapObj[key] || 0) + n;
}

function getOrInitChatStats(chatId) {
  const id = String(chatId);
  let cs = stats.perChat.get(id);
  if (!cs) {
    cs = { total: 0, byViolation: Object.create(null), byAction: Object.create(null) };
    stats.perChat.set(id, cs);
  }
  return cs;
}

export function getBotStats() {
  return {
    total: stats.total,
    byViolation: { ...stats.byViolation },
    byAction: { ...stats.byAction },
  };
}

export function getGroupStats(chatId) {
  const cs = getOrInitChatStats(chatId);
  return {
    chatId: String(chatId),
    total: cs.total,
    byViolation: { ...cs.byViolation },
    byAction: { ...cs.byAction },
  };
}

// --- Recent logs ring buffer (for UI) ---
const RECENT_CAP = Number(process.env.RECENT_LOGS_CAP || 1000);
const recentLogs = [];

export function getRecentLogs(limit = 100, chatId = null) {
  const n = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (chatId == null) return recentLogs.slice(0, n);
  const cid = String(chatId);
  const out = [];
  for (const row of recentLogs) {
    if (row.chat?.id === cid) out.push(row);
    if (out.length >= n) break;
  }
  return out;
}

function recordStats(details, chat) {
  const v = details.violation || '-';
  const a = details.action || 'action';
  stats.total += 1;
  inc(stats.byViolation, v);
  inc(stats.byAction, a);
  if (chat?.id != null) {
    const cs = getOrInitChatStats(chat.id);
    cs.total += 1;
    inc(cs.byViolation, v);
    inc(cs.byAction, a);
  }
}

// ---------- Supabase persistence for stats ----------
import { getSupabase } from './store/supabase.js';
import crypto from 'node:crypto';

function dayKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`; // YYYY-MM-DD (UTC)
}

function mergeCountersRow(row, incAction, incViolation) {
  const out = {
    total: (row?.total || 0) + 1,
    by_violation: { ...(row?.by_violation || {}) },
    by_action: { ...(row?.by_action || {}) },
  };
  out.by_violation[incViolation || '-'] = (out.by_violation[incViolation || '-'] || 0) + 1;
  out.by_action[incAction || 'action'] = (out.by_action[incAction || 'action'] || 0) + 1;
  return out;
}

async function sbUpsertGlobalDaily(dateStr, action, violation) {
  const sb = getSupabase();
  if (!sb) return;
  const { data, error } = await sb
    .from('stats_global_daily')
    .select('day,total,by_violation,by_action')
    .eq('day', dateStr)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') return; // ignore
  const merged = mergeCountersRow(data, action, violation);
  await sb
    .from('stats_global_daily')
    .upsert({ day: dateStr, ...merged, updated_at: new Date().toISOString() }, { onConflict: 'day' });
}

async function sbUpsertChatDaily(chatId, dateStr, action, violation) {
  const sb = getSupabase();
  if (!sb) return;
  const { data, error } = await sb
    .from('stats_chat_daily')
    .select('chat_id,day,total,by_violation,by_action')
    .eq('chat_id', String(chatId))
    .eq('day', dateStr)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') return;
  const merged = mergeCountersRow(data, action, violation);
  await sb
    .from('stats_chat_daily')
    .upsert({ chat_id: String(chatId), day: dateStr, ...merged, updated_at: new Date().toISOString() }, { onConflict: 'chat_id,day' });
}

async function sbUpsertUserDaily(userId, chatId, dateStr, action, violation) {
  const sb = getSupabase();
  if (!sb) return;
  const { data, error } = await sb
    .from('stats_user_daily')
    .select('user_id,chat_id,day,total,by_violation,by_action')
    .eq('user_id', String(userId))
    .eq('chat_id', String(chatId))
    .eq('day', dateStr)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') return;
  const merged = mergeCountersRow(data, action, violation);
  await sb
    .from('stats_user_daily')
    .upsert({ user_id: String(userId), chat_id: String(chatId), day: dateStr, ...merged, updated_at: new Date().toISOString() }, { onConflict: 'user_id,chat_id,day' });
}

async function recordStatsSupabase(details, chat) {
  const sb = getSupabase();
  if (!sb) return;
  const action = details.action || 'action';
  const violation = details.violation || '-';
  const today = dayKey(new Date());
  try {
    await sbUpsertGlobalDaily(today, action, violation);
    if (chat?.id != null) {
      await sbUpsertChatDaily(chat.id, today, action, violation);
    }
    if (details.user?.id && chat?.id != null) {
      await sbUpsertUserDaily(details.user.id, chat.id, today, action, violation);
    }
  } catch {
    // ignore persistence errors
  }
}

// Optional Supabase-backed logs reader if a table exists
export async function getRecentLogsSupabase(limit = 100, chatId = null) {
  const sb = getSupabase();
  if (!sb) return null;
  const table = process.env.LOGS_TABLE || 'moderation_logs';
  try {
    let q = sb
      .from(table)
      .select('ts,created_at,action,action_type,violation,chat_id,chat_title,chat_username,user_id,user_first_name,user_last_name,user_username,content,group_link')
      .order('ts', { ascending: false })
      .limit(Math.max(1, Math.min(Number(limit) || 100, 500)));
    if (chatId != null) q = q.eq('chat_id', String(chatId));
    const { data, error } = await q;
    if (error) return null;
    const rows = (data || []).map((r) => ({
      ts: r.ts || r.created_at || new Date().toISOString(),
      action: r.action,
      actionType: r.action_type,
      violation: r.violation,
      chat: { id: String(r.chat_id || ''), title: r.chat_title, username: r.chat_username },
      user: r.user_id ? { id: Number(r.user_id), first_name: r.user_first_name, last_name: r.user_last_name, username: r.user_username } : undefined,
      content: r.content || '',
      group_link: r.group_link,
    }));
    return rows;
  } catch {
    return null;
  }
}

// --- Inline review support for explicit detections ---
const REVIEW_TTL_MS = Number(process.env.EXPLICIT_REVIEW_TTL_MS || 6 * 60 * 60 * 1000); // 6h
const reviewStore = new Map(); // id -> { until, text }

function createReview(text) {
  const id = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const until = Date.now() + REVIEW_TTL_MS;
  reviewStore.set(id, { until, text: String(text || '').slice(0, 4000) });
  return id;
}

export function consumeReview(id) {
  const entry = reviewStore.get(id);
  if (!entry) return null;
  reviewStore.delete(id);
  if (entry.until < Date.now()) return null;
  return entry;
}

export async function getBotStatsPeriod(days = 1) {
  const sb = getSupabase();
  if (!sb) return getBotStats();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const sinceStr = dayKey(since);
  const { data } = await sb
    .from('stats_global_daily')
    .select('day,total,by_violation,by_action')
    .gte('day', sinceStr)
    .order('day', { ascending: true });
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

// Convenience ranges for bot stats
export async function getBotMonthlyStats() {
  return getBotStatsPeriod(30);
}

export async function getBotYearlyStats() {
  return getBotStatsPeriod(365);
}

export async function getBotLifetimeStats() {
  const sb = getSupabase();
  if (!sb) {
    // Fallback: aggregate from all recent logs kept in memory
    const agg = { total: 0, byViolation: {}, byAction: {} };
    try {
      for (const row of recentLogs) {
        agg.total += 1;
        inc(agg.byViolation, row.violation || '-');
        inc(agg.byAction, row.action || 'action');
      }
    } catch {}
    return agg;
  }
  const { data } = await sb
    .from('stats_global_daily')
    .select('day,total,by_violation,by_action')
    .order('day', { ascending: true });
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

export async function getGroupStatsPeriod(chatId, days = 1) {
  const sb = getSupabase();
  if (!sb) return getGroupStats(chatId);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const sinceStr = dayKey(since);
  const { data } = await sb
    .from('stats_chat_daily')
    .select('day,total,by_violation,by_action')
    .eq('chat_id', String(chatId))
    .gte('day', sinceStr)
    .order('day', { ascending: true });
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

// Convenience ranges for group stats
export async function getGroupMonthlyStats(chatId) {
  return getGroupStatsPeriod(chatId, 30);
}

export async function getGroupYearlyStats(chatId) {
  return getGroupStatsPeriod(chatId, 365);
}

export async function getGroupLifetimeStats(chatId) {
  const sb = getSupabase();
  if (!sb) {
    // Fallback: aggregate from in-memory recent logs
    const agg = { total: 0, byViolation: {}, byAction: {} };
    try {
      const cid = String(chatId);
      for (const row of recentLogs) {
        if (String(row.chat?.id || '') !== cid) continue;
        agg.total += 1;
        inc(agg.byViolation, row.violation || '-');
        inc(agg.byAction, row.action || 'action');
      }
    } catch {}
    return agg;
  }
  const { data } = await sb
    .from('stats_chat_daily')
    .select('day,total,by_violation,by_action')
    .eq('chat_id', String(chatId))
    .order('day', { ascending: true });
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

export async function getUserStatsPeriod(userId, chatId, days = 7) {
  const sb = getSupabase();
  if (!sb) {
    // Fallback to empty if no DB
    return { total: 0, byViolation: {}, byAction: {} };
  }
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const sinceStr = dayKey(since);
  let q = sb
    .from('stats_user_daily')
    .select('day,total,by_violation,by_action')
    .eq('user_id', String(userId))
    .gte('day', sinceStr)
    .order('day', { ascending: true });
  if (chatId != null) q = q.eq('chat_id', String(chatId));
  const { data } = await q;
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

// Convenience ranges for user stats
export async function getUserMonthlyStats(userId, chatId) {
  return getUserStatsPeriod(userId, chatId, 30);
}

export async function getUserYearlyStats(userId, chatId) {
  return getUserStatsPeriod(userId, chatId, 365);
}

export async function getUserLifetimeStats(userId, chatId) {
  const sb = getSupabase();
  if (!sb) return { total: 0, byViolation: {}, byAction: {} };
  let q = sb
    .from('stats_user_daily')
    .select('total,by_violation,by_action')
    .eq('user_id', String(userId));
  if (chatId != null) q = q.eq('chat_id', String(chatId));
  const { data } = await q;
  const agg = { total: 0, byViolation: {}, byAction: {} };
  for (const row of data || []) {
    agg.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(agg.byViolation, k, v);
    for (const [k, v] of Object.entries(row.by_action || {})) inc(agg.byAction, k, v);
  }
  return agg;
}

export function computeRiskScore(byViolation = {}) {
  const weights = {
    no_explicit: 3,
    bio_block: 4,
    name_no_explicit: 2,
    no_links: 1,
    name_no_links: 1,
    no_edit: 1,
    max_len: 0.5,
    gap_cleanup: 0.1,
  };
  let score = 0;
  for (const [k, v] of Object.entries(byViolation)) {
    const w = weights[k] ?? 1;
    score += w * v;
  }
  return score;
}

export async function getTopViolators(days = 7, chatId = null, limit = 10) {
  const sb = getSupabase();
  if (!sb) return [];
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const sinceStr = dayKey(since);
  let q = sb
    .from('stats_user_daily')
    .select('user_id,chat_id,day,total,by_violation')
    .gte('day', sinceStr);
  if (chatId != null) q = q.eq('chat_id', String(chatId));
  const { data, error } = await q;
  if (error) return [];
  const agg = new Map(); // userId -> { total, byViolation }
  for (const row of data || []) {
    const uid = String(row.user_id);
    let u = agg.get(uid);
    if (!u) { u = { total: 0, byViolation: {} }; agg.set(uid, u); }
    u.total += row.total || 0;
    for (const [k, v] of Object.entries(row.by_violation || {})) inc(u.byViolation, k, v);
  }
  const arr = Array.from(agg.entries()).map(([userId, v]) => ({
    userId,
    total: v.total,
    byViolation: v.byViolation,
    risk: computeRiskScore(v.byViolation),
  }));
  arr.sort((a, b) => (b.total - a.total) || (b.risk - a.risk));
  return arr.slice(0, limit);
}

export async function getUserRiskSummary(userId, chatId) {
  const weekly = await getUserStatsPeriod(userId, chatId, 7);
  const score = computeRiskScore(weekly.byViolation);
  const label = score < 3 ? 'Low' : score < 10 ? 'Medium' : 'High';
  const top = Object.entries(weekly.byViolation)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))[0]?.[0] || '-';
  return { score, label, topViolation: top };
}

// Build a funny prefix using Hinglish/English synonyms per top violation, randomized
export function buildFunnyPrefix(riskLabel, topViolation) {
  const synonyms = {
    no_explicit: [
      'NSFW Ninja', 'Tharki Ustaad', 'Gandi Baat Guru', 'Sanskaar Breaker',
      'PG-13 Picasso', 'Filter Feku', 'Family-Friendly Fighter',
      'Besharam Baazigar', 'Emoji Evader', 'Adab-Tabaah Artist'
    ],
    bio_block: [
      'Bio Bandit', 'Jeevani Jugaadu', 'Bio Mein Dhandha', 'Profile Pe Popat',
      'About-Me Aficionado', 'Intro Inspector', 'Parichay Pundit'
    ],
    name_no_explicit: [
      'Name Nuisance', 'Naam Nalayak', 'Naam Ka Natija', 'Handle Houdini', 'Tag Troublemaker',
      'NaamKaNautanki', 'UPI-Id Ustaad'
    ],
    no_links: [
      'Link Lord', 'Spam Sardar', 'Jod-Tod Jockey', 'Linkbaaz', 'Backlink Baazigar', 'URL Ustaad',
      'Hyperlink Hira', 'Staple-Staple Sher'
    ],
    name_no_links: [
      'Handle Hustler', 'Naam-Linkbaaz', 'Tag Tycoon', 'Username Ustad'
    ],
    no_edit: [
      'Edit Enthusiast', 'U-turn Ustaad', 'Palti Prabhu', 'Undo Ustaad', 'Ctrl+Z Chacha'
    ],
    max_len: [
      'Storyteller', 'Kahaani Machine', 'Essay Expert', 'Paragraph Pandit', 'Typewriter Tycoon',
      'Lambi Kahaani Legend'
    ],
    gap_cleanup: [
      'Gap Gremlin', 'Khali-Jagah King', 'Time Traveller', 'Message Ninja', 'Between-Banter Baba'
    ],
    '-': ['Wildcard', 'Achanak Ajeeb', 'Vibe Variable', 'Andaz Ankahi'],
  };

  const labelEmojis = {
    High: ['🔥','🚨','💥','🧨','🥵'],
    Medium: ['⚠️','🔶','😬','🧐','🤨'],
    Low: ['🙂','🫡','👌','🧊','😌'],
  };
  const topicEmojis = {
    no_explicit: ['🙈','🥵','🍑','🚫'],
    bio_block: ['🧬','📝','🚫','🧾'],
    name_no_explicit: ['🏷️','🤐','🫣'],
    no_links: ['🔗','🚫','🖇️'],
    name_no_links: ['🏷️','🔗','🚫'],
    no_edit: ['✏️','↩️','📝'],
    max_len: ['📜','🧾','🗞️'],
    gap_cleanup: ['🧹','🕳️','🧽'],
    '-': ['🎭','🎲'],
  };

  // Hinglish suffixes to add more spice (picked occasionally)
  const suffixes = ['bhai', 'boss', 'ustad', 'yaar', 'bhidu', 'guru', 'champ'];

  const list = synonyms[topViolation] || synonyms['-'];
  const title = list[Math.floor(Math.random() * list.length)] || 'Wildcard';
  const e1list = labelEmojis[riskLabel] || labelEmojis.Low;
  const e2list = topicEmojis[topViolation] || topicEmojis['-'];
  const e1 = e1list[Math.floor(Math.random() * e1list.length)];
  const e2 = e2list[Math.floor(Math.random() * e2list.length)];
  const addSuffix = Math.random() < 0.5; // 50% chance to add a hinglish tag
  const tag = addSuffix ? ` ${suffixes[Math.floor(Math.random() * suffixes.length)]}` : '';
  return `[${riskLabel} · ${title}${tag}] ${e1}${e2} `;
}

export async function logAction(ctxOrApi, details = {}) {
  const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
  if (!LOG_CHAT_ID) return; // disabled if not configured
  const enabled = boolFromEnv(process.env.LOG_ENABLE || 'true');
  if (!enabled) return;

  const api = ctxOrApi?.api || ctxOrApi; // support ctx or api

  // Local time formatting (configurable)
  const now = new Date();
  const locale = process.env.LOG_TIME_LOCALE || 'en-IN'; // default to Indian English
  const timeZone = process.env.LOG_TIME_ZONE || 'Asia/Kolkata'; // default to IST
  const ts = now.toLocaleString(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const user = details.user || (ctxOrApi?.from || ctxOrApi?.msg?.from);
  const chat = details.chat || ctxOrApi?.chat;
  const action = details.action || 'action';
  const actionType = details.action_type || details.actionType || 'moderation';
  const violation = details.violation || '-';
  const groupLink = details.group_link;
  const contentRaw = typeof details.content === 'string' ? details.content : details.content?.text || '';
  const content = contentRaw ? escapeHtml(String(contentRaw).slice(0, 512)) : '';

  const lines = [];
  lines.push(`<b>Action:</b> ${escapeHtml(action)} (${escapeHtml(actionType)})`);
  lines.push(`<b>Violation:</b> ${escapeHtml(String(violation))}`);
  if (chat) lines.push(`<b>Group:</b> ${formatChat(chat)}`);
  if (groupLink) lines.push(`<b>Group Link:</b> <a href="${groupLink}">${escapeHtml(groupLink)}</a>`);
  if (user) lines.push(`<b>User:</b> ${formatUser(user)}`);
  if (content) lines.push(`<b>Content:</b> ${content}`);
  lines.push(`<b>Time:</b> ${escapeHtml(ts)}`);

  const html = lines.join('\n');
  try {
    // Attach inline review buttons for explicit detections
    let replyMarkup;
    if (violation === 'no_explicit' || violation === 'name_no_explicit') {
      const rid = createReview(contentRaw);
      replyMarkup = {
        inline_keyboard: [
          [ { text: 'Valid ✅', callback_data: `rv:ok:${rid}` } ],
          [ { text: 'Safelist Phrase', callback_data: `rv:addp:${rid}` }, { text: 'Safelist Words', callback_data: `rv:addw:${rid}` } ],
        ],
      };
    }
    const sent = await api.sendMessage(LOG_CHAT_ID, html, { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: replyMarkup });
    // Update in-memory stats after successful log
    recordStats({ action, violation }, chat);
    // Persist daily counters to Supabase (best-effort). Include user for per-user stats.
    await recordStatsSupabase({ action, violation, user }, chat);
    // Keep recent logs for UI
    try {
      const entry = {
        ts: new Date().toISOString(),
        action,
        actionType,
        violation,
        chat: { id: String(chat?.id ?? ''), title: chat?.title, username: chat?.username },
        user: user ? { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username } : undefined,
        content: contentRaw || '',
        group_link: groupLink,
      };
      recentLogs.unshift(entry);
      if (recentLogs.length > RECENT_CAP) recentLogs.length = RECENT_CAP;
    } catch {}
    return sent;
  } catch (_) {
    // Even if sending fails, attempt to record stats locally
    recordStats({ action, violation }, chat);
    await recordStatsSupabase({ action, violation, user }, chat);
    try {
      const entry = {
        ts: new Date().toISOString(),
        action,
        actionType,
        violation,
        chat: { id: String(chat?.id ?? ''), title: chat?.title, username: chat?.username },
        user: user ? { id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username } : undefined,
        content: contentRaw || '',
        group_link: groupLink,
      };
      recentLogs.unshift(entry);
      if (recentLogs.length > RECENT_CAP) recentLogs.length = RECENT_CAP;
    } catch {}
    return undefined;
  }
}

export async function logActionPinned(ctxOrApi, details = {}) {
  const sent = await logAction(ctxOrApi, details);
  const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
  if (!sent || !LOG_CHAT_ID) return;
  try {
    await (ctxOrApi.api || ctxOrApi).pinChatMessage(LOG_CHAT_ID, sent.message_id, { disable_notification: true });
  } catch (_) {}
}

// ---------- Presence tracking (distinct groups per user) ----------
export async function recordUserPresence(ctx) {
  const sb = getSupabase();
  if (!sb) return;
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!Number.isFinite(userId) || !Number.isFinite(chatId)) return;
  try {
    const nowIso = new Date().toISOString();
    await sb
      .from('user_chat_presence')
      .upsert(
        { user_id: String(userId), chat_id: String(chatId), first_seen: nowIso, last_seen: nowIso },
        { onConflict: 'user_id,chat_id' }
      );
    await sb
      .from('user_chat_presence')
      .update({ last_seen: nowIso })
      .eq('user_id', String(userId))
      .eq('chat_id', String(chatId));
  } catch {}
}

export async function getUserGroupCount(userId) {
  const sb = getSupabase();
  if (!sb) return 0;
  try {
    const { count } = await sb
      .from('user_chat_presence')
      .select('chat_id', { count: 'exact', head: true })
      .eq('user_id', String(userId));
    return count || 0;
  } catch {
    return 0;
  }
}

export async function getUserGroupLinks(ctxOrApi, userId, { limit = 20, offset = 0 } = {}) {
  const sb = getSupabase();
  if (!sb) return [];
  const api = ctxOrApi?.api || ctxOrApi;
  try {
    const start = Math.max(0, Number(offset) || 0);
    const end = start + Math.max(1, Number(limit) || 20) - 1;
    let q = sb
      .from('user_chat_presence')
      .select('chat_id')
      .eq('user_id', String(userId));
    const { data } = await q.range(start, end);
    const out = [];
    for (const row of data || []) {
      const chatId = Number(row.chat_id ?? row?.chatId);
      if (!Number.isFinite(chatId)) continue;
      let link = '';
      let title = '';
      if (api?.getChat) {
        try {
          const chat = await api.getChat(chatId);
          title = chat?.title || '';
          if (chat?.username) link = `https://t.me/${chat.username}`;
          if (!link) {
            try {
              const inv = await api.exportChatInviteLink(chatId);
              if (inv) link = inv;
            } catch {}
          }
        } catch {}
      }
      out.push({ chat_id: String(chatId), title, link });
    }
    return out;
  } catch {
    return [];
  }
}
