import {
  textHasLink,
  entitiesContainLink,
  containsExplicit,
  overCharLimit,
} from '../filters.js';
import { isRuleEnabled, getSettings, getEffectiveMaxLen, isUserWhitelisted } from '../store/settings.js';
import { logAction, getUserRiskSummary, buildFunnyPrefix } from '../logger.js';

// Cache for user bio moderation status to reduce API calls
// Map<userId, { hasLink: boolean, hasExplicit: boolean }>
const bioModerationCache = new Map();

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
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'user';
  return `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>`;
}

// Light-hearted Hinglish suffixes per violation type
const FUNNY_SUFFIX = {
  no_links: [
    'Link mat chipkao, bhai! 😅',
    'Yahan links allowed nahi, samjhe? 🙅‍♂️',
    'Link ka mann hai? DM karo. 😉',
    'Hyperlink ka scene nahi yahan. 🚫🔗',
    'Link ki ladai ghar pe, yahan nahi. 😤',
    'Link daalne ka fine: 100 push-ups. 💪',
  ],
  no_explicit: [
    'Thoda sanskaari bano, yaar. 🙏',
    'Gandi baatein ghar pe, please. 😜',
    'PG-13 rakho, bro. 🎬',
    'Family-friendly vibes only. 🧸',
    'Itna tharki mat bano, champ. 😌',
    'Internet ka chacha nahi banna. 🤓',
  ],
  bio_block: [
    'Pehle bio sudharo, phir aao. 😌',
    'Bio saaf rakho, dil saaf rakho. ✨',
    'Bio mein sabak likho, link nahi. 📚',
    'Bio ko detox do, zindagi ko relax. 🧘',
  ],
  max_len: [
    'Short & sweet rakho. 😎',
    'TL;DR mat bano, dost. 📏',
    'Novel baad mein likhna, yahan nahi. 📖',
    'Ek line ka pyaar bhi hota hai. 💬',
  ],
  no_edit: [
    'Edit mat khelo, sahi bhejo. ✍️',
    'Ek baar mein pyaar. 💌',
    'Palti maarna band karo, hero. 🔄',
    'Ctrl+Z ka nasha chhodo. 🧪',
  ],
  name_no_links: [
    'Naam se link hatao, hero! 🏷️',
    'Naam simple rakho, champ. 🫶',
    'Username ko gym bhejo, link nahi. 🏋️‍♂️',
    'Naam cool, link null. 😎',
  ],
  name_no_explicit: [
    'Naam thoda seedha rakho. 🙂',
    'Decent naam, decent fame. 🌟',
    'Naam sanskaari = respect zyada. 🪷',
    'Naam pe control, fame automatic. 🚀',
  ],
  default: [
    'Shant raho, mast raho. 😌',
    'Rules ka dhyaan rakho, yaaro. 📜',
    'Mod ke saath pyaar se raho. 💙',
    'Yeh group, tumhara ghar nahi. 🏠',
  ],
};

function funnySuffix(violation = 'default') {
  const list = FUNNY_SUFFIX[violation] || FUNNY_SUFFIX.default;
  return ' ' + list[Math.floor(Math.random() * list.length)];
}

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
      'I need admin permission "Delete messages" to enforce group rules. Please promote the bot and enable this permission.',
      15
    );
  }
  return false;
}

async function checkUserBioStatus(ctx, userId) {
  if (bioModerationCache.has(userId)) return bioModerationCache.get(userId);
  try {
    const chat = await ctx.api.getChat(userId);
    const bio = chat?.bio || '';
    const hasLink = bio ? textHasLink(bio) : false;
    const hasExplicit = bio ? containsExplicit(bio) : false;
    const res = { hasLink, hasExplicit, bio };
    bioModerationCache.set(userId, res);
    return res;
  } catch (_) {
    const res = { hasLink: false, hasExplicit: false, bio: '' };
    bioModerationCache.set(userId, res);
    return res;
  }
}

export function securityMiddleware() {
  return async (ctx, next) => {
    const type = ctx.chat?.type;
    if (!(type === 'group' || type === 'supergroup')) return next();

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
            `${await mentionWithPrefix(ctx, ctx.from, 'no_edit')} editing messages is not allowed. Your message was removed.${funnySuffix('no_edit')}`
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
        if (await ensureBotCanDelete(ctx)) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
            await notifyAndCleanup(
              ctx,
              `${await mentionWithPrefix(ctx, ctx.from, 'name_no_links')} your display name contains a link. Please remove links from your name to participate.${funnySuffix('name_no_links')}`
            );
            await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_links', user: ctx.from, chat: ctx.chat, content: displayName });
          } catch (_) {}
        }
        return;
      }
      // Name: no explicit terms
      if ((await isRuleEnabled('no_explicit', ctx.chat.id)) && containsExplicit(displayName)) {
        if (await ensureBotCanDelete(ctx)) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
            await notifyAndCleanup(
              ctx,
              `${await mentionWithPrefix(ctx, ctx.from, 'name_no_explicit')} your display name contains explicit content. Please change it to participate.${funnySuffix('name_no_explicit')}`
            );
            await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'name_no_explicit', user: ctx.from, chat: ctx.chat, content: displayName });
          } catch (_) {}
        }
        return;
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
        if (await ensureBotCanDelete(ctx)) {
          try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          const reason = bioHasLink && bioHasExplicit
            ? 'a link and explicit content'
            : bioHasLink
            ? 'a link'
            : 'explicit content';
          await notifyAndCleanup(ctx, `${await mentionWithPrefix(ctx, ctx.from, 'bio_block')} cannot post because your bio contains ${reason}. Please update your bio to participate.${funnySuffix('bio_block')}`);
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'bio_block', user: ctx.from, chat: ctx.chat, content: bioText ? `[BIO] ${bioText}` : '' });
        } catch (_) {}
        }
        return;
        }
      }
    }

    // Rule 1: Max length 200
    if (await isRuleEnabled('max_len', ctx.chat.id)) {
      const limit = await getEffectiveMaxLen(ctx.chat.id);
      if (overCharLimit(text, limit)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `${await mentionWithPrefix(ctx, ctx.from, 'max_len')} messages longer than ${limit} characters are not allowed.${funnySuffix('max_len')}`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'max_len', user: ctx.from, chat: ctx.chat, content: text });
        } catch (_) {}
      }
      return;
      }
    }

    // Rule 4: No links
    const hasLink = entitiesContainLink(entities) || textHasLink(text);
    if ((await isRuleEnabled('no_links', ctx.chat.id)) && hasLink) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(ctx, `${await mentionWithPrefix(ctx, ctx.from, 'no_links')} links are not allowed in this group.${funnySuffix('no_links')}`);
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_links', user: ctx.from, chat: ctx.chat, content: text });
        } catch (_) {}
      }
      return;
    }

    // Rule 3: No explicit content
    if ((await isRuleEnabled('no_explicit', ctx.chat.id)) && containsExplicit(text)) {
      if (await ensureBotCanDelete(ctx)) {
        try {
          await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
          await notifyAndCleanup(
            ctx,
            `${await mentionWithPrefix(ctx, ctx.from, 'no_explicit')} explicit or sexual content is not allowed.${funnySuffix('no_explicit')}`
          );
          await logAction(ctx, { action: 'delete_message', action_type: 'moderation', violation: 'no_explicit', user: ctx.from, chat: ctx.chat, content: text });
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
