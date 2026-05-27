// Central list of explicit/sexual/profane patterns (English, Hinglish, Hindi)
import { customExplicitTerms } from './customTerms.js';

const STRICT = /^(1|true|yes|on)$/i.test(process.env.EXPLICIT_STRICT || '');

// Helper to generate aggressive relation phrases when STRICT mode is enabled
function genAggressivePhrases() {
  if (!STRICT) return [];
  const relations = [
    // Romanized family terms
    'maa', 'mummy', 'ammi', 'behen', 'bhen', 'bahen', 'bhabhi', 'mami', 'mausi', 'chachi', 'chacha', 'maam',
  ];
  const connectors = ['ki', 'ke'];
  const nuclei = [
    // Explicit nouns (romanized)
    'chut', 'choot', 'chutt', 'lund', 'loda', 'lode', 'lauda', 'laude', 'gand', 'gaand', 'boobs', 'tits'
  ];
  const out = [];
  for (const r of relations) {
    for (const c of connectors) {
      for (const n of nuclei) {
        const rx = new RegExp(`(?:teri|tera|tumhari)?\s*${r}\s*${c}\s*${n}`, 'i');
        out.push(rx);
      }
    }
  }
  // Devanagari variants for a small subset
  const devRelations = ['माँ', 'मां', 'बहन', 'भाभी'];
  const devConnectors = ['की', 'के'];
  const devNuclei = ['चूत', 'लौड़ा', 'लंड'];
  for (const r of devRelations) {
    for (const c of devConnectors) {
      for (const n of devNuclei) {
        out.push(new RegExp(`${r}\s*${c}\s*${n}`, 'u'));
      }
    }
  }
  return out;
}

