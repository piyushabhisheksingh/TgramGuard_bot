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
  /\bbh[o0]sd[i1]w[ae]l[i1][ye]?\b/i,  // bhosdiwali/bhosdiwale
  /\bbh[o0]sr[i1]\s*k[e3]\b/i,        // bhosri ke
  /\bbh[a@]i?nch[o0]d\b/i,             // bhainchod romanization
  /\bbh[o0]sd[a@]\b/i,                 // bhosda
  /\bg[a@]a+nd\b/i,                    // gaand (ass)
  /\bg[a@]a+ndu\b/i,                   // gaandu
  /\bch[o0]d[uú]\b/i,                  // chodu
  /\bl[uµ]nd\b/i,                      // lund
  /\bl[ao0]ud[ae]\b/i,                 // lauda / loda
  /\baand\b/i,                         // aand
  /\bch[uµo0]{1,2}t\b/i,               // chut / choot / ch00t
  /\bch[uµo0]{1,2}tiy?[ae]\b/i,        // chutiya / chutia / chutiye
  /\bch[o0]de?\b/i,                    // chode / chod
  /\bch[o0]d(n[ae]|[ae])\b/i,          // chodna / chodne / choda / chode
  /\br[a@4]nd[i1y]\b/i,                // randi / r@ndi
  /\br[ao]nd[i1]kh[a@]n[a@]\b/i,       // randikhana (brothel)
  /\br[ae]ndw[ae]\b/i,                 // randwa / rendwa
  /\bbhad[wv]a\b/i,                    // bhadwa / bhadva
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

  // Hinglish phrase slangs
  /(bhen|behen|bahen)\s*ki\s*ch[uµo0]{1,2}t{1,2}\b/i, // bhen ki chut/choot/chutt
  /(bhen|behen|bahen)\s*ke\s*pakod(e|ey|e)?\b/i,      // behen ke pakode/pakodey
  /(maa|ma|ammi|mummy)\s*ki\s*ch[uµo0]{1,2}t{1,2}\b/i, // maa ki chut (variants)
  /(maa|ma|ammi|mummy)\s*ke?\s*l[o0]d(e|a)?\b/i,       // maa ke lode/loda
  /(bhen|behen|bahen)\s*ke?\s*l[o0]d(e|a)?\b/i,        // behen ke lode/loda
  /(bhabhi|bhabi|bhabhiji)\s*ke?\s*(n[uµ]d[e3]s?|b[o0]{2}bs?|t[i1]ts|ch[uµo0]{1,2}t{1,2})\b/i,
  /r[a@]nd[i1y]\s*ke?\s*(b[ea]cch[eaiy]|bache|bacha)\b/i, // randi ke bacche/bacha
  /(g[a@]a?nd|gaand)\s*m[e3]?\s*(lund|l[ao0]d[ae]|dand[ae])\b/i, // gaand me lund/lauda/danda
  /ch[uµo0]{1,2}t\s*m[e3]?\s*(m[a@]r(n[ae]|w[ae]|v[ao])|f[a@]d[eo]?)\b/i, // chut me marna/fadna
  /(lund|l[ao0]d[ae])\s*ch(us|oos)[a-z]*\b/i,           // lund chus/choos
  /(teri|tera|tumhari)\s*(maa|ma|ammi|mummy)\s*ki\s*ch[uµo0]{1,2}t{1,2}\b/i,
  /(teri|tera|tumhari)\s*(behen|bhen|bahen)\s*(ki|ke)\s*(ch[uµo0]{1,2}t{1,2}|l[ao0]d[ea])\b/i,
  /(suar|soo?ar|suwar|sooar|kutt[e3]?)\s*ke\s*(b[ae]cch[ea]?|aulaad)\b/i,
  /(g[a@]a?nd|gaand)\s*f[a@]a?d(du|d[eo]?)?\b/i,
  /(saali|saali)\s*r[a@]nd[i1y]\b/i,
  /\b(mkc|bkc)\b/i,

  // Hindi/Bhojpuri phrase slangs (Devanagari)
  /(माँ|मां|अम्मी|मम्मी)\s*की\s*चूत/u,
  /बहन\s*के\s*(लौड़ा|लौड़े)/u,
  /(गांड|गांड़)\s*में\s*(लंड|लौड़ा|डंडा)/u,
  /चूत\s*में\s*मार(ना|ो|ती|ते|ता)/u,
  /रंडी\s*के\s*(बच्चे|बच्चा)/u,
  /(तेरी|तेरा|तुम्हारी)\s*(माँ|मां)\s*की\s*चूत/u,
  /(सुअर|कुत्ते)\s*के\s*(बच्चे|औलाद)/u,
  /(गांड|गांड़)\s*फाड़/u,

  // Hindi (Devanagari) sexual/profanity
  /मादरचोद/u,
  /बहनचोद/u,
  /भोसड़ी\s*के/u,
  /भोसडी\s*के/u,
  /भोसडी(वाला|वाली)/u,
  /भोसड़ा/u,
  /भैंचोद/u,
  /भैनचोद/u,
  /लौड़ा/u,
  /लौडे/u,
  /लंड/u,
  /गांड/u,
  /गांडू/u,
  /गांड़/u,
  /रंडी/u,
  /रंडीखाना/u,
  /भाड़वा/u,
  /भडवा/u,
  /चूत/u,
  /चूतड़/u,
  /चुतड़/u,
  /चुद(ना|ाई|वाई|वाना)/u,
  /चुत(िया|िये|िए|िया)/u,
  /चोद(ना|ता|दी|दिया|ती|ते)/u,
  /झांट/u,
  /झाट/u,
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
  if (!explicitTermsLoose.some((rx) => rx.test(normalized))) return false;
  // Strip safe segments and retest to reduce false positives
  const stripped = stripSafeSegments(normalized);
  return explicitTermsLoose.some((rx) => rx.test(stripped));
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

// Safe words/phrases to reduce false positives on normalized text
// These patterns assume the input has been normalized (lowercased, separators removed)
const safePatternsNormalized = [
  // "ass" related benign terms
  /class/gi,
  /pass(word|code)?/gi,
  /assist(ant|ance)?/gi,
  /assign(ment|ing|ed)?/gi,
  /assess(ment|or|ing)?/gi,
  /association|associate/gi,
  /assam(ese)?/gi,
  /passion(ate|ately)?/gi,
  // "anal" benign terms
  /analysis|analyst|analytic(s|al)?|analog(y|ic|ical|ue)?/gi,
  // "cock" benign compounds
  /peacock|cockpit|woodcock|weathercock|hancock/gi,
  // "dick" benign names/titles
  /dickens|dickinson|riddick/gi,
  // "cum" benign terms
  /cumulative|cumulate|accumulate(d|s|ing)?|document|succumb|cucumber|cumlaude/gi,
  // "tit" benign terms
  /title(d|s|r)?|titular|titania|titan(ic|ium)?/gi,
  // Non-explicit uses of sex
  /unisex|asexual/gi,
  // Hinglish/Hindi benign or common phrases that could collide
  /randhir/gi,
  /randhawa/gi,
  /gandhi/gi,
  // Swedish university name
  /lunduniversity|universityoflund/gi,
  // Romanized Hindi for "leave it" to avoid conflict with explicit "chod"
  /chh?odo/gi,         // chhodo / chodo
  /chh?oddo/gi,        // chhoddo / choddo
];

function stripSafeSegments(normalized = '') {
  let s = normalized;
  for (const rx of safePatternsNormalized) s = s.replace(rx, '');
  return s;
}
