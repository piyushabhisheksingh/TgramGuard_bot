import { getUserStatsPeriod, computeRiskScore } from '../logger.js';
import { getUserSummary } from '../store/health.js';
import { assessLifestyle, assessPersonality } from '../ai/provider_openai.js';

// Compute a 0-100 health score (higher = better) from activity summary
export function computeHealthScore(summary) {
  if (!summary) return { score: 50, factors: {} };
  const f = {};
  // Baseline
  let score = 70;
  // Very late activity penalizes
  const late = summary.top_hours.filter((h) => h <= 5 || h >= 23).length;
  f.lateHours = late;
  score -= late * 6; // up to -18
  // Extremely high weekly message count can indicate overuse
  f.weekCount = summary.week_count;
  if (summary.week_count > 800) score -= 15; else if (summary.week_count > 500) score -= 8; else if (summary.week_count < 100) score += 5;
  // Very long average messages could signal fatigue/context-switch
  f.avgLen = summary.avg_message_len;
  if (summary.avg_message_len > 500) score -= 10; else if (summary.avg_message_len > 300) score -= 5;
  // Consistent streaks are positive if not excessive
  f.streak = summary.streak_days;
  if (summary.streak_days >= 7) score += 6; if (summary.streak_days >= 30) score -= 6; // too long without breaks
  // Bound to 0-100
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, factors: f };
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
