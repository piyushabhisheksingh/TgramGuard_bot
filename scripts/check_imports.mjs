#!/usr/bin/env node
// Import-sanity check: attempts to import every JS module in src except entrypoints.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.cwd(), 'src');
const SKIP = new Set([
  path.resolve(process.cwd(), 'src/bot.js'), // entrypoint starts servers/runners
]);

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((p) => !SKIP.has(p));
let failures = 0;
for (const file of files) {
  try {
    // eslint-disable-next-line no-await-in-loop
    await import(pathToFileURL(file));
    console.log(`✅ imported ${path.relative(process.cwd(), file)}`);
  } catch (e) {
    failures++;
    console.error(`❌ failed ${path.relative(process.cwd(), file)}: ${e?.message || e}`);
  }
}

if (failures) {
  console.error(`Import failures: ${failures}`);
  process.exit(1);
} else {
  console.log('All modules imported successfully.');
}

