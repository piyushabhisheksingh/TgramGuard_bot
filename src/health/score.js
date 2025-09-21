import { getUserStatsPeriod, computeRiskScore } from '../logger.js';
import { getUserSummary } from '../store/health.js';
import { assessLifestyle, assessPersonality } from '../ai/provider_openai.js';

const bound = (value, min, max) => Math.max(min, Math.min(max, value));
const safeDivide = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);
const roundTo = (value, precision = 3) => (Number.isFinite(value) ? Number(value.toFixed(precision)) : 0);

// Compute a 0-100 health score (higher = better) from activity summary
export function computeHealthScore(summary) {
  if (!summary) return { score: 50, factors: {}, highlights: [] };

  let score = 75;
  const factors = {};

  const record = (key, delta = 0, meta = {}) => {
    const d = Number.isFinite(delta) ? delta : 0;
    const prev = factors[key] || { delta: 0 };
    const nextDelta = Math.round((prev.delta + d) * 10) / 10;
    factors[key] = { ...prev, ...meta, delta: nextDelta };
    score += d;
  };

  factors.baseline = { delta: 0, value: 75 };

  const sessions = summary.sessions || {};
  const activity = Array.isArray(summary.activity_by_hour) ? summary.activity_by_hour : [];
  const totalActivity = activity.reduce((acc, v) => acc + (v || 0), 0);
  const lateActivity = activity.reduce((acc, v, h) => acc + ((h <= 5 || h >= 22) ? (v || 0) : 0), 0);
  const daytimeActivity = activity.reduce((acc, v, h) => acc + ((h >= 7 && h <= 21) ? (v || 0) : 0), 0);
  const sortedActivity = activity.slice().sort((a, b) => (b || 0) - (a || 0));
  const peakHourCount = sortedActivity[0] || 0;
  const peak3Sum = (sortedActivity[0] || 0) + (sortedActivity[1] || 0) + (sortedActivity[2] || 0);

  const lateSessions = Number(sessions.late_total || 0);
  const totalSessions = Number(sessions.total || 0);
  let lateRatio = safeDivide(lateSessions, totalSessions);
  if (!Number.isFinite(lateRatio) || totalSessions === 0) {
    lateRatio = safeDivide(lateActivity, totalActivity);
  }
  const lateRatioRounded = roundTo(lateRatio, 3);
  let sleepDelta = 0;
  if (lateRatio >= 0.65) sleepDelta -= 18;
  else if (lateRatio >= 0.5) sleepDelta -= 14;
  else if (lateRatio >= 0.35) sleepDelta -= 10;
  else if (lateRatio >= 0.2) sleepDelta -= 6;
  else if (lateRatio >= 0.1) sleepDelta -= 3;
  if (lateRatio <= 0.05) sleepDelta += 6;
  else if (lateRatio <= 0.1) sleepDelta += 3;
  record('sleepBalance', sleepDelta, {
    lateRatio: lateRatioRounded,
    lateSessions,
    totalSessions,
    lateActivity,
    totalActivity,
    lateHoursSample: (summary.top_hours || []).filter((h) => h <= 5 || h >= 23),
  });

  const dayRatio = roundTo(safeDivide(daytimeActivity, totalActivity), 3);
  let dayDelta = 0;
  if (dayRatio > 0) {
    if (dayRatio < 0.35) dayDelta -= 8;
    else if (dayRatio < 0.5) dayDelta -= 5;
    else if (dayRatio >= 0.75) dayDelta += 4;
    else if (dayRatio >= 0.6) dayDelta += 2;
  }
  record('daytimeBalance', dayDelta, { daytimeRatio: dayRatio, daytimeActivity, totalActivity });

  const weekCount = Number(summary.week_count || 0);
  const monthCount = Number(summary.month_count || 0);
  let loadDelta = 0;
  if (weekCount > 1200) loadDelta -= 18;
  else if (weekCount > 950) loadDelta -= 14;
  else if (weekCount > 750) loadDelta -= 10;
  else if (weekCount > 600) loadDelta -= 6;
  else if (weekCount > 450) loadDelta -= 4;
  else if (weekCount >= 180 && weekCount <= 360) loadDelta += 6;
  else if (weekCount >= 120 && weekCount < 180) loadDelta += 4;
  else if (weekCount >= 60 && weekCount < 120) loadDelta += 2;
  else if (weekCount > 0 && weekCount < 25) loadDelta -= 3;
  record('activityLoad', loadDelta, { weekCount, monthCount, avgPerDay30: roundTo(safeDivide(monthCount, 30), 2) });

  const activeDays7 = Number(summary?.active_days?.last7 || 0);
  const activeDays30 = Number(summary?.active_days?.last30 || 0);
  const restDays7 = 7 - activeDays7;
  const restDays30 = 30 - activeDays30;
  let restDelta = 0;
  if (activeDays7 >= 7) restDelta -= 7;
  else if (activeDays7 === 6) restDelta -= 5;
  else if (activeDays7 === 5) restDelta -= 3;
  else if (activeDays7 >= 3 && activeDays7 <= 4) restDelta += 3;
  else if (activeDays7 <= 1 && weekCount > 0) restDelta -= 2;

  if (activeDays30 >= 27) restDelta -= 6;
  else if (activeDays30 >= 24) restDelta -= 3;
  else if (activeDays30 >= 12 && activeDays30 <= 22) restDelta += 3;
  else if (activeDays30 <= 6 && monthCount > 0) restDelta -= 3;
  record('restBalance', restDelta, { activeDays7, restDays7, activeDays30, restDays30 });

  const streak = Number(summary.streak_days || 0);
  const longestBreak = Number(summary.longest_break_days || 0);
  let consistencyDelta = 0;
  if (streak >= 30) consistencyDelta -= 7;
  else if (streak >= 21) consistencyDelta -= 5;
  else if (streak >= 14) consistencyDelta -= 3;
  else if (streak >= 6 && streak <= 12) consistencyDelta += 4;
  else if (streak >= 3) consistencyDelta += 2;
  else if (streak === 0 && weekCount > 0) consistencyDelta -= 2;
  if (longestBreak >= 7 && monthCount > 0) consistencyDelta -= 2;
  record('consistency', consistencyDelta, { streak, longestBreak });

  const avgPerActiveDay = activeDays7 > 0 ? weekCount / activeDays7 : weekCount;
  let intensityDelta = 0;
  if (avgPerActiveDay > 240) intensityDelta -= 10;
  else if (avgPerActiveDay > 180) intensityDelta -= 7;
  else if (avgPerActiveDay > 140) intensityDelta -= 5;
  else if (avgPerActiveDay > 110) intensityDelta -= 3;
  else if (avgPerActiveDay >= 45 && avgPerActiveDay <= 110) intensityDelta += 4;
  else if (avgPerActiveDay > 0 && avgPerActiveDay < 20) intensityDelta -= 2;
  record('intensity', intensityDelta, { avgPerActiveDay: roundTo(avgPerActiveDay, 1) });

  const avgLen = Number(summary.avg_message_len || 0);
  let lengthDelta = 0;
  if (avgLen > 600) lengthDelta -= 8;
  else if (avgLen > 420) lengthDelta -= 6;
  else if (avgLen > 320) lengthDelta -= 3;
  else if (avgLen >= 70 && avgLen <= 180) lengthDelta += 2;
  else if (avgLen > 0 && avgLen < 25 && weekCount > 0) lengthDelta -= 1;
  record('messageLength', lengthDelta, { avgLen });

  const comms = summary.comms || {};
  const msgs = Number(comms.msgs || 0);
  const chars = Number(comms.chars || 0);
  const uppercaseRatio = chars > 0 ? (comms.uppercase_chars || 0) / chars : 0;
  const exclamPerMsg = safeDivide(comms.excls || 0, msgs);
  const questionPerMsg = safeDivide(comms.questions || 0, msgs);
  const emojiPerMsg = safeDivide(comms.emojis || 0, msgs);
  const politeRatio = safeDivide(comms.polite_hits || 0, msgs);
  const toxicRatio = safeDivide(comms.toxic_hits || 0, msgs);
  let toneDelta = 0;
  if (uppercaseRatio >= 0.25) toneDelta -= 8;
  else if (uppercaseRatio >= 0.18) toneDelta -= 5;
  else if (uppercaseRatio <= 0.08 && msgs > 50) toneDelta += 2;

  if (exclamPerMsg >= 2) toneDelta -= 5;
  else if (exclamPerMsg >= 1.2) toneDelta -= 3;

  if (emojiPerMsg >= 1.5) toneDelta += 2;
  else if (emojiPerMsg >= 0.7) toneDelta += 1;

  if (questionPerMsg >= 0.22) toneDelta += 3;
  else if (questionPerMsg >= 0.15) toneDelta += 1;

  if (politeRatio >= 0.09) toneDelta += 3;
  else if (politeRatio >= 0.05) toneDelta += 1;

  if (toxicRatio >= 0.2) toneDelta -= 8;
  else if (toxicRatio >= 0.12) toneDelta -= 5;
  else if (toxicRatio >= 0.05) toneDelta -= 2;

  if (comms.analyzed > 0) {
    const toxAvg = safeDivide(comms.toxicity_sum || 0, comms.analyzed);
    if (toxAvg > 0.45) toneDelta -= 4;
    else if (toxAvg > 0.28) toneDelta -= 2;
  }

  record('communicationTone', toneDelta, {
    uppercaseRatio: roundTo(uppercaseRatio, 3),
    exclamPerMsg: roundTo(exclamPerMsg, 3),
    questionPerMsg: roundTo(questionPerMsg, 3),
    emojiPerMsg: roundTo(emojiPerMsg, 3),
    politeRatio: roundTo(politeRatio, 3),
    toxicRatio: roundTo(toxicRatio, 3),
    analyzed: comms.analyzed || 0,
  });

  const daily = summary.daily || {};
  const daily7 = daily.last7 || {};
  const avg7 = Number(daily7.average || 0);
  const std7 = Number(daily7.std || 0);
  let rhythmDelta = 0;
  if (avg7 > 0) {
    const cv = std7 / Math.max(avg7, 1e-6);
    if (cv >= 1.2) rhythmDelta -= 8;
    else if (cv >= 0.9) rhythmDelta -= 5;
    else if (cv >= 0.6) rhythmDelta -= 3;
    else if (cv <= 0.3) rhythmDelta += 4;
    else if (cv <= 0.45) rhythmDelta += 2;
    record('dailyRhythm', rhythmDelta, {
      average: roundTo(avg7, 3),
      std: roundTo(std7, 3),
      cv: roundTo(std7 / Math.max(avg7, 1e-6), 3),
      zeros: daily7.zeros || 0,
    });
  } else {
    record('dailyRhythm', rhythmDelta, {
      average: 0,
      std: 0,
      cv: 0,
      zeros: daily7.zeros || 0,
    });
  }

  const weekendRatio = Number(daily.weekend_ratio || 0);
  let weekendDelta = 0;
  if (summary.month_count > 0) {
    if (weekendRatio >= 0.55) weekendDelta -= 8;
    else if (weekendRatio >= 0.45) weekendDelta -= 6;
    else if (weekendRatio >= 0.35) weekendDelta -= 4;
    else if (weekendRatio <= 0.12 && summary.week_count > 80) weekendDelta += 4;
    else if (weekendRatio <= 0.08 && summary.week_count > 150) weekendDelta += 6;
  }
  record('weekendRest', weekendDelta, {
    weekendRatio: roundTo(weekendRatio, 3),
    weekendActivity: daily.weekend_activity || 0,
    weekendActiveDays: daily.weekend_active_days || 0,
  });

  let burstDelta = 0;
  if (totalActivity > 0) {
    const peakHourRatio = safeDivide(peakHourCount, totalActivity);
    const peak3Ratio = safeDivide(peak3Sum, totalActivity);
    if (peakHourRatio >= 0.35) burstDelta -= 7;
    else if (peakHourRatio >= 0.28) burstDelta -= 5;
    else if (peakHourRatio >= 0.22) burstDelta -= 3;
    if (peak3Ratio >= 0.7) burstDelta -= 5;
    else if (peak3Ratio >= 0.6) burstDelta -= 3;
    if (peakHourRatio <= 0.16 && peak3Ratio <= 0.45 && totalActivity >= 40) burstDelta += 4;
    record('burstBalance', burstDelta, {
      peakHourRatio: roundTo(peakHourRatio, 3),
      peak3Ratio: roundTo(peak3Ratio, 3),
      peakHourCount,
      totalActivity,
    });
  } else {
    record('burstBalance', burstDelta, {
      peakHourRatio: 0,
      peak3Ratio: 0,
      peakHourCount: 0,
      totalActivity: 0,
    });
  }

  score = bound(Math.round(score), 0, 100);

  const highlightConfig = {
    sleepBalance: { positive: 'Sleep rhythm looks consistent', negative: 'Late-night activity is too high' },
    daytimeBalance: { positive: 'Activity stays within daytime hours', negative: 'Most activity happens outside daytime' },
    activityLoad: { positive: 'Weekly activity volume is balanced', negative: 'Chat load is extremely high' },
    restBalance: { positive: 'You are keeping regular rest days', negative: 'No full rest days recently' },
    consistency: { positive: 'Routine streak is steady', negative: 'Very long streak with no downtime' },
    intensity: { positive: 'Daily message load is moderate', negative: 'Daily message load is intense' },
    messageLength: { positive: 'Message length stays manageable', negative: 'Messages are very long on average' },
    communicationTone: { positive: 'Tone is calm and polite', negative: 'Tone shows caps/exclamations/toxicity' },
    dailyRhythm: { positive: 'Daily activity stays consistent', negative: 'Daily activity swings heavily' },
    weekendRest: { positive: 'Weekends look restorative', negative: 'Heavy weekend activity; schedule downtime' },
    burstBalance: { positive: 'Activity spread is well-paced', negative: 'Activity spikes around a few hours' },
  };

  const highlights = [];
  for (const [key, labels] of Object.entries(highlightConfig)) {
    const delta = factors[key]?.delta || 0;
    if (delta <= -4) highlights.push(labels.negative);
    else if (delta >= 4) highlights.push(labels.positive);
  }

  return { score, factors, highlights: highlights.slice(0, 4) };
}

