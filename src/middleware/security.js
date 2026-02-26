import {
  textHasLink,
  entitiesContainLink,
  containsExplicit,
  overCharLimit,
} from '../filters.js';
import { isRuleEnabled, getSettings, getEffectiveMaxLen, isUserWhitelisted, getBlacklistEntry } from '../store/settings.js';
import { logAction, getUserRiskSummary, buildFunnyPrefix, removeChatPresenceUsers } from '../logger.js';
import { classifyText as aiClassifyText, classifyLinks as aiClassifyLinks } from '../ai/provider_openai.js';
import { addSafeTerms } from '../filters/customTerms.js';

// Cache for user bio moderation status to reduce API calls.
// Entries expire automatically so users are re-checked after updating their bio.
// Map<userId, { until: number, data: { hasLink: boolean, hasExplicit: boolean, bio: string } }>
const bioModerationCache = new Map();
const BIO_CACHE_TTL_MS_RAW = Number(process.env.BIO_CACHE_TTL_MS);
const BIO_CACHE_TTL_MS = Number.isFinite(BIO_CACHE_TTL_MS_RAW)
  ? Math.max(0, BIO_CACHE_TTL_MS_RAW)
  : 5 * 60 * 1000; // default 5 minutes

// Cache for chat admin status lookups with TTL
// Map<`${chatId}:${userId}`, { isAdmin: boolean, until: number }>
const adminStatusCache = new Map();

// Cache the bot's own permissions per chat to reduce API calls
// Map<chatId, { until: number, isAdmin: boolean, canDelete: boolean }>
const botPermsCache = new Map();

// Bot-level privileged users (owner + admins) via env
const BOT_OWNER_ID = Number(process.env.BOT_OWNER_ID || NaN);
const BOT_ADMIN_IDS = new Set(
  (process.env.BOT_ADMIN_IDS || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
);

function escapeHtml(s = '') {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function mentionHTML(user) {
  const id = user?.id ?? '?';
  return `<a href="tg://user?id=${id}">${escapeHtml(String(id))}</a>`;
}

const BLACKLIST_MUTE_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
};

// Cache funny prefixes per (chat,user) for 10 minutes to avoid constant DB hits
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
    funnyPrefixCache.set(key, { until: now + 10 * 60 * 1000, prefix });
    return prefix;
  } catch {
    return '';
  }
}

async function mentionWithPrefix(ctx, user, currentViolation) {
  const pref = await userPrefix(ctx, user, currentViolation);
  return `${pref}${mentionHTML(user)}`;
}

async function mentionPlainWithPrefix(ctx, user, currentViolation) {
  const pref = await userPrefix(ctx, user, currentViolation);
  const id = user?.id ?? '?';
  return `${pref}<code>${escapeHtml(String(id))}</code>`;
}

// Conditional funny suffix based on settings: can be toggled globally or per chat
async function maybeSuffix(ctx, violation = 'default') {
  return '';
}

