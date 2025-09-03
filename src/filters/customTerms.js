import fs from 'node:fs';
import path from 'node:path';

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
export const customSafePatternsNormalized = [
  ...loadSafeTxt(SAFE_TXT),
  ...loadSafeJson(SAFE_JSON),
];
