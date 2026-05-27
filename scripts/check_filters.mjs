#!/usr/bin/env node
// Quick assertions for explicit detection and safelist false positives
import { containsExplicit } from '../src/filters.js';
import { addSafeTerms, isSafeTermCandidate } from '../src/filters/customTerms.js';
import { securityMiddleware } from '../src/middleware/security.js';

const cases = [
  // Safelist false positives — should be false
  { text: 'This is a world class act.', expect: false, label: 'class (benign)' },
  { text: 'He will classify the books.', expect: false, label: 'classify (benign)' },
  { text: 'We did deep analysis of the data.', expect: false, label: 'analysis (benign)' },
  { text: 'We will analyze and then canal dredging.', expect: false, label: 'analyze/canal (benign)' },
  { text: 'Mahatma Gandhi was a great leader.', expect: false, label: 'gandhi (benign)' },
  { text: 'Shuttlecock and cocktail are sports and drinks.', expect: false, label: 'cocktail/shuttlecock (benign)' },
  { text: 'Cockroach and cockatoo are animals; Cockney is an accent.', expect: false, label: 'cockroach/cockatoo/cockney (benign)' },
  { text: 'Chem lab: titration today, bring your notebook.', expect: false, label: 'titration (benign)' },
  { text: 'A tiny titmouse perched on a branch.', expect: false, label: 'titmouse (benign)' },
  { text: 'Geometry uses circumference often.', expect: false, label: 'circumference (benign)' },
  { text: 'Cumin is a spice used in cooking.', expect: false, label: 'cumin (benign)' },
  { text: 'He is a sexton at the church; they studied sexagesimal numbers in math.', expect: false, label: 'sexton/sexagesimal (benign)' },
  { text: 'I live in Essex, not Sussex or Massachusetts.', expect: false, label: 'Essex/Sussex/Massachusetts (benign)' },
  { text: 'Renew my passport and passphrase.', expect: false, label: 'passport/passphrase (benign)' },
  // Normalized obfuscations still benign
  { text: 'Analy\u00adsis (soft hyphen) remains benign', expect: false, label: 'analysis with soft hyphen' },
  { text: 's3x', expect: false, label: 'no digit-to-letter replacement' },
  { text: 'ѕех', expect: false, label: 'no homoglyph-to-letter replacement' },
  { text: 'ｓｅｘ', expect: false, label: 'no fullwidth-to-letter replacement' },
  { text: 's\u00e9x', expect: false, label: 'no diacritic-to-letter replacement' },
  { text: 'chhotu', expect: false, label: 'no consonant/vowel substitution: chhotu' },
  { text: 'chotu', expect: false, label: 'no vowel substitution: chotu' },
  { text: 'chotiya', expect: false, label: 'no vowel substitution: chotiya' },
  { text: 'Shuttle.cock and cock.tail are benign dotted words.', expect: false, label: 'dot does not break safelisted words' },
  { text: 'This is genuine.text with punctuation.', expect: false, label: 'genuine dotted text' },
  { text: 'kutte', expect: false, label: 'low abuse kutte allowed' },
  { text: 'suar', expect: false, label: 'low abuse suar allowed' },
  { text: 'kutte suar', expect: false, label: 'low abuse phrase allowed' },
  // Explicit tokens — should be true
  { text: 'sex', expect: true, label: 'sex (explicit)' },
  { text: 's-e-x', expect: true, label: 'single-letter separator obfuscation' },
  { text: 's.e.x', expect: true, label: 'dot separator obfuscation' },
  { text: 'seeeex', expect: true, label: 'repeated-letter folding' },
  { text: 'chut', expect: true, label: 'chut (explicit)' },
  { text: 'choot', expect: true, label: 'choot (explicit)' },
  { text: 'chutiya', expect: true, label: 'chutiya (explicit)' },
  { text: 'pornhub link omitted', expect: true, label: 'pornhub (explicit)' },
  { text: 'mdrchod (hinglish explicit normalised)', expect: true, label: 'hinglish explicit' },
];

const safelistCases = [
  { text: 's-e-x', expect: false, label: 'reject punctuation-only explicit safelist' },
  { text: 'seeeex', expect: false, label: 'reject repeated-letter explicit safelist' },
  { text: 'sex education', expect: false, label: 'reject phrase containing exact explicit token' },
  { text: 'chhotu', expect: true, label: 'allow chhotu safelist' },
  { text: 'chotu', expect: true, label: 'allow chotu safelist' },
  { text: 'chutney', expect: true, label: 'allow benign risky-substring safelist' },
  { text: 'classroom', expect: true, label: 'allow benign ass-collision safelist' },
];

let failures = 0;
for (const c of cases) {
  let got = false;
  try { got = containsExplicit(c.text); } catch (e) { got = `error:${e?.message || e}`; }
  const ok = got === c.expect;
  // eslint-disable-next-line no-console
  console.log(`${ok ? '✅' : '❌'} ${c.label} — expect=${c.expect} got=${got}`);
  if (!ok) failures++;
}

for (const c of safelistCases) {
  let got = false;
  try { got = isSafeTermCandidate(c.text); } catch (e) { got = `error:${e?.message || e}`; }
  const ok = got === c.expect;
  // eslint-disable-next-line no-console
  console.log(`${ok ? '✅' : '❌'} ${c.label} — expect=${c.expect} got=${got}`);
  if (!ok) failures++;
}

const unsafeAdd = await addSafeTerms(['s-e-x', 'seeeex', 'sex education']);
if (unsafeAdd.added !== 0) {
  console.log(`❌ unsafe safelist persistence guard — expect=0 got=${unsafeAdd.added}`);
  failures++;
} else {
  console.log('✅ unsafe safelist persistence guard — expect=0 got=0');
}

let deletes = 0;
let nexts = 0;
const ctx = {
  chat: { id: -100123, type: 'supergroup', title: 'Test Group' },
  from: { id: 123456, first_name: 'Tester' },
  msg: { message_id: 1, text: 'chhotu' },
  me: { id: 999999 },
  api: {
    getChatMember: async (_chatId, userId) => (
      userId === 999999
        ? { status: 'administrator', can_delete_messages: true }
        : { status: 'member' }
    ),
    getChat: async () => ({ bio: '' }),
    deleteMessage: async () => { deletes += 1; },
    sendMessage: async () => ({ message_id: 2 }),
  },
};
await securityMiddleware()(ctx, async () => { nexts += 1; });
if (deletes !== 0 || nexts !== 1) {
  console.log(`❌ security middleware keeps chhotu — expect deletes=0 nexts=1 got deletes=${deletes} nexts=${nexts}`);
  failures++;
} else {
  console.log('✅ security middleware keeps chhotu — expect deletes=0 nexts=1');
}

if (failures) {
  console.error(`Failures: ${failures}`);
  process.exit(1);
} else {
  console.log('All filter assertions passed.');
}
