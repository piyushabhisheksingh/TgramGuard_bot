// Simple, focused helpers for moderation rules

// URL/Invite detection
// - Detects general URLs, telegram links, and invite patterns
export const urlRegex = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/join|t\.me\/[+@]|t\.me\/joinchat|\b[a-z0-9-]+\.[a-z]{2,})(\/\S*)?/i;
import { explicitTerms, safePatternsNormalized as lexiconSafe } from './filters/lexicon.js';
import { createRequire } from 'node:module';
const requireM = createRequire(import.meta.url);

export function textHasLink(text = "") {
  if (!text) return false;
  return urlRegex.test(text);
}

// Detect URLs from entities (Telegram-native parsing)
export function entitiesContainLink(entities = []) {
  return entities.some((e) => e.type === "url" || e.type === "text_link");
}

// Explicit / sexual content list (expand as needed)
// Note: This is a best-effort keyword filter. It won’t catch all variants.

export function containsExplicit(text = "") {
  if (!text) return false;
  // Fast path on raw text
  if (explicitTerms.some((rx) => rx.test(text))) return true;
  if (runtimeExplicit.some((rx) => rx.test(text))) return true;
  // Optional: token-based profanity check via `allprofanity` package if installed
  if (hasProfanityToken(text)) return true;
  // Obfuscation-aware path: normalize text and run a looser check
  const normalized = normalizeForExplicit(text);
  if (!explicitTermsLoose.some((rx) => rx.test(normalized)) && !runtimeExplicitLoose.some((rx) => rx.test(normalized))) return false;
  // Strip safe segments and retest to reduce false positives
  const stripped = stripSafeSegments(normalized);
  return explicitTermsLoose.some((rx) => rx.test(stripped)) || runtimeExplicitLoose.some((rx) => rx.test(stripped));
}

export function overCharLimit(text = "", limit = 200) {
  if (!text) return false;
  return [...text].length > limit; // count unicode codepoints
}

// --- Obfuscation handling ---
// Build a loosened variant of patterns (no word boundaries) for normalized scan
const explicitTermsLoose = explicitTerms.map((rx) => {
  const src = rx.source.replace(/\\b/g, '');
  let flags = rx.flags || '';
  // Ensure case-insensitive by default for normalized text
  if (!flags.includes('i')) flags += 'i';
  // Preserve unicode flag if present
  return new RegExp(src, flags);
});

// --- Runtime additions for explicit patterns (via /abuse) ---
const runtimeExplicit = [];
const runtimeExplicitLoose = [];
export function addExplicitRuntime(terms = []) {
  let added = 0;
  for (const t of terms) {
    if (!t) continue;
    // Allow /pattern/flags or plain strings
    let rx = null;
    if (typeof t === 'string') {
      const m = t.match(/^\s*\/(.*)\/([a-z]*)\s*$/i);
      if (m) {
        try { rx = new RegExp(m[1], m[2] || 'i'); } catch { rx = null; }
      }
      if (!rx) {
        const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        rx = new RegExp(`\\b${esc}\\b`, 'i');
      }
    } else if (t instanceof RegExp) {
      rx = t;
    }
    if (!rx) continue;
    runtimeExplicit.push(rx);
    // Build loose version for normalized scanning
    const looseSrc = rx.source.replace(/\\b/g, '');
    let flags = rx.flags || '';
    if (!flags.includes('i')) flags += 'i';
    try { runtimeExplicitLoose.push(new RegExp(looseSrc, flags)); } catch {}
    added++;
  }
  return added;
}

function normalizeForExplicit(input = '') {
  // Lowercase
  let s = String(input).toLowerCase();
  // Remove zero-width and joiner characters
  s = s.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
  // NFKD normalize and strip diacritics for Latin script
  try {
    s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  } catch (_) {}
  // Leetspeak substitutions
  const map = {
    '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's', '5': 's', '7': 't', '8': 'b', '9': 'g', 'µ': 'u',
    // Common Cyrillic confusables → Latin
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 's', 'х': 'x', 'у': 'y', 'і': 'i', 'ї': 'i', 'ј': 'j',
  };
  s = s.replace(/[01!34@\$5789µаеорсхуіїј]/g, (ch) => map[ch] || ch);
  // Remove common separators and punctuation to collapse obfuscations like s.e.x, s_e-x
  s = s.replace(/[\s._\-\|*`'"~^+\=\/\\()\[\]{}:,;<>]+/g, '');
  // Collapse repeated characters (3+ → 2) to catch exxxtreme repeats
  s = s.replace(/([a-z\u0900-\u097F])\1{2,}/g, '$1$1');
  return s;
}

// Safe words/phrases to reduce false positives on normalized text
// These patterns assume the input has been normalized (lowercased, separators removed)
const safePatternsNormalized = lexiconSafe;

function stripSafeSegments(normalized = '') {
  let s = normalized;
  for (const rx of safePatternsNormalized) s = s.replace(rx, '');
  return s;
}

// --- Optional profanity list from `allprofanity` (token-based) ---
let profanitySet = null; // Set<string>

function extractStringsDeep(x, depth = 0) {
  if (depth > 3) return [];
  if (!x) return [];
  if (typeof x === 'string') return [x];
  if (Array.isArray(x)) return x.filter((v) => typeof v === 'string');
  if (typeof x === 'object') {
    const out = [];
    for (const v of Object.values(x)) out.push(...extractStringsDeep(v, depth + 1));
    return out;
  }
  return [];
}

function loadAllProfanitySet() {
  if (profanitySet) return profanitySet;
  try {
    const mod = requireM('allprofanity');
    const list = extractStringsDeep(mod);
    const set = new Set(
      list
        .map((w) => String(w).toLowerCase().trim())
        .filter((w) => w && /^[a-z]+$/.test(w))
    );
    profanitySet = set.size ? set : null;
  } catch {
    profanitySet = null;
  }
  return profanitySet;
}

function hasProfanityToken(text = '') {
  const set = loadAllProfanitySet();
  if (!set) return false;
  const tokens = String(text).toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}
