import fs from 'node:fs/promises';
import path from 'node:path';
import { getSupabase } from './supabase.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'health.json');

async function ensureFile() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
  try { await fs.access(FILE); }
  catch {
    const initial = { user_profiles: {}, opt_out: [] };
    await fs.writeFile(FILE, JSON.stringify(initial, null, 2));
  }
}

let cache = null;
const USE_SUPABASE = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
let LAST_USER_ID = null; // hint for save() when using Supabase
// Supabase optimization knobs
const HYDRATE_TTL_MS = Number(process.env.HEALTH_SB_USER_TTL_MS || 5 * 60 * 1000); // 5m
const SAVE_DEBOUNCE_MS = Number(process.env.HEALTH_SB_SAVE_DEBOUNCE_MS || 3000); // 3s
const OPTOUT_TTL_MS = Number(process.env.HEALTH_SB_OPTOUT_TTL_MS || 5 * 60 * 1000); // 5m
// In-memory caches
const hydrateMeta = new Map(); // userId -> { until }
const saveTimers = new Map(); // userId -> Timeout
const optOutCache = new Map(); // userId -> { until, value }

async function load() {
  if (cache) return cache;
  await ensureFile();
  const raw = await fs.readFile(FILE, 'utf8');
  cache = JSON.parse(raw);
  if (!cache.user_profiles) cache.user_profiles = {};
  if (!cache.opt_out) cache.opt_out = [];
  return cache;
}

async function save(current) {
  cache = current;
  // If Supabase is enabled, persist only the last modified user's document.
  if (USE_SUPABASE && LAST_USER_ID != null) {
    try {
      const uid = String(LAST_USER_ID);
      const doc = cache.user_profiles?.[uid];
      if (doc) {
        // Debounced per-user save to reduce write amplification
        scheduleSave(uid, doc);
      }
      return;
    } catch {}
  }
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
}

function todayKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function ensureProfile(s, userId) {
  const key = String(userId);
  let p = s.user_profiles[key];
  if (!p) {
    p = {
      last_seen: null,
      last_active_ts: null,
      total_events: 0,
      messages: 0,
      edits: 0,
      callbacks: 0,
      polls: 0,
      chars_sum: 0,
      activity_by_hour: Array.from({ length: 24 }, () => 0),
      sessions_by_hour: Array.from({ length: 24 }, () => 0),
      session_count: 0,
      daily_counts: {}, // day -> count
      // Profile tracking
      profile: {
        first_name: '',
        last_name: '',
        username: '',
        bio: '',
        last_checked_ts: null,
        changes: {
          name: 0,
          username: 0,
          bio: 0,
        },
        history: [], // [{when, first_name, last_name, username, bio}]
        last_change_ts: null,
      },
      // Communication style metrics (literal analysis aggregates)
      comms: {
        msgs: 0,
        words: 0,
        chars: 0,
        emojis: 0,
        excls: 0,
        questions: 0,
        links: 0,
        uppercase_chars: 0,
        analyzed: 0,
        toxicity_sum: 0, // from AI moderation if available
        sexual_sum: 0,
        polite_hits: 0,
        toxic_hits: 0,
      },
    };
    s.user_profiles[key] = p;
  }
  return p;
}

// ---------- Supabase helpers (per-user rows) ----------
async function sbLoadUser(userId) {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from('health_profiles')
      .select('data')
      .eq('user_id', String(userId))
      .maybeSingle();
    if (error) return null;
    return data?.data || null;
  } catch {
    return null;
  }
}

async function sbSaveUser(userId, data) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const row = { user_id: String(userId), data };
    const { error } = await sb
      .from('health_profiles')
      .upsert(row, { onConflict: 'user_id' });
    return !error;
  } catch {
    return false;
  }
}

async function sbIsOptedOut(userId) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const { data, error } = await sb
      .from('health_optout')
      .select('user_id')
      .eq('user_id', String(userId))
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

async function sbSetOptOut(userId, flag) {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    if (flag) {
      const { error } = await sb
        .from('health_optout')
        .upsert({ user_id: String(userId) }, { onConflict: 'user_id' });
      // Update local cache
      optOutCache.set(String(userId), { until: Date.now() + OPTOUT_TTL_MS, value: true });
      return !error;
    } else {
      const { error } = await sb
        .from('health_optout')
        .delete()
        .eq('user_id', String(userId));
      optOutCache.set(String(userId), { until: Date.now() + OPTOUT_TTL_MS, value: false });
      return !error;
    }
  } catch {
    return false;
  }
}

