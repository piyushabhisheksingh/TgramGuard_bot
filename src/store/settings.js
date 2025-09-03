import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULES, RULE_KEYS, DEFAULT_LIMITS } from '../rules.js';
import { getSupabase } from './supabase.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

// Simple async mutex to serialize writes
let lock = Promise.resolve();
function withLock(fn) {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

async function ensureFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
  try {
    await fs.access(FILE);
  } catch {
    const initial = {
      bot_admin_ids: [],
      global_rules: { ...DEFAULT_RULES },
      chat_rules: {},
      global_limits: { ...DEFAULT_LIMITS },
      chat_limits: {},
      chat_whitelist: {},
    };
    await fs.writeFile(FILE, JSON.stringify(initial, null, 2));
  }
}

let cache = null;
const USE_SUPABASE = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const CHAT_CACHE_TTL_MS = Number(process.env.CHAT_SETTINGS_TTL_MS || 30000);

// Per-chat in-memory cache to reduce Supabase round trips
// Map<chatId, { until: number, data: { rules: object, limits: object, whitelist: number[] } }>
const chatCache = new Map();

// Supabase: global settings stored in table bot_settings, key='settings'
async function sbLoad() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('bot_settings')
    .select('data')
    .eq('key', 'settings')
    .maybeSingle();
  if (error) {
    // If table missing or other error, fallback to file
    return null;
  }
  if (!data) return null;
  return data.data;
}

async function sbSave(current) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase
    .from('bot_settings')
    .upsert({ key: 'settings', data: current }, { onConflict: 'key' });
  return !error;
}

// Supabase: per-chat settings stored in table chat_settings (chat_id PK)
async function sbLoadChat(chatId) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('chat_settings')
    .select('rules, limits, whitelist')
    .eq('chat_id', String(chatId))
    .maybeSingle();
  if (error) return null;
  if (!data) return null;
  return {
    rules: data.rules || {},
    limits: data.limits || {},
    whitelist: data.whitelist || [],
  };
}

async function sbSaveChat(chatId, payload) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const row = {
    chat_id: String(chatId),
    rules: payload.rules || {},
    limits: payload.limits || {},
    whitelist: payload.whitelist || [],
  };
  const { error } = await supabase
    .from('chat_settings')
    .upsert(row, { onConflict: 'chat_id' });
  if (error) return false;
  // write-through cache on success
  const now = Date.now();
  chatCache.set(String(chatId), { until: now + CHAT_CACHE_TTL_MS, data: { ...row, chat_id: undefined } });
  return true;
}

async function getChatSettingsCached(chatId) {
  const key = String(chatId);
  const now = Date.now();
  const cached = chatCache.get(key);
  if (cached && cached.until > now) return cached.data;
  const fresh = (await sbLoadChat(chatId)) || { rules: {}, limits: {}, whitelist: [] };
  chatCache.set(key, { until: now + CHAT_CACHE_TTL_MS, data: fresh });
  return fresh;
}

async function load() {
  if (cache) return cache;
  // Prefer Supabase if configured
  if (USE_SUPABASE) {
    const fromSb = await sbLoad();
    if (fromSb) {
      cache = normalize(fromSb);
      return cache;
    }
  }
  await ensureFile();
  const raw = await fs.readFile(FILE, 'utf8');
  cache = JSON.parse(raw);
  cache = normalize(cache);
  return cache;
}

function normalize(s) {
  const out = { ...s };
  // Normalize missing fields
  out.bot_admin_ids ||= [];
  out.global_rules = { ...DEFAULT_RULES, ...(out.global_rules || {}) };
  out.chat_rules ||= {};
  out.global_limits = { ...DEFAULT_LIMITS, ...(out.global_limits || {}) };
  out.chat_limits ||= {};
  out.chat_whitelist ||= {};
  return out;
}

async function save(current) {
  cache = normalize(current);
  // Try Supabase first if enabled
  if (USE_SUPABASE) {
    const ok = await sbSave(cache);
    if (ok) return;
  }
  await ensureFile();
  await withLock(() => fs.writeFile(FILE, JSON.stringify(cache, null, 2)));
}

export async function getSettings() {
  const s = await load();
  return JSON.parse(JSON.stringify(s));
}

export async function addBotAdmin(userId) {
  const s = await load();
  if (!s.bot_admin_ids.includes(userId)) s.bot_admin_ids.push(userId);
  await save(s);
}

export async function removeBotAdmin(userId) {
  const s = await load();
  s.bot_admin_ids = s.bot_admin_ids.filter((x) => x !== userId);
  await save(s);
}

export async function setGlobalRule(rule, enabled) {
  if (!RULE_KEYS.includes(rule)) throw new Error('Unknown rule');
  const s = await load();
  s.global_rules[rule] = Boolean(enabled);
  await save(s);
}

export async function setChatRule(chatId, rule, enabled) {
  if (!RULE_KEYS.includes(rule)) throw new Error('Unknown rule');
  if (USE_SUPABASE) {
    const current = await getChatSettingsCached(chatId);
    current.rules[rule] = Boolean(enabled);
    await sbSaveChat(chatId, current);
    return;
  }
  const s = await load();
  if (!s.chat_rules[chatId]) s.chat_rules[chatId] = {};
  s.chat_rules[chatId][rule] = Boolean(enabled);
  await save(s);
}

