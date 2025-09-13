// Centralized lexicon: explicit terms, safelist patterns, and optional name lists
import fs from 'node:fs';
import path from 'node:path';
import { explicitTerms as explicitBase } from './explicitTerms.js';
import { customSafePatternsNormalized, customExplicitTerms } from './customTerms.js';

// Merge base explicit list with any custom additions (keeps behavior from explicitTerms.js)
export const explicitTerms = [...explicitBase, ...customExplicitTerms];

// Base safelist patterns from filters.js plus custom safelist patterns compiled from data files
const baseSafePatterns = [
  // "ass" related benign terms
  /class/gi,
  /class(ify|ified|ifies|ifying|ic|ical|ics|ism|ist|room|mate|work)/gi,
  /pass(word|code)?/gi,
  /pass(ive|ively|over|through|age|ages|enger|engers)/gi,
  /assist(ant|ance)?/gi,
  /assign(ment|ing|ed)?/gi,
  /assess(ment|or|ing)?/gi,
  /association|associate/gi,
  /assam(ese)?/gi,
  /passion(ate|ately)?/gi,
  /passenger(s)?/gi,
  /passage(s)?/gi,
  /assurance(s)?/gi,
  // "anal" benign terms
  /analysis|analyst|analytic(s|al)?|analog(y|ic|ical|ue)?/gi,
  /analy(se|ze|ser|zer|sed|zed|sing|zing|sis)/gi,
  /canal(s)?/gi,
  // "cock" benign compounds
  /peacock|cockpit|woodcock|weathercock|hancock/gi,
  /cocktail/gi,
  /shuttlecock|stopcock|ballcock/gi,
  // "dick" benign names/titles
  /dickens|dickinson|riddick/gi,
  // "cum" benign terms
  /cumulative|cumulate|accumulate(d|s|ing)?|document|succumb|cucumber|cumlaude/gi,
  /circumstance(s)?|circumference|circumvent(ion)?|circumspect|circumscribe(d|s|ing)?/gi,
  // "tit" benign terms
  /title(d|s|r)?|titular|titania|titan(ic|ium)?/gi,
  /titr(ate|ation|ated|ating|ant|ator)s?/gi,
  // Non-explicit uses of sex
  /unisex|asexual/gi,
  /sexagenarian(s)?/gi,
  // Hinglish/Hindi benign or common phrases that could collide
  /randhir/gi,
  /randhawa/gi,
  /gandhi/gi,
  /shital/gi,
  // Indian names that contain "shit" as a substring (avoid false positives)
  /akshita/gi,
  /ishita/gi,
  /akshit/gi,
  /ishit/gi,
  /lakshit/gi,
  /lakshita/gi,
  /nishita/gi,
  /harshit/gi,
  /harshita/gi,
  /darshit/gi,
  /darshita/gi,
  /krishit/gi,
  /krishita/gi,
  /rishit/gi,
  /rishita/gi,
  /yashit/gi,
  /yashita/gi,
  /ashit/gi,
  /ashita/gi,
  /ashitha/gi,
  /lakshith/gi,
  /lakshitha/gi,
  /nishit/gi,
  /nishith/gi,
  /dishit/gi,
  /dishita/gi,
  /mishita/gi,
  /prashita/gi,
  /vishita/gi,
  /rashita/gi,
  /sushita/gi,
  /aashit/gi,
  /aashita/gi,
  /aashitha/gi,
  /yashith/gi,
  /yashitha/gi,
  /kashit/gi,
  /kashita/gi,
  /kashitha/gi,
  /prashit/gi,
  /prashitha/gi,
  /vashit/gi,
  /vashita/gi,
  /vashitha/gi,
  /rashit/gi,
  /rashitha?/gi,
  // Benign names with "tit"
  /titiksha/gi,
  /titisha/gi,
  /tithi/gi,
  /titli/gi,
  /titas/gi,
  // Benign names with "gand"
  /gandhar/gi,
  /gandharv/gi,
  /gandharva/gi,
  /gandalf/gi,
  // South-Indian spellings that include "cum" (Tamil transliterations)
  /cumar/gi,
  /cumara/gi,
  /cumaran/gi,
  /cumaraswamy/gi,
  /coomar/gi,
  /coomara/gi,
  /coomaraswamy/gi,
  // Punjabi surname that includes "ass"
  /bassi/gi,
  // Swedish university name
  /lunduniversity|universityoflund/gi,
  // Romanized Hindi for "leave it" to avoid conflict with explicit "chod"
  /chh?odo/gi,         // chhodo / chodo
  /chh?oddo/gi,        // chhoddo / choddo
];

export function getSafePatternsNormalized() {
  // Always reflect current customSafePatternsNormalized at runtime
  return baseSafePatterns.concat(customSafePatternsNormalized);
}

// Optional: export raw name lists from data for convenience
const DATA_DIR = path.join(process.cwd(), 'data');
function loadNameList(basenameTxt, basenameJson) {
  const out = [];
  try {
    const p = path.join(DATA_DIR, basenameTxt);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      out.push(...raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
  } catch {}
  try {
    const p = path.join(DATA_DIR, basenameJson);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) out.push(...arr.filter((x) => typeof x === 'string'));
    }
  } catch {}
  return out;
}

export const indianNames = loadNameList('indian_names.txt', 'indian_names.json');
export const englishNames = loadNameList('english_names.txt', 'english_names.json');