export const explicitTerms = [
  // sexual explicit terms
  /\bsex\b/i,
  /\bsexy\b/i,
  /\bporn\b/i,
  /\bpron\b/i,
  /\bpornhub\b/i,
  /\bnudes?\b/i,
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
  /\bdeep\s*throat\b/i,
  /\bblow\s*job\b/i,
  /\bhand\s*job\b/i,
  /\banal\b/i,
  /\ba55\b/i,
  /\bass\b/i,
  /\btits?\b/i,
  /\btit{1,2}ies\b/i,
  /\bbo{2}bs?\b/i,
  /\bclit\b/i,
  /\bvagina\b/i,
  /\bpenis\b/i,
  /\bdick\b/i,
  /\bcock\b/i,
  /\bballs?\b/i,
  /\bpussy\b/i,
  /\bslut\b/i,
  /\bwhore\b/i,
  /\bescort\b/i,
  /\bprostitut(e|ion)\b/i,
  /\bcam\s*girls?\b/i,
  /\bcam\s*boys?\b/i,
  /\bonly\s*fans\b/i,
  /\bxvideos?\b/i,
  /\bxnxx\b/i,
  /\bbdsm\b/i,
  /\bfetish\b/i,
  /\bcreampie\b/i,
  /\bgangbang\b/i,
  /\bsquirt(ing)?\b/i,
  /\bhorny\b/i,
  /\bthreesome\b/i,
  /\bbj\b/i,
  /\brim\s*job\b/i,
  /\brimming\b/i,
  /\bpegging\b/i,
  /\bsodomy\b/i,
  /\bbestiality\b/i,
  /\bdildos?\b/i,
  /\bvibrators?\b/i,
  /\bbutt\s*plugs?\b/i,
  /\bcum\b/i,
  /\bjizz\b/i,
  /\bspunk\b/i,
  /\bboobies\b/i,
  /\bnip+les?\b/i,
  /\bstrip\s*tease\b/i,
  /\bcam\s*sex\b/i,
  /\bwebcam\s*sex\b/i,
  /\bsuck\s*my\b/i,
  // Gendered genres and platforms
  /\b(gay|lesbian|trans|shemale|lady\s*boy|futanari)\s*(sex|porn|vid(eo)?s?)\b/i,
  /\b(gay|lesbian)s?\s*porn\b/i,
  /\bshemales?\b/i,
  /\blady\s*boys?\b/i,
  /\bfutanari\b/i,
  /\bxhamster\b/i,
  /\bredtube\b/i,
  /\byouporn\b/i,
  /\bspankbang\b/i,
  /\bpornhd\b/i,

  // Hinglish sexual/profanity terms
  /\bmadar\s*chod\b/i,
  /\bbehen\s*chod\b/i,
  /\bbhen\s*chod\b/i,
  /\bbahen\s*(chod|chood|choodh)\b/i,
  /(bhen|behen|bahen)\s*(chod|chood|choodh)\b/i,
  /\bbhosdi\s*ke\b/i,
  /\bbhosadike\b/i,
  /\bbhosri\s*wali(ye)?\b/i,
  /\bbhosdiwali(ye)?\b/i,
  /\bbhosri\s*ke\b/i,
  /\b(bhainchod|bhenchod)\b/i,
  /\bbhosda\b/i,
  /\bgaand\b/i,
  /\bgaandu\b/i,
  /\bgandu\b/i,
  /\bchodu\b/i,
  /\blund\b/i,
  /\b(lauda|laude|loda|lode)\b/i,
  /\baand\b/i,
  /\b(chut|choot)\b/i,
  /\b(chutiya|chutie|chutiye)\b/i,
  /\bchode?\b/i,
  /\b(chodna|chodne|choda|chode)\b/i,
  /\brandi\b/i,
  /\brandikhana\b/i,
  /\brandwa\b/i,
  /\b(bhadwa|bhadva)\b/i,
  /\brundi\b/i,
  /\bbsdk\b/i,
  /\btattes?\b/i,
  /\bkandi\b/i,
  /\bchinal\b/i,
  /\bbalatkar\b/i,
  /\brape\b/i,
  /\bjhant\b/i,
  /\bjhatu\b/i,
  /\bkamina\b/i,
  /\bharaami(yada|zada)?\b/i,
  // Hinglish phrase slangs
  /(bhen|behen|bahen)\s*ki\s*(chut|choot|chutt)\b/i,
  /(bhen|behen|bahen)\s*ke\s*pakod(e|ey|e)?\b/i,
  /(bur|boor)\s*ke\s*baal\b/i,
  /(maa|ma|ammi|mummy)\s*ki\s*(chut|choot|chutt)\b/i,
  /(maa|ma|ammi|mummy)\s*ke?\s*lod(e|a)?\b/i,
  /(bhen|behen|bahen)\s*ke?\s*lod(e|a)?\b/i,
  /(bhabhi|bhabi|bhabhiji)\s*ke?\s*(nudes?|bo{2}bs?|tits|chut|choot|chutt)\b/i,
  /randi\s*ke?\s*(bacche|bache|bacha)\b/i,
  /(gaand|gand)\s*me\s*(lund|lauda|laude|loda|lode|danda|dande)\b/i,
  /(suar|sooar|suwar|kutte?|gadhe?|gadha|ullu)\s*ki\s*jhant\b/i,
  /(gaand|gand)\s*me\s*(keeda|kida)\b/i,
  /(chut|choot)\s*me?\s*(marna|marwa|marva|fado|fade)\b/i,
  /(lund|lauda|laude|loda|lode)\s*ch(us|oos)[a-z]*\b/i,
  /(teri|tera|tumhari)\s*(maa|ma|ammi|mummy)\s*ki\s*(chut|choot|chutt)\b/i,
  /(teri|tera|tumhari)\s*(behen|bhen|bahen)\s*(ki|ke)\s*(chut|choot|chutt|lauda|laude|loda|lode)\b/i,
  /(gaand|gand)\s*(faad|fad|faadu|fadu|faado|fado|faade|fade)\b/i,
  /saali\s*randi\b/i,
  /\b(mkc|bkc)\b/i,

  // Hindi/Bhojpuri phrase slangs (Devanagari)
  /(माँ|मां|अम्मी|मम्मी)\s*की\s*चूत/u,
  /बहन\s*के\s*(लौड़ा|लौड़े)/u,
  /(गांड|गांड़)\s*में\s*(लंड|लौड़ा|डंडा)/u,
  /(सुअर|कुत्ते|कुत्ता|गधे|गधा|उल्लू)\s*की\s*(झांट|झाट)/u,
  /(गांड|गांड़|गंड)\s*में\s*कीड़[ाअे]?/u,
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
  // general explicit/profanity (with some spaced/leet variants)
  /\bfuck\b/i,
  /\bf\s*u\s*c\s*k\b/i,
  /\bshit\b/i,
  /\bbitch\b/i,
  /\basshole\b/i,
  /\bmotherfucker\b/i,
  /\bcunt\b/i,
  /\bchutiya\b/i,
  /\bmadarchod\b/i,
  /\bbehen\s?chod\b/i,
  // Strict/aggressive auto-generated family+explicit combinations
  ...genAggressivePhrases(),
  // ---- end of built-ins ----
  ...customExplicitTerms,
];