async function notifyAndCleanup(ctx, text, seconds = 8) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const replyTo = ctx.msg?.message_id;
  const boolFromEnv = (v) => {
    if (v == null) return false;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  };
  const doCleanup = boolFromEnv(process.env.NOTIFY_CLEANUP);
  const cleanupSeconds = Number(process.env.NOTIFY_CLEANUP_SECONDS || seconds);
  const delayMs = Number.isFinite(cleanupSeconds) ? Math.max(1, cleanupSeconds) * 1000 : seconds * 1000;
  try {
    const sent = await ctx.api.sendMessage(chatId, text, {
      reply_to_message_id: replyTo,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (doCleanup) {
      setTimeout(() => {
        ctx.api.deleteMessage(chatId, sent.message_id).catch(() => {});
      }, delayMs);
    }
  } catch (_) {
    try {
      const sent = await ctx.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      if (doCleanup) {
        setTimeout(() => {
          ctx.api.deleteMessage(chatId, sent.message_id).catch(() => {});
        }, delayMs);
      }
    } catch (_) {}
  }
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
      await ctx.api.restrictChatMember(chatId, userId, { permissions: BLACKLIST_MUTE_PERMISSIONS });
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

async function getBotPermissions(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return { isAdmin: false, canDelete: false };
  const now = Date.now();
  const cached = botPermsCache.get(chatId);
  if (cached && cached.until > now) return { isAdmin: cached.isAdmin, canDelete: cached.canDelete };
  try {
    const meId = ctx.me?.id;
    const member = meId ? await ctx.api.getChatMember(chatId, meId) : null;
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    const canDelete = Boolean(member?.can_delete_messages || member?.status === 'creator');
    botPermsCache.set(chatId, { until: now + 60 * 1000, isAdmin, canDelete });
    return { isAdmin, canDelete };
  } catch (_) {
    botPermsCache.set(chatId, { until: now + 30 * 1000, isAdmin: false, canDelete: false });
    return { isAdmin: false, canDelete: false };
  }
}

const lastPermWarn = new Map(); // Map<chatId, number>
async function ensureBotCanDelete(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const { canDelete } = await getBotPermissions(ctx);
  if (canDelete) return true;
  const now = Date.now();
  const last = lastPermWarn.get(chatId) || 0;
  if (now - last > 10 * 60 * 1000) {
    lastPermWarn.set(chatId, now);
    await notifyAndCleanup(
      ctx,
      '⚠️ <b>Missing permission:</b> I need admin permission <b>Delete messages</b> to enforce group rules. Please promote the bot and enable this permission.',
      15
    );
  }
  return false;
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
    const type = ctx.chat?.type;
    if (!(type === 'group' || type === 'supergroup')) return next();

    if (await enforceGlobalBlacklist(ctx)) return;

    // Exemption: group admins/owner and bot owner/admins
    if (await isExempt(ctx)) return next();

    // Rule 2: No edits — delete edited messages (if enabled)
    if (ctx.editedMessage) {
      if (await isRuleEnabled('no_edit', ctx.chat.id)) {
        if (await ensureBotCanDelete(ctx)) {
          try {
          await ctx.api.deleteMessage(ctx.chat.id, ctx.editedMessage.message_id);
          await notifyAndCleanup(
            ctx,
            `✏️ ${await mentionWithPrefix(ctx, ctx.from, 'no_edit')} <b>Editing is not allowed</b>. Your message was removed.${await maybeSuffix(ctx, 'no_edit')}`
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

  // AI cross-check helpers
  const aiEnabled = (() => {
    const v = String(process.env.AI_ENABLE || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  })();
  const thresholds = { sexual: Number(process.env.AI_THRESH_SEXUAL || 0.7) };
  function tokenizePlain(s = '') {
    try { return (String(s).match(/[\p{L}\p{N}@#._-]+/gu) || []).filter((t) => t.length >= 3 && t.length <= 64); } catch { return (String(s).toLowerCase().split(/[^a-z0-9@#._-]+/) || []).filter((t) => t.length >= 3 && t.length <= 64); }
  }
  function extractRiskyTokensFrom(s = '') {
    const tokens = tokenizePlain(s);
    const out = [];
    for (const t of tokens) { if (containsExplicit(t)) out.push(t.toLowerCase()); if (out.length >= 200) break; }
    return out;
  }

  // Display name checks (apply existing rules to member's name)
  // Build a display name string from first/last/username
  const displayName = [
    ctx.from?.first_name,
    ctx.from?.last_name,
    ctx.from?.username ? `@${ctx.from.username}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (displayName) {
    // Name: no links
    if ((await isRuleEnabled('no_links', ctx.chat.id)) && textHasLink(displayName)) {
      // AI cross-check for links in names
      if (aiEnabled) {
        try {
          const r = await aiClassifyLinks(displayName);
          if (r && r.has_link === false) {
            // allow; continue
          } else {
            if (await ensureBotCanDelete(ctx)) {
              try {
                await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
                await notifyAndCleanup(
                  ctx,
                  `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_links')} <b>Link in name is not allowed</b>. Please remove links from your display name to participate.${await maybeSuffix(ctx, 'name_no_links')}`
                );
                await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_links', user: ctx.from, chat: ctx.chat, content: displayName });
              } catch (_) {}
            }
            return;
          }
        } catch {}
      } else {
        if (await ensureBotCanDelete(ctx)) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
            await notifyAndCleanup(
              ctx,
              `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_links')} <b>Link in name is not allowed</b>. Please remove links from your display name to participate.${await maybeSuffix(ctx, 'name_no_links')}`
            );
            await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_links', user: ctx.from, chat: ctx.chat, content: displayName });
          } catch (_) {}
        }
        return;
      }
    }
    // Name: no explicit terms
    if ((await isRuleEnabled('no_explicit', ctx.chat.id)) && containsExplicit(displayName)) {
      // AI cross-check sexual; train safelist for false positives
      if (aiEnabled) {
        try {
          const r = await aiClassifyText(displayName);
          if (r) {
            const s = r.scores || {};
            const isSexual = (s['sexual'] || 0) >= thresholds.sexual || Boolean(r.categories?.sexual);
            if (!isSexual && !r.flagged) {
              try { const toks = extractRiskyTokensFrom(displayName); if (toks.length) await addSafeTerms(toks); } catch {}
              // allow; continue other rules
            } else {
              if (await ensureBotCanDelete(ctx)) {
                try {
                  await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
                  await notifyAndCleanup(
                    ctx,
                    `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_explicit')} <b>Explicit content in name</b>. Please change it to participate.${await maybeSuffix(ctx, 'name_no_explicit')}`
                  );
                  await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_explicit', user: ctx.from, chat: ctx.chat, content: displayName });
                } catch (_) {}
              }
              return;
            }
          }
        } catch {}
      } else {
        if (await ensureBotCanDelete(ctx)) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
            await notifyAndCleanup(
              ctx,
              `🏷️ ${await mentionWithPrefix(ctx, ctx.from, 'name_no_explicit')} <b>Explicit content in name</b>. Please change it to participate.${await maybeSuffix(ctx, 'name_no_explicit')}`
            );
            await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_explicit', user: ctx.from, chat: ctx.chat, content: displayName });
          } catch (_) {}
        }
        return;
      }
    }
  }

    // Rule 5 (extended): bio moderation (links or explicit content)
    const userId = ctx.from?.id;
    if (userId) {
      if (await isRuleEnabled('bio_block', ctx.chat.id)) {
        const { hasLink: bioHasLink, hasExplicit: bioHasExplicit, bio: bioText } = await checkUserBioStatus(
          ctx,
          userId,
        );
        if (bioHasLink || bioHasExplicit) {
          let shouldDelete = true;
          if (aiEnabled) {
            try {
              if (bioHasExplicit && bioText) {
                const r = await aiClassifyText(bioText);
                if (r) {
                  const s = r.scores || {};
                  const ok = (s['sexual'] || 0) < thresholds.sexual && !r.flagged && !r.categories?.sexual;
                  if (ok) shouldDelete = false;
                }
              }
              if (shouldDelete && bioHasLink && bioText) {
                const r2 = await aiClassifyLinks(bioText);
                if (r2 && r2.has_link === false) shouldDelete = false;
              }
            } catch {}
          }
          if (!shouldDelete) {
            if (bioHasExplicit && bioText) {
              try { const toks = extractRiskyTokensFrom(bioText); if (toks.length) await addSafeTerms(toks); } catch {}
            }
            return next();
          }
          if (await ensureBotCanDelete(ctx)) {
            try {
              await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
              const reason = bioHasLink && bioHasExplicit
                ? 'a link and explicit content'
                : bioHasLink
                ? 'a link'
                : 'explicit content';
              await notifyAndCleanup(ctx, `🧬 ${await mentionPlainWithPrefix(ctx, ctx.from, 'bio_block')} <b>cannot post</b> because your bio contains ${reason}. Please update your bio to participate.${await maybeSuffix(ctx, 'bio_block')}`);
              await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'bio_block', user: ctx.from, chat: ctx.chat, content: bioText ? `[BIO] ${bioText}` : '' });
            } catch (_) {}
          }
          return;
        }
      }
    }

    // Rule 1: Max length (default 300)
    if (await isRuleEnabled('max_len', ctx.chat.id)) {
      const limit = await getEffectiveMaxLen(ctx.chat.id);
      if (overCharLimit(text, limit)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `📏 ${await mentionWithPrefix(ctx, ctx.from, 'max_len')} <b>messages longer than ${limit} characters</b> are not allowed.${await maybeSuffix(ctx, 'max_len')}`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'max_len', user: ctx.from, chat: ctx.chat, content: text });
        } catch (_) {}
      }
      return;
      }
    }

    // Rule 4: No links (also scan poll question/options)
    const hasLink = entitiesContainLink(entities) || textHasLink(text) || (pollText ? textHasLink(pollText) : false);
    if ((await isRuleEnabled('no_links', ctx.chat.id)) && hasLink) {
      // AI cross-check to avoid false positives (e.g., obfuscated non-links)
      if (aiEnabled) {
        try {
          const contentStr = text || (pollText ? `[POLL] ${pollText}` : '');
          const r = await aiClassifyLinks(contentStr);
          if (r && r.has_link === false) return next();
        } catch {}
      }
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(ctx, `🔗 ${await mentionWithPrefix(ctx, ctx.from, 'no_links')} <b>links are not allowed</b> in this group.${await maybeSuffix(ctx, 'no_links')}`);
          const contentStr = text || (pollText ? `[POLL] ${pollText}` : '');
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_links', user: ctx.from, chat: ctx.chat, content: contentStr });
        } catch (_) {}
      }
      return;
    }

    // Rule 3: No explicit content
    if ((await isRuleEnabled('no_explicit', ctx.chat.id)) && containsExplicit(text || pollText)) {
      // AI cross-check: if AI does not consider sexual, treat as false positive and learn tokens
      if (aiEnabled) {
        try {
          const contentStr = text || (pollText ? `[POLL] ${pollText}` : '');
          const r = await aiClassifyText(contentStr);
          if (r) {
            const s = r.scores || {};
            const isSexual = (s['sexual'] || 0) >= thresholds.sexual || Boolean(r.categories?.sexual);
            if (!isSexual && !r.flagged) {
              try { const toks = extractRiskyTokensFrom(contentStr); if (toks.length) await addSafeTerms(toks); } catch {}
              return next();
            }
          }
        } catch {}
      }
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `🚫 ${await mentionWithPrefix(ctx, ctx.from, 'no_explicit')} <b>explicit or sexual content</b> is not allowed.${await maybeSuffix(ctx, 'no_explicit')}`
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

async function isBotPrivileged(userId) {
  if (!Number.isFinite(userId)) return false;
  if (Number.isFinite(BOT_OWNER_ID) && userId === BOT_OWNER_ID) return true;
  if (BOT_ADMIN_IDS.has(userId)) return true;
  try {
    const s = await getSettings();
    if (s.bot_admin_ids.includes(userId)) return true;
  } catch {}
  return false;
}

async function isChatAdminOrOwner(ctx, userId) {
  const chatId = ctx.chat?.id;
  if (!chatId || !userId) return false;
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const cached = adminStatusCache.get(key);
  if (cached && cached.until > now) return cached.isAdmin;
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    adminStatusCache.set(key, { isAdmin, until: now + 5 * 60 * 1000 }); // 5 min TTL
    return isAdmin;
  } catch (_) {
    adminStatusCache.set(key, { isAdmin: false, until: now + 60 * 1000 }); // short TTL on error
    return false;
  }
}

async function isExempt(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (await isBotPrivileged(userId)) return true;
  if (await isChatAdminOrOwner(ctx, userId)) return true;
  const chatId = ctx.chat?.id;
  if (chatId && (await isUserWhitelisted(chatId, userId))) return true;
  return false;
}
