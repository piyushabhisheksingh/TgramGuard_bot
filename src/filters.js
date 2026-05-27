// Simple, focused helpers for moderation rules

// URL/Invite detection
// - Detects general URLs, telegram links, and invite patterns
export const urlRegex = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/join|t\.me\/[+@]|t\.me\/joinchat|\b[a-z0-9-]+\.[a-z]{2,})(\/\S*)?/i;
import { explicitTerms, getSafePatternsNormalized } from './filters/lexicon.js';
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
  // Quick raw-text benign guard for common 'sex' compounds
  try {
    const raw = String(text).toLowerCase();
    if (/(^|\b)(sexton(s)?|sexagesimal(s)?|sexagenarian(s)?|unisex|asexual(ly|ity)?|middlesex|wessex|sussex|essex)(\b|$)/.test(raw)) {
      return false;
    }
  } catch {}
  // Normalize and evaluate against loose patterns so safelist can take effect
  let normalized = normalizeForExplicit(text);
  // Pre-strip common benign collisions with "sex" to reduce noise
  try { normalized = normalized.replace(/sexagesimal|sexton(s)?/gi, ''); } catch {}
  // Quick precheck: if nothing resembles explicit even before stripping, bail out
  const scanTargets = getExplicitScanTargets(text, normalized);
  const preHit =
    scanTargets.some((target) => hasExplicitPatternOfMinimumLength(target, explicitTermsLoose)) ||
    scanTargets.some((target) => hasExplicitPatternOfMinimumLength(target, runtimeExplicitLoose)) ||
    // Optional: token-based profanity check via `allprofanity` package if installed
    hasProfanityToken(text);
  if (!preHit) return false;
  // Strip safe segments and retest to reduce false positives (e.g., class, analysis, gandhi)
  const strippedTargets = scanTargets.map((target) => stripSafeSegments(target));
  const hitLoose =
    strippedTargets.some((target) => hasExplicitPatternOfMinimumLength(target, explicitTermsLoose)) ||
    strippedTargets.some((target) => hasExplicitPatternOfMinimumLength(target, runtimeExplicitLoose));
  if (!hitLoose) return false;
  // Special-case guard: if only 'sex' remains but the raw text contains benign terms like 'sexton' or 'sexagesimal', treat as benign
  try {
    if (strippedTargets.some((target) => /sex/i.test(target))) {
      const raw = String(text).toLowerCase();
      if (/(^|\b)(sexton(s)?|sexagesimal(s)?|sexagenarian(s)?|unisex|asexual(ly|ity)?|middlesex|wessex|sussex|essex)(\b|$)/.test(raw)) return false;
    }
  } catch {}
  return true;
}

export function overCharLimit(text = "", limit = 300) {
  if (!text) return false;
  return [...text].length > limit; // count unicode codepoints
}

// --- Obfuscation handling ---
// Only repeated letters and inserted punctuation/symbols are normalized.
// Do not translate digits, homoglyphs, vowels, or consonants into other letters.
const MIN_EXPLICIT_TOKEN_LEN = 3;

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
const runtimeExplicitSources = new Set(); // dedupe additions
export function addExplicitRuntime(terms = []) {
  let added = 0;
  for (const t of terms) {
    if (!t) continue;
    // Allow /pattern/flags or plain strings
    let rx = null;
    if (typeof t === 'string') {
      if (runtimeExplicitSources.has(t)) continue;
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
    runtimeExplicitSources.add(typeof t === 'string' ? t : rx.source);
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

export function replaceHomoglyphsAndLeetspeak(input = '') {
  return String(input);
}

function normalizeForExplicit(input = '') {
  // Lowercase
  let s = String(input).toLowerCase();
  // Keep letters literal; only normalize punctuation/symbols and repeated letters below.
  s = replaceHomoglyphsAndLeetspeak(s);
  // Remove zero-width, joiner, and soft hyphen characters
  s = s.replace(/[\u200B-\u200D\uFEFF\u2060\u00AD\u180E]/g, '');
  // Treat punctuation and symbols as separators for normal text.
  try {
    s = s.replace(/[\p{P}\p{S}]+/gu, ' ');
  } catch {
    // Fallback for environments without Unicode property escapes
    s = s.replace(/[._\-\|*`'"~^+\=\/\\()\[\]{}:,;<>]+/g, ' ');
  }
  // Collapse excessive whitespace for stability while preserving intentional spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeSpecialCharObfuscations(input = '') {
  const out = [];
  const rawTokens = String(input).toLowerCase().split(/\s+/).filter(Boolean);
  for (const token of rawTokens) {
    if (!/[^\p{L}\p{N}]/u.test(token)) continue;
    const singleLettersSeparated = /^[\p{L}\p{N}](?:[^\p{L}\p{N}]+[\p{L}\p{N}]){2,}$/u.test(token);
    if (!singleLettersSeparated) continue;
    let compact = token;
    try {
      compact = compact.replace(/[\p{P}\p{S}]+/gu, '');
    } catch {
      compact = compact.replace(/[._\-\|*`'"~^+\=\/\\()\[\]{}:,;<>]+/g, '');
    }
    if (compact) out.push(compact);
  }
  return out;
}

function getExplicitScanTargets(raw = '', normalized = normalizeForExplicit(raw)) {
  const targets = new Set();
  const add = (value) => {
    const s = String(value || '').trim();
    if (!s) return;
    targets.add(s);
    targets.add(foldRepeatedLetters(s));
  };
  add(normalized);
  for (const compact of normalizeSpecialCharObfuscations(raw)) add(compact);
  return Array.from(targets);
}

function foldRepeatedLetters(value = '') {
  return String(value).replace(/([a-z\u0900-\u097F])\1{2,}/g, '$1');
}

function normalizedTokenLength(value = '') {
  if (!value) return 0;
  return value.replace(/[^a-z0-9\u0900-\u097F]+/gi, '').length;
}

function hasExplicitPatternOfMinimumLength(target = '', patterns = []) {
  if (!target) return false;
  for (const rx of patterns) {
    if (!rx) continue;
    rx.lastIndex = 0;
    let match;
    while ((match = rx.exec(target)) !== null) {
      const piece = match[0] || '';
      if (normalizedTokenLength(piece) >= MIN_EXPLICIT_TOKEN_LEN) return true;
      if (!rx.global) break;
      if (rx.lastIndex === match.index) rx.lastIndex += 1;
    }
  }
  return false;
}

// Safe words/phrases to reduce false positives on normalized text
// These patterns assume the input has been normalized (lowercased, separators removed)
// Retrieve dynamically so runtime additions are included
function currentSafePatterns() {
  return getSafePatternsNormalized();
}

function stripSafeSegments(normalized = '') {
  let s = normalized;
  let count = 0;
  for (const rx of currentSafePatterns()) {
    s = s.replace(rx, (m) => {
      if (count > 5000) return m; // safety guard
      count += 1;
      return '';
    });
    if (count > 5000) break;
  }
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
  // Apply homoglyph and leetspeak replacements before tokenizing
  let cleaned = replaceHomoglyphsAndLeetspeak(String(text).toLowerCase());
  // Ignore very short English tokens (<=2 chars) to avoid false positives
  const tokens = cleaned
    .split(/[^a-z]+/)
    .filter((t) => t && t.length >= 3);
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}
