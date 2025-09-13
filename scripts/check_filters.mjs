#!/usr/bin/env node
// Quick assertions for explicit detection and safelist false positives
import { containsExplicit } from '../src/filters.js';

const cases = [
  // Safelist false positives — should be false
  { text: 'This is a world class act.', expect: false, label: 'class (benign)' },
  { text: 'We did deep analysis of the data.', expect: false, label: 'analysis (benign)' },
  { text: 'Mahatma Gandhi was a great leader.', expect: false, label: 'gandhi (benign)' },
  // Normalized obfuscations still benign
  { text: 'Analy\u00adsis (soft hyphen) remains benign', expect: false, label: 'analysis with soft hyphen' },
  // Explicit tokens — should be true
  { text: 'sex', expect: true, label: 'sex (explicit)' },
  { text: 'pornhub link omitted', expect: true, label: 'pornhub (explicit)' },
  { text: 'mdrchod (hinglish explicit normalised)', expect: true, label: 'hinglish explicit' },
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

if (failures) {
  console.error(`Failures: ${failures}`);
  process.exit(1);
} else {
  console.log('All filter assertions passed.');
}

