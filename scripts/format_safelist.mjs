#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function uniqCasePreserving(lines) {
  const seen = new Map(); // key(lowercased normalized) -> original
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, raw);
  }
  return Array.from(seen.values());
}

function sortUnicode(arr) {
  return arr.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function splitHeader(fileText) {
  const lines = fileText.replace(/\r\n/g, '\n').split('\n');
  const header = [];
  let i = 0;
  // preserve initial comment/blank block as header
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '' || l.trim().startsWith('#')) { header.push(l); i++; continue; }
    break;
  }
  const rest = lines.slice(i);
  return { header, rest };
}

function processFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const { header, rest } = splitHeader(raw);
    const dataLines = rest
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const unique = uniqCasePreserving(dataLines);
    const sorted = sortUnicode(unique);
    const out = [...header, ...(header.length && header[header.length - 1] !== '' ? [''] : []), ...sorted].join('\n');
    fs.writeFileSync(file, out.endsWith('\n') ? out : out + '\n', 'utf8');
    return { file, ok: true, count: sorted.length };
  } catch (e) {
    return { file, ok: false, error: e?.message || String(e) };
  }
}

function parseArgs(argv) {
  const out = { files: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files' || a === '-f') {
      const v = argv[++i] || '';
      out.files.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      out.files.push(a);
    }
  }
  return out;
}

const DEFAULT_FILES = [
  'data/safe_terms_custom.txt',
  'data/hinglish_words.txt',
  'data/hindi_words.txt',
  'data/english_words.txt',
  'data/indian_names.txt',
  'data/english_names.txt',
];

const { files } = parseArgs(process.argv);
const targets = (files.length ? files : DEFAULT_FILES).map((p) => path.resolve(process.cwd(), p));

const results = targets.map(processFile);
for (const r of results) {
  if (r.ok) console.log(`[safelist] formatted ${r.file} (entries: ${r.count})`);
  else console.warn(`[safelist] failed ${r.file}: ${r.error}`);
}

