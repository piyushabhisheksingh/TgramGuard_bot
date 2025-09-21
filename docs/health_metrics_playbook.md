# Health Metrics Calibration Playbook

Use these steps to capture real-user snapshots and tune the new pacing thresholds.

## 1. Export recent summaries

Run the exporter to dump the current health snapshot for every tracked user. By default it writes CSV to stdout; redirect to a dated file so you can compare runs.

```bash
npm run health:export -- --output=data/health_metrics_$(date +%Y%m%d).csv
```

Arguments:

- `--limit=100` — cap the number of users if you just want a quick sample.
- `--json` — emit JSON instead of CSV (useful if importing into notebooks).
- `--include-optout` — include users who opted out (normally skipped).

The CSV includes the health score, week/month activity counts, the new `weekend_ratio`, 7-day daily standard deviation (`daily_std_7`), and factor deltas such as `sleep_delta`, `weekend_delta`, and `burst_delta`.

## 2. Chart pacing signals

Load the CSV into your preferred tool (Sheets, Excel, Observable, Jupyter). Focus on:

- `weekend_ratio` (convert to %): check distribution and flag the 75th/90th percentile to see if the current penalty bands (≥35%, ≥45%, ≥55%) fire too often.
- `daily_std_7`: large values indicate “feast-or-famine” days. Plot against `health_score` to confirm the negative slope around the 0.6/0.9 coefficient of variation thresholds.
- Factor columns (`sleep_delta`, `weekend_delta`, `burst_delta`) to tally how often each goes ≤ -4 or ≥ 4.

## 3. Spot-check edge cases

Filter rows near boundary conditions (e.g., weekend_ratio between 0.32 and 0.38) and review the raw summaries in `data/health.json` or via `/health_user` to judge whether the penalties feel justified. Adjust thresholds in `src/health/score.js` accordingly, rerun the exporter, and compare before/after histograms.

## 4. Monitor over time

Scheduling the export via cron (daily/weekly) lets you accumulate snapshots for trend analysis. Because the exporter only relies on local `data/health.json`/Supabase hydration, it is safe to run from any bot node with access to the same persistence.

## 5. Surface metrics to admins

The `/health` and `/health_user` commands now display:

- `Pacing: weekend NN% · 7d std MM`

Encourage admins to keep an eye on these values; if they appear consistently high for “healthy” users, relax the penalty bands, and if they barely move even for intense usage, tighten them.

