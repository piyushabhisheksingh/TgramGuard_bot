import {
  textHasLink,
  entitiesContainLink,
  containsExplicit,
  overCharLimit,
} from '../filters.js';
import { getEffectiveRules, getEffectiveMaxLen, getBlacklistEntry } from '../store/settings.js';
import { logAction, getUserRiskSummary, buildFunnyPrefix, removeChatPresenceUsers } from '../logger.js';
import { MUTE_PERMISSIONS } from '../config.js';
import { isBotPrivileged, isExempt } from '../services/auth.js';
import {
  FLOOD_MUTE_SECONDS,
  isDuplicateViolation,
  isFloodViolation,
  isUnderNewMemberProbation,
  markNewMemberJoined,
  pruneSpamState,
} from '../services/spamState.js';
import {
  codeMention,
  displayName,
  ensureBotCanDelete,
  escapeHtml,
  isGroupChat,
  notifyAndCleanup,
} from '../services/telegram.js';

export { markNewMemberJoined };

// Cache for user bio moderation status to reduce API calls.
// Entries expire automatically so users are re-checked after updating their bio.
// Map<userId, { until: number, data: { hasLink: boolean, hasExplicit: boolean, bio: string } }>
const bioModerationCache = new Map();
const BIO_CACHE_TTL_MS_RAW = Number(process.env.BIO_CACHE_TTL_MS);
const BIO_CACHE_TTL_MS = Number.isFinite(BIO_CACHE_TTL_MS_RAW)
  ? Math.max(0, BIO_CACHE_TTL_MS_RAW)
  : 5 * 1000;

function messageHasMedia(msg = {}) {
  return Boolean(
    msg.photo ||
      msg.video ||
      msg.document ||
      msg.audio ||
      msg.voice ||
      msg.video_note ||
      msg.animation ||
      msg.sticker ||
      msg.contact ||
      msg.location ||
      msg.venue ||
      msg.poll
  );
}

// Cache funny prefixes briefly so risk labels rehydrate quickly after log changes.
const funnyPrefixCache = new Map(); // key `${chatId}:${userId}` -> { until, prefix }
async function userPrefix(ctx, user, currentViolation) {
  const chatId = ctx.chat?.id;
  const userId = user?.id;
  if (!Number.isFinite(chatId) || !Number.isFinite(userId)) return '';
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const cached = funnyPrefixCache.get(key);
  if (cached && cached.until > now) return cached.prefix;
  try {
    const { label, topViolation } = await getUserRiskSummary(userId, chatId);
    const chosenType = currentViolation || topViolation;
    const prefix = buildFunnyPrefix(label, chosenType);
    funnyPrefixCache.set(key, { until: now + 5 * 1000, prefix });
    return prefix;
  } catch {
    return '';
  }
}

async function mentionWithPrefix(ctx, user, currentViolation) {
  const pref = await userPrefix(ctx, user, currentViolation);
  return `${pref}${codeMention(user)}`;
}

async function mentionPlainWithPrefix(ctx, user, currentViolation) {
  const pref = await userPrefix(ctx, user, currentViolation);
  const id = user?.id ?? '?';
  return `${pref}<code>${escapeHtml(String(id))}</code>`;
}

async function enforceGlobalBlacklist(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!Number.isFinite(userId) || !Number.isFinite(chatId)) return false;
  if (await isBotPrivileged(userId)) return false;
  const entry = await getBlacklistEntry(userId);
  if (!entry) return false;
  const action = entry.action === 'mute' ? 'mute' : 'kick';
  const reason = entry.reason ? entry.reason.slice(0, 180) : '';
  const reasonHtml = reason ? ` Reason: <i>${escapeHtml(reason)}</i>` : '';
  const messageId = ctx.msg?.message_id;
  if (messageId && (await ensureBotCanDelete(ctx))) {
    try { await ctx.api.deleteMessage(chatId, messageId); } catch {}
  }
  let success = false;
  try {
    if (action === 'mute') {
      await ctx.api.restrictChatMember(chatId, userId, { permissions: MUTE_PERMISSIONS });
      success = true;
    } else {
      await ctx.api.banChatMember(chatId, userId, { until_date: Math.floor(Date.now() / 1000) + 60 });
      success = true;
      try { await ctx.api.unbanChatMember(chatId, userId); } catch {}
      try { await removeChatPresenceUsers(chatId, [userId]); } catch {}
    }
  } catch (err) {
    const errMsg = String(err?.description || err?.message || err || '').slice(0, 160);
    await logAction(ctx, {
      action: 'global_blacklist_failed',
      action_type: 'security',
      violation: 'blacklist',
      user: ctx.from,
      chat: ctx.chat,
      content: `action=${action}; error=${errMsg}`,
    });
    return false;
  }
  if (success) {
    await notifyAndCleanup(
      ctx,
      `🚫 ${await mentionPlainWithPrefix(ctx, ctx.from, 'blacklist')} <b>${action === 'mute' ? 'muted by global blacklist' : 'removed by global blacklist'}</b>.${reasonHtml}`,
      10
    );
    await logAction(ctx, {
      action: action === 'mute' ? 'global_blacklist_mute' : 'global_blacklist_kick',
      action_type: 'security',
      violation: 'blacklist',
      user: ctx.from,
      chat: ctx.chat,
      content: `action=${action}; reason=${reason || '-'}; enforced=1`,
    });
  }
  return true;
}

