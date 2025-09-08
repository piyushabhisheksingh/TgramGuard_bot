// Learns explicit terms from a specific group via AI, and updates local detection
import { getRecentLogsSupabase, getRecentLogs } from '../logger.js';
import { extractExplicitTerms, classifyText as aiClassifyText } from '../ai/provider_openai.js';
import { addExplicitTerms, addSafeTerms } from '../filters/customTerms.js';
import { containsExplicit } from '../filters.js';

function boolEnv(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function startExplicitLearner(bot) {
  const AI_ON = boolEnv(process.env.AI_ENABLE);
  if (!AI_ON) return { stop: () => {} };
  // Optional: limit learning to a specific group. If not set, learn from all groups.
  const GROUP_ID = process.env.AI_LEARN_EXPLICIT_GROUP_ID || null;

  const INTERVAL = Math.max(10 * 60 * 1000, Number(process.env.AI_LEARN_EXPLICIT_INTERVAL_MS || 45 * 60 * 1000));
  const HORIZON = Math.max(50, Number(process.env.AI_LEARN_EXPLICIT_HORIZON || 400));
  const MINCOUNT = Math.max(1, Number(process.env.AI_LEARN_EXPLICIT_MINCOUNT || 2));
  const MAX_PER_RUN = Math.max(1, Number(process.env.AI_LEARN_EXPLICIT_MAX || 20));
  const SAFE_MINCOUNT = Math.max(1, Number(process.env.AI_LEARN_SAFE_MINCOUNT || 2));
  const SEX_THRESH = Number(process.env.AI_THRESH_SEXUAL || 0.7);

  async function fetchRecent(chatId, limit) {
    let logs = await getRecentLogsSupabase(limit, chatId);
    if (!logs || !logs.length) logs = getRecentLogs(limit, chatId);
    return logs || [];
  }

  function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

  async function tick() {
    try {
      const chatKey = GROUP_ID != null ? String(GROUP_ID) : null;
      const logs = await fetchRecent(chatKey, HORIZON);
      const texts = logs.map((r) => String(r.content || '').trim()).filter(Boolean);
      if (!texts.length) return;
      // Process in small batches to keep prompts short
      const batches = chunk(texts, 30);
      const counts = new Map();
      for (const b of batches) {
        const terms = await extractExplicitTerms(b);
        for (const t of terms) counts.set(t, (counts.get(t) || 0) + 1);
      }
      const picked = Array.from(counts.entries())
        .filter(([, c]) => c >= MINCOUNT)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_PER_RUN)
        .map(([t]) => t);
      if (!picked.length) return;
      const added = await addExplicitTerms(picked);
      if (added > 0) {
        try {
          const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
          if (LOG_CHAT_ID) {
            const lines = picked.map((t) => `• <code>${t}</code>`).join('\n');
            const scope = chatKey ? `group <code>${chatKey}</code>` : 'recent chats';
            await bot.api.sendMessage(LOG_CHAT_ID, `🤖 Learned <b>${added}</b> explicit term(s) from ${scope}:\n${lines}`, { parse_mode: 'HTML', disable_web_page_preview: true });
          }
        } catch {}
      }

      // Safelist benign tokens from AI-confirmed false positives on explicit
      const expViol = logs.filter((r) => {
        const v = String(r.violation || '').toLowerCase();
        return v === 'no_explicit' || v === 'name_no_explicit';
      });
      if (expViol.length) {
        const EVAL_CAP = Math.max(20, Number(process.env.AI_LEARN_SAFE_EVAL_CAP || 120));
        const countsSafe = new Map();
        for (const r of expViol.slice(0, EVAL_CAP)) {
          const content = String(r.content || '').trim();
          if (!content) continue;
          try {
            const ai = await aiClassifyText(content);
            if (!ai) continue;
            const score = (ai.scores?.['sexual'] || 0);
            const isSex = score >= SEX_THRESH || Boolean(ai.categories?.sexual) || Boolean(ai.flagged);
            if (isSex) continue; // not a false positive
            const tokens = (content.match(/[\p{L}\p{N}@#._-]+/gu) || []).map((t) => t.toLowerCase());
            for (const t of tokens) {
              if (t.length < 3 || t.length > 64) continue;
              if (!containsExplicit(t)) continue; // only risky-collision tokens
              countsSafe.set(t, (countsSafe.get(t) || 0) + 1);
            }
          } catch {}
        }
        const safelist = Array.from(countsSafe.entries())
          .filter(([, c]) => c >= SAFE_MINCOUNT)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_PER_RUN)
          .map(([t]) => t);
        if (safelist.length) {
          const res = await addSafeTerms(safelist);
          try {
            const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
            if (LOG_CHAT_ID) {
              const lines = safelist.map((t) => `• <code>${t}</code>`).join('\n');
              const scope = chatKey ? `in <code>${chatKey}</code>` : 'across recent chats';
              await bot.api.sendMessage(LOG_CHAT_ID, `🤖 Auto‑safelisted <b>${res.added || safelist.length}</b> term(s) from AI false positives ${scope}:\n${lines}`, { parse_mode: 'HTML', disable_web_page_preview: true });
            }
          } catch {}
        }
      }
    } catch (e) {
      // silent on failure
    }
  }

  const handle = setInterval(tick, INTERVAL);
  // initial delayed run
  setTimeout(tick, Math.min(60_000, Math.floor(INTERVAL / 2)));
  return { stop: () => clearInterval(handle) };
}
