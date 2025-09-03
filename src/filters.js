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
  /\brim\s*job\b/i,                    // rimjob / rim job
  /\brimming\b/i,
  /\bpegging\b/i,
  /\bsodomy\b/i,
  /\bbesti[a@]lity\b/i,
  /\bdild[o0]s?\b/i,
  /\bvibrat[oe]rs?\b/i,
  /\bbutt\s*plugs?\b/i,
  /\bnb?\s*c?um\b/i,                   // nb cum (loose), cum already above
  /\bjizz\b/i,
  /\bspunk\b/i,
  /\bboobies\b/i,
  /\bnip+les?\b/i,                     // nipple(s)
  /\bstrip\s*tease\b/i,
  /\bcam\s*sex\b/i,
  /\bwebcam\s*sex\b/i,
  /\bsuck\s*my\b/i,

  // Hinglish sexual/profanity (with common leet/spacing variants)
  /\bm[a@]d[ae]r\s*ch[o0]d\b/i,        // madarchod, maderchod, m@darch0d
  /\bbehen\s*ch[o0]d\b/i,             // behenchod with/without space
  /\bbhen\s*ch[o0]d\b/i,              // bhen chod
  /\bbh[o0]sd[i1]\s*k[e3]\b/i,        // bhosdi ke (spaced)
  /\bbh[o0]s[a@]d[i1]k[e3]\b/i,        // bhosadike / bhosdike
  /\bbh[o0]sr[i1]\s*w[ae]l[i1][ye]?\b/i, // bhosriwali/bhosriwaly/bhosriwale
  /\bbh[o0]sr[i1]\s*k[e3]\b/i,        // bhosri ke
  /\bg[a@]a+nd\b/i,                    // gaand (ass)
  /\bg[a@]a+ndu\b/i,                   // gaandu
  /\bch[o0]d[uú]\b/i,                  // chodu
  /\bl[uµ]nd\b/i,                      // lund
  /\bl[ao0]ud[ae]\b/i,                 // lauda / loda
  /\bch[uµo0]{1,2}t\b/i,               // chut / choot / ch00t
  /\bch[uµo0]{1,2}tiy?[ae]\b/i,        // chutiya / chutia / chutiye
  /\bch[o0]de?\b/i,                    // chode / chod
  /\bch[o0]d(n[ae]|[ae])\b/i,          // chodna / chodne / choda / chode
  /\br[a@4]nd[i1y]\b/i,                // randi / r@ndi
  /\br[ae]ndw[ae]\b/i,                 // randwa / rendwa
  /\brund[i1y]\b/i,                    // rundi
  /\bbsdk\b/i,                         // bsdk (abbr.)
  /\btatt[e3]s?\b/i,                   // tatte (balls)
  /\bkan[dt]i\b/i,                     // kandi (slur)
  /\bchinal\b/i,                       // chinal
  /\bbalatk[a@]r\b/i,                  // balatkar (rape)
  /\br[a4]pe\b/i,                      // rape / r4pe
  /\bjh?a+nt\b/i,                      // jhant/jhaat (pubic hair)
  /\bjh[a@]t[uú]\b/i,                  // jhatu
  /\bka+m\s*i+n[ae]\b/i,               // kamina/kamine
  /\bhar[a@]am[i1]([yz]ad[ae])?\b/i,   // harami, haramzade/haramzadi
  /\bkutt[i1y][ae]?\b/i,               // kutti/kutty/kuttya
  /\bkutt[e3]\b/i,                     // kutte
  /\bkutt[e3]\s*ki\b/i,               // kutte ki

  // Hindi (Devanagari) sexual/profanity
  /मादरचोद/u,
  /बहनचोद/u,
  /भोसड़ी\s*के/u,
  /भोसडी\s*के/u,
  /लौड़ा/u,
  /लौडे/u,
  /लंड/u,
  /गांड/u,
  /गांड़/u,
  /रंडी/u,
  /चूत/u,
  /चुद(ना|ाई|वाई|वाना)/u,
  /चुत(िया|िये|िए|िया)/u,
  /चोड(ना|ना|ता)/u,
  /बलात्कार/u,
  /हरामी/u,
  /हरामजादा/u,
  /हरामजादी/u,
  /कुत्ती/u,
  /कुत्ते/u,

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
  // Fast path on raw text
  if (explicitTerms.some((rx) => rx.test(text))) return true;
  // Obfuscation-aware path: normalize text and run a looser check
  const normalized = normalizeForExplicit(text);
  return explicitTermsLoose.some((rx) => rx.test(normalized));
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