// Compute a 0-100 discipline score from per-user violations (higher = better)
export async function computeDisciplineScore(userId, chatId = null) {
  try {
    const weekly = await getUserStatsPeriod(userId, chatId, 7);
    const byV = weekly?.byViolation || {};
    const risk = computeRiskScore(byV); // larger = worse
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    let score = Math.round(100 - clamp(risk * 5, 0, 100));
    // Incorporate online active status (sessions) — late-night sessions reduce discipline
    try {
      const summary = await getUserSummary(userId);
      const sess = summary?.sessions;
      if (sess && sess.total > 0) {
        const lateRatio = (sess.late_total || 0) / Math.max(1, sess.total);
        if (lateRatio >= 0.6) score -= 12; else if (lateRatio >= 0.4) score -= 8; else if (lateRatio >= 0.25) score -= 4;
        // Very long streaks with many late sessions get an extra nudge
        if ((summary?.streak_days || 0) >= 14 && lateRatio >= 0.4) score -= 4;
      }
      // Communication style discipline factors
      const c = summary?.comms;
      if (c && c.msgs > 0) {
        const linkRatio = c.links / Math.max(1, c.msgs);
        if (linkRatio >= 0.7) score -= 10; else if (linkRatio >= 0.4) score -= 6; else if (linkRatio >= 0.2) score -= 3;
        const upperRatio = c.uppercase_chars / Math.max(1, c.chars);
        if (upperRatio >= 0.25) score -= 8; else if (upperRatio >= 0.15) score -= 4;
        const exclamPerMsg = c.excls / Math.max(1, c.msgs);
        if (exclamPerMsg >= 2) score -= 6; else if (exclamPerMsg >= 1) score -= 3;
        const questionPerMsg = c.questions / Math.max(1, c.msgs);
        if (questionPerMsg >= 0.2) score += 2; // inquisitiveness is positive
        // Politeness vs toxicity keywords
        const politeRatio = c.polite_hits / Math.max(1, c.msgs);
        if (politeRatio >= 0.1) score += 3;
        const toxicRatio = c.toxic_hits / Math.max(1, c.msgs);
        if (toxicRatio >= 0.2) score -= 10; else if (toxicRatio >= 0.1) score -= 6; else if (toxicRatio >= 0.05) score -= 3;
        // Optional AI moderation averages
        if (c.analyzed > 0) {
          const toxAvg = c.toxicity_sum / c.analyzed;
          if (toxAvg > 0.5) score -= 10; else if (toxAvg > 0.3) score -= 6; else if (toxAvg > 0.15) score -= 3;
        }
      }
    } catch {}
    score = clamp(Math.round(score), 0, 100);
    return { score, risk, byViolation: byV };
  } catch {
    return { score: 50, risk: 0, byViolation: {} };
  }
}

