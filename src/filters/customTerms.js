import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getSupabase } from '../store/supabase.js';

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadTxtList(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    return lines.map((term) => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i'));
  } catch {
    return [];
  }
}

function loadJsonList(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data
        .map((entry) => {
          if (typeof entry === 'string') {
            // Support `/pattern/flags` or plain strings
            const m = entry.match(/^\s*\/(.*)\/([a-z]*)\s*$/i);
            if (m) {
              try { return new RegExp(m[1], m[2] || 'i'); } catch { return null; }
            }
            return new RegExp(`\\b${escapeRegex(entry)}\\b`, 'i');
          }
          return null;
        })
        .filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}

const DATA_DIR = path.join(process.cwd(), 'data');
const TXT_FILE = path.join(DATA_DIR, 'explicit_terms_custom.txt');
const JSON_FILE = path.join(DATA_DIR, 'explicit_terms_custom.json');

export const customExplicitTerms = [
  ...loadTxtList(TXT_FILE),
  ...loadJsonList(JSON_FILE),
];

// --- Custom safelist for normalized scanning ---
// We compile safe words to match against the normalized string used in containsExplicit
// Keep a lightweight normalization aligned with filters.normalizeForExplicit
function normalizeLite(s = '') {
  let t = String(s).toLowerCase();
  try { t = t.normalize('NFKD').replace(/\p{M}+/gu, ''); } catch {}
  // Remove separators and punctuation similar to normalized path
  t = t.replace(/[\s._\-|*`'"~^+\=\/\\()\[\]{}:,;<>]+/g, '');
  return t;
}

function loadSafeTxt(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    return lines.map((term) => new RegExp(escapeRegex(normalizeLite(term)), 'gi'));
  } catch { return []; }
}

function loadSafeJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .map((term) => (typeof term === 'string' ? new RegExp(escapeRegex(normalizeLite(term)), 'gi') : null))
      .filter(Boolean);
  } catch { return []; }
}

const SAFE_TXT = path.join(DATA_DIR, 'safe_terms_custom.txt');
const SAFE_JSON = path.join(DATA_DIR, 'safe_terms_custom.json');
// Optional: dedicated Indian names dictionary
const INDIAN_NAMES_TXT = path.join(DATA_DIR, 'indian_names.txt');
const INDIAN_NAMES_JSON = path.join(DATA_DIR, 'indian_names.json');
// Optional: dedicated English names dictionary
const ENGLISH_NAMES_TXT = path.join(DATA_DIR, 'english_names.txt');
const ENGLISH_NAMES_JSON = path.join(DATA_DIR, 'english_names.json');

// --- Optional: Load from installed NPM dictionary modules ---
const requireM = createRequire(import.meta.url);

function readMaybeFile(str = '') {
  try {
    if (typeof str !== 'string') return [];
    // Try as path to text file; if JSON, parse
    if (fs.existsSync(str)) {
      if (/\.json$/i.test(str)) {
        const raw = fs.readFileSync(str, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) return data.filter((x) => typeof x === 'string');
      }
      const raw = fs.readFileSync(str, 'utf8');
      return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
  } catch {}
  return [];
}

function extractStringsDeep(x, depth = 0) {
  if (depth > 3) return [];
  if (!x) return [];
  if (typeof x === 'string') return readMaybeFile(x);
  if (Array.isArray(x)) return x.filter((v) => typeof v === 'string');
  if (typeof x === 'object') {
    const out = [];
    for (const v of Object.values(x)) {
      out.push(...extractStringsDeep(v, depth + 1));
    }
    return out;
  }
  return [];
}

function loadModuleWordlist(moduleName) {
  try {
    const mod = requireM(moduleName);
    return extractStringsDeep(mod);
  } catch {
    return [];
  }
}

// Only whitelist dictionary terms that collide with risky substrings to avoid over-safelisting
const RISKY_SUBSTRINGS = ['shit', 'tit', 'ass', 'cum', 'gand', 'cock', 'dick'];

function buildSafeFromList(list = []) {
  try {
    const out = [];
    const seen = new Set();
    for (const term of list) {
      if (typeof term !== 'string') continue;
      const n = normalizeLite(term);
      if (!n) continue;
      if (!RISKY_SUBSTRINGS.some((r) => n.includes(r))) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(new RegExp(escapeRegex(n), 'gi'));
    }
    return out;
  } catch {
    return [];
  }
}
export const customSafePatternsNormalized = [
  ...loadSafeTxt(SAFE_TXT),
  ...loadSafeJson(SAFE_JSON),
  // If present, also load Indian names dictionary files
  ...loadSafeTxt(INDIAN_NAMES_TXT),
  ...loadSafeJson(INDIAN_NAMES_JSON),
  // If present, also load English names dictionary files
  ...loadSafeTxt(ENGLISH_NAMES_TXT),
  ...loadSafeJson(ENGLISH_NAMES_JSON),
  // If installed, load common npm dictionaries and filter to risky-collision terms
  ...buildSafeFromList(loadModuleWordlist('safe-word-list')),
  ...buildSafeFromList(loadModuleWordlist('stopwords-hi')),
  ...buildSafeFromList(loadModuleWordlist('word-list')),
  ...buildSafeFromList(loadModuleWordlist('word-list-json')),
  ...buildSafeFromList(loadModuleWordlist('wordlist-english')),
  ...buildSafeFromList(loadModuleWordlist('wordlist-english/english-words')),
];

// Hydrate additional safelist terms from Supabase, if configured
async function loadSafeSupabase() {
  try {
    const sb = getSupabase();
    if (!sb) return;
    const table = process.env.SAFE_TERMS_TABLE || 'safe_terms';
    const { data, error } = await sb
      .from(table)
      .select('term,created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) return;
    for (const row of data || []) {
      const term = String(row.term || '').trim();
      if (!term) continue;
      try {
        const rx = new RegExp(escapeRegex(normalizeLite(term)), 'gi');
        customSafePatternsNormalized.push(rx);
      } catch {}
    }
  } catch {}
}

try { await loadSafeSupabase(); } catch {}

// Runtime addition: append a safelist term
export function addSafeTermNormalized(term = '') {
  const raw = String(term || '').trim();
  if (!raw) return false;
  const n = normalizeLite(raw);
  if (!n) return false;
  try {
    const rx = new RegExp(escapeRegex(n), 'gi');
    customSafePatternsNormalized.push(rx);
  } catch {}
  // Best-effort persist to SAFE_TXT so it survives restarts
  try { fs.appendFileSync(SAFE_TXT, `${raw}\n`); } catch {}
  return true;
}

// Add explicit phrases/words (persist to file and Supabase, and let callers update runtime)
export async function addExplicitTerms(terms = []) {
  const DATA_DIR = path.join(process.cwd(), 'data');
  const TXT_FILE = path.join(DATA_DIR, 'explicit_terms_custom.txt');
  const rows = [];
  let added = 0;
  for (const t of terms) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    try { fs.appendFileSync(TXT_FILE, `${raw}\n`); } catch {}
    rows.push({ pattern: raw, created_at: new Date().toISOString() });
    added++;
  }
  try {
    const sb = getSupabase();
    if (sb && rows.length) {
      const table = process.env.EXPLICIT_TERMS_TABLE || 'explicit_terms';
      // store under column 'pattern'
      await sb.from(table).upsert(rows, { onConflict: 'pattern' });
    }
  } catch {}
  return added;
}

// Batch add terms and persist to Supabase (best-effort), used by review UI
export async function addSafeTerms(terms = []) {
  const rows = [];
  let added = 0;
  for (const t of terms) {
    const raw = String(t || '').trim();
    if (!raw) continue;
    const n = normalizeLite(raw);
    if (!n) continue;
    try {
      const rx = new RegExp(escapeRegex(n), 'gi');
      customSafePatternsNormalized.push(rx);
      added++;
    } catch {}
    try { fs.appendFileSync(SAFE_TXT, `${raw}\n`); } catch {}
    rows.push({ term: raw, created_at: new Date().toISOString() });
  }
  let persisted = 0;
  let dbError = null;
  try {
    const sb = getSupabase();
    if (sb && rows.length) {
      const table = process.env.SAFE_TERMS_TABLE || 'safe_terms';
      const { data, error } = await sb.from(table).upsert(rows, { onConflict: 'term' }).select('term');
      if (error) {
        dbError = error.message || String(error);
        // Log once for visibility
        console.warn('[safe_terms] upsert failed:', dbError);
      } else {
        persisted = Array.isArray(data) ? data.length : rows.length;
      }
    }
  } catch (e) {
    dbError = e?.message || String(e);
    console.warn('[safe_terms] upsert threw:', dbError);
  }
  return { added, persisted, dbError };
}
