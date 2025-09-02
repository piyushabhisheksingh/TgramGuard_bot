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
  // sexual explicit (with common leet/spacing variants)
  /\b[s5][e3]x\b/i,                    // sex, s3x, 5ex
  /\b[s5][e3]x[yj]\b/i,               // sexy, s3xy
  /\bp[o0]rn\b/i,                     // porn, p0rn
  /\bpr[o0]n\b/i,                     // pr0n
  /\bpornhub\b/i,
  /\bn[uµ][dc][e3]s?\b/i,              // nude(s), nu de, nud3
  /\bns[fph][wvv]\b/i,                // nsfw (loose)
  /\bf[4a@]p\b/i,                      // fap, f4p, f@p
  /\borgasm\b/i,
  /\bc[uµ][mn]\b/i,                    // cum, cµm
  /\bc[uµ][mn]shot\b/i,                // cumshot
  /\bmilf\b/i,
  /\bbrazzers\b/i,
  /\bhentai\b/i,
  /\bincest\b/i,
  /\bxxx\b/i,
  /\bdeep\s*throat\b/i,
  /\bblow\s*job\b/i,
  /\bhand\s*job\b/i,
  /\b[4a]nal\b/i,                      // anal, 4nal
  /\ba55\b/i,                          // a55
  /\bass\b/i,
  /\bt[i1]ts?\b/i,                     // tit(s), t1ts
  /\btit{1,2}ies\b/i,                   // titties
  /\bb[o0]{2}bs?\b/i,                  // boob(s), b00bs
  /\bcl[i1]t\b/i,                      // clit, cl1t
  /\bvag[i1]na\b/i,                    // vagina, vag1na
  /\bpen[i1]s\b/i,                     // penis, pen1s
  /\bd[i1]ck\b/i,                      // dick, d1ck
  /\bc[o0]ck\b/i,                      // cock, c0ck
  /\bb[4a]lls?\b/i,                    // balls, b4lls
  /\bp[uµ]ssy\b/i,                     // pussy, pu55y (covered partly by ass/a55)
  /\b[5s]lut\b/i,                      // slut, 5lut
  /\bwh[o0]re\b/i,                     // whore, wh0re
  /\be[5s]cort\b/i,                    // escort, e5cort
  /\bprostitut(e|ion)\b/i,
  /\bcam\s*girls?\b/i,
  /\bcam\s*boys?\b/i,
  /\bonly\s*fans\b/i,                  // onlyfans / only fans
  /\bxvideos?\b/i,
  /\bxnxx\b/i,
  /\bbdsm\b/i,
  /\bfetish\b/i,
  /\bcreampie\b/i,
  /\bgangbang\b/i,
  /\bsquirt(ing)?\b/i,
  /\bhorny\b/i,
  /\bthreesome\b/i,
  /\bbj\b/i,                           // shorthand blowjob

  // general explicit/profanity (with some spaced/leet variants)
  /\bfuck\b/i,
  /\bf\s*u\s*c\s*k\b/i,               // f u c k
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