function readBioCache(userId) {
  const cached = bioModerationCache.get(userId);
  if (!cached) return null;
  // Legacy shape (pre-TTL) — drop so the value can be refreshed
  if (cached && typeof cached === 'object' && 'hasLink' in cached) {
    bioModerationCache.delete(userId);
    return null;
  }
  const until = Number(cached?.until);
  if (!Number.isFinite(until) || until <= Date.now()) {
    bioModerationCache.delete(userId);
    return null;
  }
  return cached.data || null;
}

function writeBioCache(userId, data) {
  if (BIO_CACHE_TTL_MS === 0) {
    bioModerationCache.delete(userId);
    return data;
  }
  const until = Date.now() + BIO_CACHE_TTL_MS;
  bioModerationCache.set(userId, { until, data });
  return data;
}

async function checkUserBioStatus(ctx, userId) {
  const cached = readBioCache(userId);
  if (cached) return cached;
  try {
    const chat = await ctx.api.getChat(userId);
    const bio = chat?.bio || '';
    const hasLink = bio ? textHasLink(bio) : false;
    const hasExplicit = bio ? containsExplicit(bio) : false;
    const res = { hasLink, hasExplicit, bio };
    return writeBioCache(userId, res);
  } catch (_) {
    const res = { hasLink: false, hasExplicit: false, bio: '' };
    return writeBioCache(userId, res);
  }
}

