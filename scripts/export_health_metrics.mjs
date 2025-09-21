#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { getAllUserSummaries } from '../src/store/health.js';
import { computeHealthScore } from '../src/health/score.js';

const args = process.argv.slice(2);
const options = { format: 'csv', limit: null, includeOptOut: false, output: null };
for (const arg of args) {
  if (arg === '--json') options.format = 'json';
  else if (arg === '--csv') options.format = 'csv';
  else if (arg === '--include-optout') options.includeOptOut = true;
  else if (arg.startsWith('--limit=')) options.limit = Number(arg.split('=')[1] || '');
  else if (arg.startsWith('--output=')) options.output = arg.split('=')[1] || null;
  else if (arg === '--help') {
    printHelp();
    process.exit(0);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/export_health_metrics.mjs [options]

Options:
  --csv                 Output CSV (default)
  --json                Output JSON rows
  --limit=N             Limit number of users processed
  --include-optout      Include users who opted out of health tracking
  --output=PATH         Write to file instead of stdout
  --help                Show this help message
`);
}

const rows = await getAllUserSummaries({ includeOptOut: options.includeOptOut, limit: options.limit });

const data = rows.map(({ userId, summary }) => {
  const { score, factors } = computeHealthScore(summary);
  const sleep = factors.sleepBalance || {};
  const rest = factors.restBalance || {};
  const weekend = factors.weekendRest || {};
  const rhythm = factors.dailyRhythm || {};
  const tone = factors.communicationTone || {};
  const burst = factors.burstBalance || {};
  const activity = factors.activityLoad || {};
  return {
    user_id: userId,
    last_seen: summary.last_seen,
    health_score: score,
    week_count: summary.week_count,
    month_count: summary.month_count,
    active_days_7: summary?.active_days?.last7 ?? 0,
    rest_days_7: 7 - (summary?.active_days?.last7 ?? 0),
    active_days_30: summary?.active_days?.last30 ?? 0,
    longest_break_days: summary.longest_break_days ?? 0,
    weekend_ratio: summary?.daily?.weekend_ratio ?? 0,
    weekend_activity: summary?.daily?.weekend_activity ?? 0,
    weekday_activity: summary?.daily?.weekday_activity ?? 0,
    weekend_active_days: summary?.daily?.weekend_active_days ?? 0,
    weekday_active_days: summary?.daily?.weekday_active_days ?? 0,
    daily_avg_7: summary?.daily?.last7?.average ?? 0,
    daily_std_7: summary?.daily?.last7?.std ?? 0,
    avg_message_len: summary.avg_message_len ?? 0,
    top_hours: (summary.top_hours || []).join(';'),
    sleep_delta: sleep.delta ?? 0,
    weekend_delta: weekend.delta ?? 0,
    rhythm_delta: rhythm.delta ?? 0,
    rest_delta: rest.delta ?? 0,
    activity_delta: activity.delta ?? 0,
    tone_delta: tone.delta ?? 0,
    burst_delta: burst.delta ?? 0,
  };
});

let output = '';
if (options.format === 'json') {
  output = JSON.stringify(data, null, 2);
} else {
  const headers = Object.keys(data[0] || { user_id: null });
  const escape = (value) => {
    if (value == null) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of data) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  output = lines.join('\n');
}

if (options.output) {
  const filePath = path.resolve(process.cwd(), options.output);
  await fs.writeFile(filePath, output, 'utf8');
  console.error(`Exported ${data.length} rows to ${filePath}`);
} else {
  process.stdout.write(output);
}