export async function isOptedOut(userId) {
  if (USE_SUPABASE) {
    const key = String(userId);
    const c = optOutCache.get(key);
    const now = Date.now();
    if (c && c.until > now) return Boolean(c.value);
    const v = await sbIsOptedOut(userId);
    optOutCache.set(key, { until: now + OPTOUT_TTL_MS, value: Boolean(v) });
    return Boolean(v);
  }
  const s = await load();
  return s.opt_out.includes(String(userId));
}

export async function setOptOut(userId, flag) {
  if (USE_SUPABASE) { await sbSetOptOut(userId, flag); return; }
  const s = await load();
  const id = String(userId);
  const i = s.opt_out.indexOf(id);
  if (flag) { if (i === -1) s.opt_out.push(id); }
  else if (i !== -1) s.opt_out.splice(i, 1);
  await save(s);
}

function countEmojiLike(str = '') {
  let c = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f300 && cp <= 0x1fbff) c += 1;
  }
  return c;
}

function hasLinkQuick(s = '') {
  return /(https?:\/\/|t\.me\/|telegram\.me\/|www\.|@\w+)/i.test(String(s));
}

export async function recordActivity({ userId, chatId, type = 'message', textLen = 0, when = new Date(), content = '' }) {
  if (!Number.isFinite(userId) || !Number.isFinite(chatId)) return;
  const s = await load();
  await sbEnsureUserLoaded(userId, s);
  if (s.opt_out.includes(String(userId))) return;
  const p = ensureProfile(s, userId);
  LAST_USER_ID = String(userId);
  const now = new Date(when);
  const nowIso = now.toISOString();
  p.last_seen = nowIso;
  p.total_events += 1;
  if (type === 'message') p.messages += 1;
  else if (type === 'edit') p.edits += 1;
  else if (type === 'callback') p.callbacks += 1;
  else if (type === 'poll') p.polls += 1;
  if (Number.isFinite(textLen)) p.chars_sum += Math.max(0, textLen || 0);
  const hour = now.getHours();
  if (hour >= 0 && hour < 24) p.activity_by_hour[hour] = (p.activity_by_hour[hour] || 0) + 1;
  const day = todayKey(now);
  p.daily_counts[day] = (p.daily_counts[day] || 0) + 1;
  // Session tracking: new session if gap > threshold
  const gapMs = Number(process.env.HEALTH_SESSION_GAP_MS || 15 * 60 * 1000);
  const prevTs = p.last_active_ts ? Date.parse(p.last_active_ts) : 0;
  if (!Number.isFinite(prevTs) || now.getTime() - prevTs > gapMs) {
    p.session_count += 1;
    if (hour >= 0 && hour < 24) p.sessions_by_hour[hour] = (p.sessions_by_hour[hour] || 0) + 1;
  }
  p.last_active_ts = nowIso;
  // Communication analysis for provided content
  const text = typeof content === 'string' ? content : '';
  if (text) {
    const comms = p.comms;
    comms.msgs += 1;
    comms.chars += text.length;
    comms.words += (text.match(/[\p{L}\p{N}\-_']+/gu) || []).length;
    comms.emojis += countEmojiLike(text);
    comms.excls += (text.match(/!/g) || []).length;
    comms.questions += (text.match(/\?/g) || []).length;
    comms.links += hasLinkQuick(text) ? 1 : 0;
    const uppers = (text.match(/[A-ZÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜŸÇÑ]/g) || []).length;
    comms.uppercase_chars += uppers;
    // Simple politeness/toxicity keyword counts (fallback if AI unavailable)
    const low = text.toLowerCase();
    comms.polite_hits += (low.match(/\b(please|plz|thank(s| you)?|kindly|regards)\b/g) || []).length;
    comms.toxic_hits += (low.match(/\b(stupid|idiot|dumb|shut up|fuck|bitch|moron)\b/g) || []).length;
  }
  // Retain only last 60 days in daily_counts
  const keys = Object.keys(p.daily_counts).sort();
  const excess = Math.max(0, keys.length - 60);
  for (let i = 0; i < excess; i++) delete p.daily_counts[keys[i]];
  await save(s);
}

export async function getUserSummary(userId) {
  const s = await load();
  await sbEnsureUserLoaded(userId, s);
  const p = s.user_profiles[String(userId)];
  if (!p) return null;
  // Compute last 7d and 30d counts
  const now = new Date();
  const daysBack = (n) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return todayKey(d);
  };
  let w7 = 0, w30 = 0, streak = 0;
  for (let i = 0; i < 30; i++) {
    const key = daysBack(i);
    const c = p.daily_counts[key] || 0;
    if (i < 7) w7 += c;
    w30 += c;
    if (c > 0 && streak === i) streak += 1; // consecutive from today backwards
  }
  // Top active hours
  const hours = p.activity_by_hour.map((v, h) => ({ h, v })).sort((a, b) => (b.v - a.v));
  const topHours = hours.slice(0, 3).filter(x => x.v > 0).map(x => x.h);
  const avgLen = p.messages ? Math.round(p.chars_sum / p.messages) : 0;
  const sessionsByHour = (p.sessions_by_hour || []).slice();
  const totalSessions = sessionsByHour.reduce((a, b) => a + (b || 0), 0);
  const lateSessions = sessionsByHour.reduce((acc, v, h) => acc + ((h <= 5 || h >= 22) ? (v || 0) : 0), 0);
  return {
    last_seen: p.last_seen,
    last_active_ts: p.last_active_ts,
    totals: { events: p.total_events, messages: p.messages, edits: p.edits, callbacks: p.callbacks, polls: p.polls },
    week_count: w7,
    month_count: w30,
    streak_days: streak,
    top_hours: topHours,
    avg_message_len: avgLen,
    activity_by_hour: p.activity_by_hour.slice(),
    sessions: { total: totalSessions, by_hour: sessionsByHour, late_total: lateSessions },
    profile: p.profile,
    comms: { ...p.comms },
  };
}

export async function applyAIMetrics(userId, { toxicity = 0, sexual = 0 } = {}) {
  if (!Number.isFinite(userId)) return;
  const s = await load();
  await sbEnsureUserLoaded(userId, s);
  const p = ensureProfile(s, userId);
  LAST_USER_ID = String(userId);
  const c = p.comms;
  c.analyzed += 1;
  c.toxicity_sum += Math.max(0, Number(toxicity) || 0);
  c.sexual_sum += Math.max(0, Number(sexual) || 0);
  await save(s);
}

export async function getUserProfile(userId) {
  const s = await load();
  await sbEnsureUserLoaded(userId, s);
  const p = ensureProfile(s, userId);
  return p.profile;
}

export async function recordProfileSnapshot({ userId, first_name = '', last_name = '', username = '', bio = '', when = new Date() }) {
  if (!Number.isFinite(userId)) return;
  const s = await load();
  await sbEnsureUserLoaded(userId, s);
  if (s.opt_out.includes(String(userId))) return;
  const p = ensureProfile(s, userId);
  LAST_USER_ID = String(userId);
  const pr = p.profile;
  const nowIso = new Date(when).toISOString();
  let changed = false;
  if (String(first_name) !== pr.first_name || String(last_name) !== pr.last_name) {
    pr.changes.name += 1;
    changed = true;
  }
  if (String(username || '') !== pr.username) {
    pr.changes.username += 1;
    changed = true;
  }
  if (String(bio || '') !== pr.bio) {
    pr.changes.bio += 1;
    changed = true;
  }
  if (changed) {
    pr.last_change_ts = nowIso;
    pr.history.push({ when: nowIso, first_name: String(first_name || ''), last_name: String(last_name || ''), username: String(username || ''), bio: String(bio || '') });
    // Keep last 10 snapshots
    if (pr.history.length > 10) pr.history.splice(0, pr.history.length - 10);
  }
  pr.first_name = String(first_name || '');
  pr.last_name = String(last_name || '');
  pr.username = String(username || '');
  pr.bio = String(bio || '');
  pr.last_checked_ts = nowIso;
  await save(s);
}

// ---------- Local helpers for hydration and debounced saving ----------
async function sbEnsureUserLoaded(userId, state) {
  if (!USE_SUPABASE) return;
  const key = String(userId);
  const now = Date.now();
  const meta = hydrateMeta.get(key);
  if (meta && meta.until > now && state.user_profiles && state.user_profiles[key]) return;
  try {
    const existing = await sbLoadUser(userId);
    if (existing) {
      if (!state.user_profiles) state.user_profiles = {};
      state.user_profiles[key] = existing;
    }
    hydrateMeta.set(key, { until: now + HYDRATE_TTL_MS });
  } catch {
    hydrateMeta.set(key, { until: now + HYDRATE_TTL_MS });
  }
}

function scheduleSave(userId, doc) {
  if (!USE_SUPABASE) return;
  const key = String(userId);
  if (saveTimers.has(key)) return;
  const t = setTimeout(async () => {
    saveTimers.delete(key);
    try { await sbSaveUser(key, doc); } catch {}
  }, SAVE_DEBOUNCE_MS);
  // In Node, unref timer to not block shutdown
  if (typeof t.unref === 'function') t.unref();
  saveTimers.set(key, t);
}
