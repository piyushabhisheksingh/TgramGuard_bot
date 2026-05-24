import { numberEnv } from '../config.js';

const floodState = new Map(); // key -> number[] timestamps (ms)
const duplicateState = new Map(); // key -> { text: string, count: number, lastTs: number }
const newMemberProbationState = new Map(); // key -> until timestamp (ms)
let lastPruneAt = 0;

export const FLOOD_WINDOW_MS = numberEnv('FLOOD_WINDOW_SECONDS', 10, { min: 1 }) * 1000;
export const FLOOD_MAX_MESSAGES = numberEnv('FLOOD_MAX_MESSAGES', 6, { min: 2, integer: true });
export const FLOOD_MUTE_SECONDS = numberEnv('FLOOD_MUTE_SECONDS', 60, { min: 0, integer: true });

const DUP_WINDOW_MS = numberEnv('DUPLICATE_WINDOW_SECONDS', 120, { min: 1 }) * 1000;
const DUP_REPEAT_LIMIT = numberEnv('DUPLICATE_REPEAT_LIMIT', 3, { min: 2, integer: true });
const DUP_MIN_LENGTH = numberEnv('DUPLICATE_MIN_LENGTH', 8, { min: 1, integer: true });

const NEW_MEMBER_PROBATION_MS = numberEnv('NEW_MEMBER_PROBATION_MINUTES', 30, { min: 0 }) * 60 * 1000;

function spamStateKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function normalizeDuplicateText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function pruneSpamState(now = Date.now()) {
  if (now - lastPruneAt < 30 * 1000) return;
  lastPruneAt = now;
  for (const [key, arr] of floodState.entries()) {
    const recent = (arr || []).filter((ts) => now - ts <= FLOOD_WINDOW_MS);
    if (!recent.length) floodState.delete(key);
    else floodState.set(key, recent);
  }
  for (const [key, row] of duplicateState.entries()) {
    if (!row || now - Number(row.lastTs || 0) > DUP_WINDOW_MS) duplicateState.delete(key);
  }
  for (const [key, until] of newMemberProbationState.entries()) {
    if (!Number.isFinite(until) || until <= now) newMemberProbationState.delete(key);
  }
}

export function isFloodViolation(chatId, userId, now = Date.now()) {
  const key = spamStateKey(chatId, userId);
  const cur = floodState.get(key) || [];
  const recent = cur.filter((ts) => now - ts <= FLOOD_WINDOW_MS);
  recent.push(now);
  floodState.set(key, recent);
  return recent.length > FLOOD_MAX_MESSAGES;
}

export function isDuplicateViolation(chatId, userId, rawText, now = Date.now()) {
  const normalized = normalizeDuplicateText(rawText);
  if (!normalized || normalized.length < DUP_MIN_LENGTH) return false;
  const key = spamStateKey(chatId, userId);
  const cur = duplicateState.get(key);
  if (!cur || cur.text !== normalized || now - cur.lastTs > DUP_WINDOW_MS) {
    duplicateState.set(key, { text: normalized, count: 1, lastTs: now });
    return false;
  }
  const next = { text: normalized, count: cur.count + 1, lastTs: now };
  duplicateState.set(key, next);
  return next.count >= DUP_REPEAT_LIMIT;
}

export function isUnderNewMemberProbation(chatId, userId, now = Date.now()) {
  const key = spamStateKey(chatId, userId);
  const until = newMemberProbationState.get(key);
  if (!Number.isFinite(until)) return false;
  if (until <= now) {
    newMemberProbationState.delete(key);
    return false;
  }
  return true;
}

export function markNewMemberJoined(chatId, userId) {
  if (!Number.isFinite(chatId) || !Number.isFinite(userId)) return;
  if (NEW_MEMBER_PROBATION_MS <= 0) return;
  newMemberProbationState.set(spamStateKey(chatId, userId), Date.now() + NEW_MEMBER_PROBATION_MS);
}
