// Simple, focused helpers for moderation rules

// URL/Invite detection
// - Detects general URLs, telegram links, and invite patterns
export const urlRegex = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|tg:\/\/join|t\.me\/[+@]|t\.me\/joinchat|\b[a-z0-9-]+\.[a-z]{2,})(\/\S*)?/i;

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
const explicitTerms = [
  // sexual explicit
  /\bsex\b/i,
  /\bsexy\b/i,
  /\bporn\b/i,
  /\bpornhub\b/i,
  /\bnude\b/i,
  /\bnudes\b/i,
  /\bnsfw\b/i,
  /\bfap\b/i,
  /\borgasm\b/i,
  /\bcum\b/i,
  /\bcumshot\b/i,
  /\bmilf\b/i,
  /\bbrazzers\b/i,
  /\bhentai\b/i,
  /\bincest\b/i,
  /\bxxx\b/i,
  /\bdeepthroat\b/i,
  /\bblow\s?job\b/i,
  /\bhand\s?job\b/i,
  /\banal\b/i,
  /\bass\b/i,
  /\btits?\b/i,
  /\bboobs?\b/i,
  /\bclit\b/i,
  /\bvagina\b/i,
  /\bpenis\b/i,
  /\bdick\b/i,
  /\bcock\b/i,
  /\bballs?\b/i,
  /\bslut\b/i,
  /\bwhore\b/i,
  /\bescort\b/i,
  /\bprostitut(e|ion)\b/i,
  // general explicit/profanity
  /\bfuck\b/i,
  /\bshit\b/i,
  /\bbitch\b/i,
  /\basshole\b/i,
  /\bmotherfucker\b/i,
  /\bcunt\b/i,
  /\bchutiya\b/i,
  /\bmadarchod\b/i,
  /\bbehen\s?chod\b/i
];

export function containsExplicit(text = "") {
  if (!text) return false;
  return explicitTerms.some((rx) => rx.test(text));
}

export function overCharLimit(text = "", limit = 200) {
  if (!text) return false;
  return [...text].length > limit; // count unicode codepoints
}