export function categorize(score) {
  if (score >= 85) return { label: 'Excellent', color: 'green' };
  if (score >= 70) return { label: 'Good', color: 'teal' };
  if (score >= 55) return { label: 'Fair', color: 'yellow' };
  if (score >= 40) return { label: 'At Risk', color: 'orange' };
  return { label: 'Severe', color: 'red' };
}

// Optional AI-based short assessment using OpenAI if configured
export async function aiAssessment(summary, discipline) {
  try {
    const enabled = String(process.env.AI_ENABLE || '').toLowerCase();
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    if (!(enabled === '1' || enabled === 'true') || provider !== 'openai') return null;
    const facts = {
      week_count: summary?.week_count,
      month_count: summary?.month_count,
      streak_days: summary?.streak_days,
      top_hours: summary?.top_hours,
      avg_message_len: summary?.avg_message_len,
      discipline_score: discipline?.score,
      risk: discipline?.risk,
    };
    const out = await assessLifestyle(facts);
    return out;
  } catch {
    return null;
  }
}

export function buildStyleTraits(summary) {
  const c = summary?.comms || {};
  const msgs = c.msgs || 0;
  const traits = [];
  if (msgs) {
    const avgLen = (c.chars || 0) / msgs;
    if (avgLen >= 400) traits.push('verbose'); else if (avgLen <= 40) traits.push('concise');
    const emojiPerMsg = (c.emojis || 0) / msgs; if (emojiPerMsg >= 1) traits.push('emotive');
    const exPerMsg = (c.excls || 0) / msgs; if (exPerMsg >= 1) traits.push('excitable');
    const qPerMsg = (c.questions || 0) / msgs; if (qPerMsg >= 0.2) traits.push('inquisitive');
    const linkRatio = (c.links || 0) / msgs; if (linkRatio >= 0.3) traits.push('promotional');
    const upperRatio = (c.uppercase_chars || 0) / Math.max(1, c.chars || 0); if (upperRatio >= 0.2) traits.push('shouty');
  }
  return traits;
}

export async function aiPersonalityAssessment(summary) {
  try {
    const enabled = String(process.env.AI_ENABLE || '').toLowerCase();
    const provider = String(process.env.AI_PROVIDER || '').toLowerCase();
    if (!(enabled === '1' || enabled === 'true') || provider !== 'openai') return null;
    const c = summary?.comms || {};
    const facts = {
      msgs: c.msgs,
      avg_len: c.msgs ? Math.round((c.chars || 0) / c.msgs) : 0,
      emoji_per_msg: c.msgs ? (c.emojis || 0) / c.msgs : 0,
      exclam_per_msg: c.msgs ? (c.excls || 0) / c.msgs : 0,
      question_per_msg: c.msgs ? (c.questions || 0) / c.msgs : 0,
      link_ratio: c.msgs ? (c.links || 0) / c.msgs : 0,
      uppercase_ratio: c.chars ? (c.uppercase_chars || 0) / c.chars : 0,
      polite_ratio: c.msgs ? (c.polite_hits || 0) / c.msgs : 0,
      toxic_ratio: c.msgs ? (c.toxic_hits || 0) / c.msgs : 0,
    };
    return await assessPersonality(facts);
  } catch {
    return null;
  }
}