export async function isRuleEnabled(rule, chatId) {
  const s = await load();
  const globalOn = s.global_rules[rule] ?? true;
  if (!globalOn) return false;
  if (USE_SUPABASE) {
    const chat = (await getChatSettingsCached(chatId))?.rules || {};
    const chatFlag = chat[rule];
    return chatFlag === undefined ? true : Boolean(chatFlag);
  }
  const chat = s.chat_rules[String(chatId)] || {};
  const chatFlag = chat[rule];
  return chatFlag === undefined ? true : Boolean(chatFlag);
}

export async function getEffectiveRules(chatId) {
  const res = {};
  for (const k of RULE_KEYS) res[k] = await isRuleEnabled(k, chatId);
  return res;
}

// Bootstrap from env on first load
export async function bootstrapAdminsFromEnv(envOwnerId, envAdminsSet) {
  const s = await load();
  let changed = false;
  if (envAdminsSet && envAdminsSet.size) {
    for (const id of envAdminsSet) {
      if (!s.bot_admin_ids.includes(id)) {
        s.bot_admin_ids.push(id);
        changed = true;
      }
    }
  }
  // Owner is implicitly privileged; no need to store, but include if requested
  if (Number.isFinite(envOwnerId) && !s.bot_admin_ids.includes(envOwnerId)) {
    s.bot_admin_ids.push(envOwnerId);
    changed = true;
  }
  if (changed) await save(s);
}

// Limits API
export async function setGlobalMaxLenLimit(n) {
  const limit = normalizeLimit(n);
  const s = await load();
  s.global_limits.max_len = limit;
  await save(s);
}

export async function setChatMaxLenLimit(chatId, n) {
  const limit = normalizeLimit(n);
  if (USE_SUPABASE) {
    const current = await getChatSettingsCached(chatId);
    current.limits.max_len = limit;
    await sbSaveChat(chatId, current);
    return;
  }
  const s = await load();
  if (!s.chat_limits[String(chatId)]) s.chat_limits[String(chatId)] = {};
  s.chat_limits[String(chatId)].max_len = limit;
  await save(s);
}

export async function getEffectiveMaxLen(chatId) {
  const s = await load();
  let chatLimit;
  if (USE_SUPABASE) {
    const chat = (await getChatSettingsCached(chatId))?.limits || {};
    chatLimit = chat.max_len;
  } else {
    const chat = s.chat_limits[String(chatId)] || {};
    chatLimit = chat.max_len;
  }
  const globalLimit = s.global_limits.max_len ?? DEFAULT_LIMITS.max_len;
  return Number.isFinite(chatLimit) ? chatLimit : globalLimit;
}

function normalizeLimit(n) {
  const num = Number(n);
  const MAX = 4096; // Telegram hard cap for text messages
  const MIN = 1;
  if (!Number.isFinite(num)) return DEFAULT_LIMITS.max_len;
  return Math.max(MIN, Math.min(MAX, Math.trunc(num)));
}

// Whitelist API (per chat)
export async function addChatWhitelistUser(chatId, userId) {
  if (USE_SUPABASE) {
    const current = await getChatSettingsCached(chatId);
    if (!current.whitelist.includes(userId)) current.whitelist.push(userId);
    await sbSaveChat(chatId, current);
    return;
  }
  const s = await load();
  const key = String(chatId);
  if (!s.chat_whitelist[key]) s.chat_whitelist[key] = [];
  if (!s.chat_whitelist[key].includes(userId)) s.chat_whitelist[key].push(userId);
  await save(s);
}

export async function removeChatWhitelistUser(chatId, userId) {
  if (USE_SUPABASE) {
    const current = await getChatSettingsCached(chatId);
    current.whitelist = current.whitelist.filter((id) => id !== userId);
    await sbSaveChat(chatId, current);
    return;
  }
  const s = await load();
  const key = String(chatId);
  if (!s.chat_whitelist[key]) return;
  s.chat_whitelist[key] = s.chat_whitelist[key].filter((id) => id !== userId);
  await save(s);
}

export async function isUserWhitelisted(chatId, userId) {
  if (USE_SUPABASE) {
    const list = (await getChatSettingsCached(chatId))?.whitelist || [];
    return list.includes(userId);
  }
  const s = await load();
  const list = s.chat_whitelist[String(chatId)] || [];
  return list.includes(userId);
}

export async function getChatWhitelist(chatId) {
  if (USE_SUPABASE) {
    const list = (await getChatSettingsCached(chatId))?.whitelist || [];
    return list.slice();
  }
  const s = await load();
  return (s.chat_whitelist[String(chatId)] || []).slice();
}

// Additional helpers for status UIs
export async function getChatRules(chatId) {
  if (USE_SUPABASE) {
    return ((await getChatSettingsCached(chatId))?.rules) || {};
  }
  const s = await load();
  return s.chat_rules[String(chatId)] || {};
}

export async function getChatMaxLen(chatId) {
  if (USE_SUPABASE) {
    return (await getChatSettingsCached(chatId))?.limits?.max_len;
  }
  const s = await load();
  return s.chat_limits[String(chatId)]?.max_len;
}
