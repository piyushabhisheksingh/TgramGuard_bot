// OpenAI provider utilities for AI-assisted moderation
// Enable with env: AI_ENABLE=true, AI_PROVIDER=openai, OPENAI_API_KEY
import OpenAI from 'openai';

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  client = new OpenAI({ apiKey: key });
  return client;
}

// Moderation classification using OpenAI Moderations API
// Returns {flagged:boolean, categories:object, scores:object} or null
export async function classifyText(text) {
  try {
    const c = getClient();
    if (!c) return null;
    const input = String(text || '').slice(0, 4000);
    if (!input) return { flagged: false, categories: {}, scores: {} };
    const res = await c.moderations.create({ model: 'omni-moderation-latest', input });
    const r = res?.results?.[0];
    if (!r) return null;
    return {
      flagged: Boolean(r.flagged),
      categories: { ...(r.categories || {}) },
      scores: { ...(r.category_scores || {}) },
    };
  } catch (_) {
    return null;
  }
}

// Link intent classifier using Chat Completions (JSON response)
// Returns { has_link: boolean } or null
export async function classifyLinks(text) {
  try {
    const c = getClient();
    if (!c) return null;
    const input = String(text || '').slice(0, 4000);
    if (!input) return { has_link: false };
    const model = process.env.AI_LINKS_MODEL || 'gpt-4o-mini';
    const prompt = `You are a strict URL detector. Decide if the following text contains a URL, invite link, handle link, or an obfuscated link intent (like "dot" instead of "."). Respond ONLY with a JSON object: {"has_link": true|false}.\n\nText:\n${input}`;
    const res = await c.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const out = res?.choices?.[0]?.message?.content || '';
    try { return JSON.parse(out); } catch { return null; }
  } catch (_) {
    return null;
  }
}

// Short lifestyle assessment; returns a short supportive paragraph (string) or null
export async function assessLifestyle(facts = {}) {
  try {
    const c = getClient();
    if (!c) return null;
    const model = process.env.AI_LIFESTYLE_MODEL || 'gpt-4o-mini';
    const prompt = `You are a supportive wellness coach drawing from ancient Indian wisdom (Ayurveda, Yoga, Bhagavad Gita, Vedas, Vedanta, Puranas, Shastras). Given these anonymized chat-activity facts, write 2–3 concise sentences with practical, compassionate suggestions about healthy routine (sleep regularity, mindful breaks, hydration, movement). Prefer simple practices like pranayama, gentle asanas, short meditation, sattvic routines (dinacharya). Avoid judgmental tone and medical claims; do not prescribe treatments. Facts: ${JSON.stringify(facts)}.`;
    const res = await c.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });
    const out = res?.choices?.[0]?.message?.content?.trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

// Analyze communication style/personality and return short constructive suggestions
export async function assessPersonality(facts = {}) {
  try {
    const c = getClient();
    if (!c) return null;
    const model = process.env.AI_PERSONALITY_MODEL || process.env.AI_LIFESTYLE_MODEL || 'gpt-4o-mini';
    const prompt = `You are a supportive coach drawing from ancient Indian texts (Yoga, Ayurveda, Bhagavad Gita, Vedas/Vedanta) with a modern, practical lens. Given anonymized chat-style facts, write 2–3 concise sentences: gently describe communication style and suggest improvements (clarity, compassion, balance) using ideas like ahimsa (non-harm), satya (truthful clarity), and mindful speech. Avoid judgmental tone and medical claims. Facts: ${JSON.stringify(facts)}.`;
    const res = await c.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });
    const out = res?.choices?.[0]?.message?.content?.trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

// Extract explicit words/short phrases actually present in the input texts.
// texts: string[]
// Returns string[] of lowercase terms; may be empty on failure.
export async function extractExplicitTerms(texts = []) {
  try {
    const c = getClient();
    if (!c) return [];
    const chunks = (texts || []).map((t, i) => `#${i + 1}: ${String(t || '').slice(0, 500)}`).join('\n');
    const model = process.env.AI_EXTRACT_MODEL || 'gpt-4o-mini';
    const prompt = `You are an assistant that extracts explicit/sexual words or short phrases that appear verbatim in the provided messages.\nRules:\n- Only include terms that are present in the texts.\n- Use lowercase.\n- Keep each term 2-32 characters, up to 3 words.\n- Output unique terms.\nRespond ONLY as JSON: {"terms":["..."]}\n\nMessages:\n${chunks}`;
    const res = await c.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const out = res?.choices?.[0]?.message?.content || '';
    let data;
    try { data = JSON.parse(out); } catch { return []; }
    const raw = Array.isArray(data?.terms) ? data.terms : [];
    return raw
      .map((s) => String(s || '').trim().toLowerCase())
      .filter((s) => s.length >= 2 && s.length <= 32)
      .slice(0, 100);
  } catch (_) {
    return [];
  }
}
