import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RULES, RULE_KEYS, DEFAULT_LIMITS } from '../rules.js';

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

async function load() {
  await ensureFile();
  if (cache) return cache;
  const raw = await fs.readFile(FILE, 'utf8');
  cache = JSON.parse(raw);
  // Normalize missing fields
  cache.bot_admin_ids ||= [];
  cache.global_rules = { ...DEFAULT_RULES, ...(cache.global_rules || {}) };
  cache.chat_rules ||= {};
  cache.global_limits = { ...DEFAULT_LIMITS, ...(cache.global_limits || {}) };
  cache.chat_limits ||= {};
  cache.chat_whitelist ||= {};
  return cache;
}

async function save(current) {
  await ensureFile();
  cache = current;
  await withLock(() => fs.writeFile(FILE, JSON.stringify(current, null, 2)));
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
  const s = await load();
  if (!s.chat_rules[chatId]) s.chat_rules[chatId] = {};
  s.chat_rules[chatId][rule] = Boolean(enabled);
  await save(s);
}

export async function isRuleEnabled(rule, chatId) {
  const s = await load();
  const globalOn = s.global_rules[rule] ?? true;
  if (!globalOn) return false;
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
  const s = await load();
  if (!s.chat_limits[String(chatId)]) s.chat_limits[String(chatId)] = {};
  s.chat_limits[String(chatId)].max_len = limit;
  await save(s);
}

export async function getEffectiveMaxLen(chatId) {
  const s = await load();
  const chat = s.chat_limits[String(chatId)] || {};
  const chatLimit = chat.max_len;
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
  const s = await load();
  const key = String(chatId);
  if (!s.chat_whitelist[key]) s.chat_whitelist[key] = [];
  if (!s.chat_whitelist[key].includes(userId)) s.chat_whitelist[key].push(userId);
  await save(s);
}

export async function removeChatWhitelistUser(chatId, userId) {
  const s = await load();
  const key = String(chatId);
  if (!s.chat_whitelist[key]) return;
  s.chat_whitelist[key] = s.chat_whitelist[key].filter((id) => id !== userId);
  await save(s);
}

export async function isUserWhitelisted(chatId, userId) {
  const s = await load();
  const list = s.chat_whitelist[String(chatId)] || [];
  return list.includes(userId);
}

export async function getChatWhitelist(chatId) {
  const s = await load();
  return (s.chat_whitelist[String(chatId)] || []).slice();
}