export function securityMiddleware() {
  return async (ctx, next) => {
    if (!isGroupChat(ctx)) return next();

    if (await enforceGlobalBlacklist(ctx)) return;
    const rules = await getEffectiveRules(ctx.chat.id);

    // Exemption: group admins/owner and bot owner/admins.
    // Name/username checks should still run for exempt users on new messages.
    const exemptUser = await isExempt(ctx);

    // Rule 2: No edits — delete edited messages (if enabled)
    if (ctx.editedMessage) {
      if (exemptUser) return next();
      if (rules.no_edit) {
        if (await ensureBotCanDelete(ctx)) {
          try {
          await ctx.api.deleteMessage(ctx.chat.id, ctx.editedMessage.message_id);
          await notifyAndCleanup(
            ctx,
            `✏️ ${await mentionWithPrefix(ctx, ctx.from, 'no_edit')} <b>Editing is not allowed</b>. Your message was removed.`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_edit', user: ctx.from, chat: ctx.chat, content: ctx.editedMessage?.text || ctx.editedMessage?.caption || '' });
        } catch (_) {}
        }
      }
      return; // do not continue other middlewares for edited messages
    }

  // Handle new messages (text or captions)
  const msg = ctx.msg;
  if (!msg) return next();

  // Extract text/caption and entities
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  // Extract poll contents (question + options) for explicit checks
  let pollText = '';
  if (msg.poll) {
      try {
        const q = String(msg.poll.question || '');
        const opts = Array.isArray(msg.poll.options) ? msg.poll.options.map((o) => o?.text).filter(Boolean) : [];
        pollText = [q, ...opts].filter(Boolean).join(' \n ');
      } catch {}
    }

  const chatId = ctx.chat?.id;
  const senderId = ctx.from?.id;
  const now = Date.now();
  pruneSpamState(now);

  if (Number.isFinite(chatId) && Number.isFinite(senderId)) {
    if (rules.anti_flood && isFloodViolation(chatId, senderId, now)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(chatId, msg.message_id);
          let muted = false;
          if (FLOOD_MUTE_SECONDS > 0) {
            try {
              await ctx.api.restrictChatMember(chatId, senderId, {
                permissions: MUTE_PERMISSIONS,
                until_date: Math.floor(Date.now() / 1000) + FLOOD_MUTE_SECONDS,
              });
              muted = true;
            } catch {}
          }
          await notifyAndCleanup(
            ctx,
            `⏱️ ${await mentionWithPrefix(ctx, ctx.from, 'anti_flood')} <b>too many messages too quickly</b>. Please slow down.${muted ? ` Muted for ${FLOOD_MUTE_SECONDS}s.` : ''}`
          );
          await logAction(ctx, {
            action: muted ? 'restrict_member' : 'delete_message',
            action_type: 'moderation',
            violation: 'anti_flood',
            user: ctx.from,
            chat: ctx.chat,
            content: text || (pollText ? `[POLL] ${pollText}` : ''),
          });
        } catch (_) {}
      }
      return;
    }

    if (rules.anti_duplicate && isDuplicateViolation(chatId, senderId, text || pollText, now)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(chatId, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `🌀 ${await mentionWithPrefix(ctx, ctx.from, 'anti_duplicate')} <b>repeated messages are not allowed</b>.`
          );
          await logAction(ctx, {
            action: 'delete_message',
            action_type: 'moderation',
            violation: 'anti_duplicate',
            user: ctx.from,
            chat: ctx.chat,
            content: text || (pollText ? `[POLL] ${pollText}` : ''),
          });
        } catch (_) {}
      }
      return;
    }

    if (rules.new_member_probation && isUnderNewMemberProbation(chatId, senderId, now)) {
      const probationHasLink = entitiesContainLink(entities) || textHasLink(text) || (pollText ? textHasLink(pollText) : false);
      const probationHasMedia = messageHasMedia(msg);
      if (probationHasLink || probationHasMedia) {
        if (await ensureBotCanDelete(ctx)) {
          try {
            await ctx.api.deleteMessage(chatId, msg.message_id);
            const reason = probationHasLink && probationHasMedia
              ? 'links and media'
              : probationHasLink
                ? 'links'
                : 'media';
            await notifyAndCleanup(
              ctx,
              `🛡️ ${await mentionWithPrefix(ctx, ctx.from, 'new_member_probation')} <b>new-member probation is active</b>. ${escapeHtml(reason)} are temporarily restricted.`
            );
            await logAction(ctx, {
              action: 'delete_message',
              action_type: 'moderation',
              violation: 'new_member_probation',
              user: ctx.from,
              chat: ctx.chat,
              content: text || (pollText ? `[POLL] ${pollText}` : '[MEDIA]'),
            });
          } catch (_) {}
        }
        return;
      }
    }
  }

  // Display name checks (apply existing rules to member's name)
  // Build a display name string from first/last/username
  const senderDisplayName = displayName(ctx.from);
  if (senderDisplayName) {
    // Name: no links
    if (rules.no_links && textHasLink(senderDisplayName)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_links')} <b>Link in name is not allowed</b>. Please remove links from your display name to participate.`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_links', user: ctx.from, chat: ctx.chat, content: senderDisplayName });
        } catch (_) {}
      }
      return;
    }
    // Name: no explicit terms
    if (rules.no_explicit && containsExplicit(senderDisplayName)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_explicit')} <b>Explicit content in name</b>. Please change it to participate.`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_explicit', user: ctx.from, chat: ctx.chat, content: senderDisplayName });
        } catch (_) {}
      }
      return;
    }
  }

    // Exempt users are still checked for display-name policy above,
    // but skip all other message-content moderation rules.
    if (exemptUser) return next();

    // Rule 5 (extended): bio moderation (links or explicit content)
    const userId = ctx.from?.id;
    if (userId) {
      if (rules.bio_block) {
        const { hasLink: bioHasLink, hasExplicit: bioHasExplicit, bio: bioText } = await checkUserBioStatus(
          ctx,
          userId,
        );
        if (bioHasLink || bioHasExplicit) {
          if (await ensureBotCanDelete(ctx)) {
            try {
              await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
              const reason = bioHasLink && bioHasExplicit
                ? 'a link and explicit content'
                : bioHasLink
                ? 'a link'
                : 'explicit content';
              await notifyAndCleanup(ctx, `🧬 ${await mentionPlainWithPrefix(ctx, ctx.from, 'bio_block')} <b>cannot post</b> because your bio contains ${reason}. Please update your bio to participate.`);
              await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'bio_block', user: ctx.from, chat: ctx.chat, content: bioText ? `[BIO] ${bioText}` : '' });
            } catch (_) {}
          }
          return;
        }
      }
    }

    // Rule 1: Max length (default 300)
    if (rules.max_len) {
      const limit = await getEffectiveMaxLen(ctx.chat.id);
      if (overCharLimit(text, limit)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `📏 ${await mentionWithPrefix(ctx, ctx.from, 'max_len')} <b>messages longer than ${limit} characters</b> are not allowed.`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'max_len', user: ctx.from, chat: ctx.chat, content: text });
        } catch (_) {}
      }
      return;
      }
    }

    // Rule 4: No links (also scan poll question/options)
    const hasLink = entitiesContainLink(entities) || textHasLink(text) || (pollText ? textHasLink(pollText) : false);
    if (rules.no_links && hasLink) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(ctx, `🔗 ${await mentionWithPrefix(ctx, ctx.from, 'no_links')} <b>links are not allowed</b> in this group.`);
          const contentStr = text || (pollText ? `[POLL] ${pollText}` : '');
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_links', user: ctx.from, chat: ctx.chat, content: contentStr });
        } catch (_) {}
      }
      return;
    }

    // Rule 3: No explicit content
    if (rules.no_explicit && containsExplicit(text || pollText)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `🚫 ${await mentionWithPrefix(ctx, ctx.from, 'no_explicit')} <b>explicit or sexual content</b> is not allowed.`
          );
          const contentStr = text || (pollText ? `[POLL] ${pollText}` : '');
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_explicit', user: ctx.from, chat: ctx.chat, content: contentStr });
        } catch (_) {}
      }
      return;
    }

    // No violations; continue to next middleware/handlers
    return next();
  };
}
