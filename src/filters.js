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
  // Normalize and evaluate against loose patterns so safelist can take effect
  const normalized = normalizeForExplicit(text);
  // Quick precheck: if nothing resembles explicit even before stripping, bail out
  const preHit =
    explicitTermsLoose.some((rx) => rx.test(normalized)) ||
    runtimeExplicitLoose.some((rx) => rx.test(normalized)) ||
    // Optional: token-based profanity check via `allprofanity` package if installed
    hasProfanityToken(text);
  if (!preHit) return false;
  // Strip safe segments and retest to reduce false positives (e.g., class, analysis, gandhi)
  const stripped = stripSafeSegments(normalized);
  return (
    explicitTermsLoose.some((rx) => rx.test(stripped)) ||
    runtimeExplicitLoose.some((rx) => rx.test(stripped))
  );
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
  // Normalize compatibility forms (fullwidth, circled letters, etc.)
  try { s = s.normalize('NFKC'); } catch {}
  // Remove zero-width and joiner characters
  s = s.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
  // NFKD normalize and strip diacritics for Latin script
  try {
    s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  } catch (_) {}
  // Leetspeak substitutions and homoglyphs
  const map = {
    '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's', '5': 's', '7': 't', '8': 'b', '9': 'g', 'µ': 'u',
    // Cyrillic → Latin
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 's', 'х': 'x', 'у': 'y', 'і': 'i', 'ї': 'i', 'ј': 'j',
    // Greek → Latin (lowercase)
    'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n',
    'ο': 'o', 'π': 'p', 'ρ': 'p', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'u', 'φ': 'f', 'χ': 'x', 'ψ': 'y', 'ω': 'w',
    // Arabic-Indic digits → ASCII
    '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
    // Devanagari digits → ASCII
    '०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9',
  };
  s = s.replace(/[01!34@\$5789µаеорсхуіїјαβγδεζηικλμνξοπρσςτυφχψω٠-٩०-९]/g, (ch) => map[ch] || ch);
  // Transliterate Devanagari → Latin (rough mapping) to catch mixed-script abuse
  s = transliterateDevanagari(s);
  // Remove separators, whitespace, punctuation, symbols (Unicode-aware) to collapse obfuscations like s e x, s.e.x, s_e-x, s•e•x
  try {
    s = s.replace(/[\p{Z}\s\p{P}\p{S}]+/gu, '');
  } catch {
    // Fallback for environments without Unicode property escapes
    s = s.replace(/[\s._\-\|*`'"~^+\=\/\\()\[\]{}:,;<>]+/g, '');
  }
  // Collapse repeated characters (3+ → 2) to catch exxxtreme repeats
  s = s.replace(/([a-z\u0900-\u097F])\1{2,}/g, '$1$1');
  return s;
}

// Safe words/phrases to reduce false positives on normalized text
// These patterns assume the input has been normalized (lowercased, separators removed)
// Retrieve dynamically so runtime additions are included
function currentSafePatterns() {
  return getSafePatternsNormalized();
}

function stripSafeSegments(normalized = '') {
  let s = normalized;
  for (const rx of currentSafePatterns()) s = s.replace(rx, '');
  return s;
}

// Basic Devanagari → Latin transliteration (sufficient for abuse words)
function transliterateDevanagari(s = '') {
  const m = new Map(Object.entries({
    'अ':'a','आ':'aa','इ':'i','ई':'ii','उ':'u','ऊ':'uu','ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऋ':'ri',
    'ा':'aa','ि':'i','ी':'ii','ु':'u','ू':'uu','े':'e','ै':'ai','ो':'o','ौ':'au','ं':'n','ँ':'n','ः':'h','्':'',
    'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'n','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'n','ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n',
    'त':'t','थ':'th','द':'d','ध':'dh','न':'n','प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h',
    'क़':'q','ख़':'kh','ग़':'g','ज़':'z','ड़':'d','ढ़':'dh','फ़':'f','य़':'y',
  }));
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) || 0;
    if (cp >= 0x0900 && cp <= 0x097F) {
      out += m.get(ch) ?? '';
    } else {
      out += ch;
    }
  }
  return out;
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
  // Ignore very short English tokens (<=2 chars) to avoid false positives
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t && t.length >= 3);
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}
