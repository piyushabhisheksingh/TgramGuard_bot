import 'dotenv/config';
import { Bot, webhookCallback } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { autoRetry } from '@grammyjs/auto-retry';
import throttlerModule from '@grammyjs/transformer-throttler';
import http from 'node:http';
import { securityMiddleware, markNewMemberJoined } from './middleware/security.js';
import { settingsMiddleware } from './middleware/settings.js';
import { bootstrapAdminsFromEnv, areCommandsInitialized, markCommandsInitialized, getBlacklistEntry, getEffectiveRules } from './store/settings.js';
import { logActionPinned, logAction, recordUserPresence, removeChatPresenceUsers } from './logger.js';
import { defaultCommands, adminCommands, ownerPrivateCommands } from './commands/menu.js';
import { textHasLink, containsExplicit } from './filters.js';
import { BOT_ADMIN_IDS, BOT_OWNER_ID, MUTE_PERMISSIONS, numberEnv } from './config.js';
import { displayName, escapeHtml, isGroupChat, linkMention, sendHtml } from './services/telegram.js';

const { apiThrottler } = throttlerModule;
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is not set. Put it in .env');
  process.exit(1);
}

const bot = new Bot(token);

// Reliability: auto-retry transient network errors and 429s with backoff
bot.api.config.use(autoRetry());

// Flood limits: queue API calls to respect Telegram rate limits
bot.api.config.use(apiThrottler());

// Concurrency safety: ensure per-chat (or user) sequential processing
bot.use(
  sequentialize((ctx) => {
    // Group by chat; fall back to user for non-chat updates
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    return String(chatId ?? userId ?? 'global');
  })
);

// Security middleware with all group rules
bot.use(securityMiddleware());

// Settings middleware and commands
bot.use(settingsMiddleware());

// (message and edited_message handling moved into security middleware)

// Presence tracking: record user→chat presence on messages
bot.on('message', recordUserPresence);
bot.on('edited_message', recordUserPresence);

// Welcome new members with a short intro and rules
bot.on('message:new_chat_members', async (ctx) => {
  try {
    if (!isGroupChat(ctx)) return;
    const meId = ctx.me?.id;
    const members = ctx.msg?.new_chat_members || [];
    // Filter out bots and the bot itself
    const candidates = members.filter((m) => !m.is_bot && (!meId || m.id !== meId));
    if (!candidates.length) return;

    const rules = await getEffectiveRules(ctx.chat.id);
    const checkNameLinks = rules.no_links;
    const checkNameExplicit = rules.no_explicit;
    const allowed = [];
    const blockedNotices = [];
    const flaggedNameNotices = [];
    for (const member of candidates) {
      markNewMemberJoined(ctx.chat.id, member.id);
      const entry = await getBlacklistEntry(member.id);
      if (!entry) {
        const dn = displayName(member);
        const hasNameLink = checkNameLinks && dn ? textHasLink(dn) : false;
        const hasNameExplicit = checkNameExplicit && dn ? containsExplicit(dn) : false;
        if (hasNameLink || hasNameExplicit) {
          const reasons = [];
          if (hasNameLink) reasons.push('link in name/username');
          if (hasNameExplicit) reasons.push('explicit content in name/username');
          flaggedNameNotices.push(`• ${linkMention(member)} flagged: <b>${escapeHtml(reasons.join(' and '))}</b>.`);
          await logAction(ctx, {
            action: 'name_check_flagged_on_join',
            action_type: 'security',
            violation: hasNameLink ? 'name_no_links' : 'name_no_explicit',
            user: member,
            chat: ctx.chat,
            content: dn,
          });
        }
        allowed.push(member);
        continue;
      }
      const action = entry.action === 'mute' ? 'mute' : 'kick';
      const reason = entry.reason ? entry.reason.slice(0, 180) : '';
      const reasonHtml = reason ? ` Reason: <i>${escapeHtml(reason)}</i>` : '';
      try {
        if (action === 'mute') {
          await ctx.api.restrictChatMember(ctx.chat.id, member.id, { permissions: MUTE_PERMISSIONS });
        } else {
          await ctx.api.banChatMember(ctx.chat.id, member.id, { until_date: Math.floor(Date.now() / 1000) + 60 });
          try { await ctx.api.unbanChatMember(ctx.chat.id, member.id); } catch {}
          try { await removeChatPresenceUsers(ctx.chat.id, [member.id]); } catch {}
        }
        blockedNotices.push(`• ${linkMention(member)} ${action === 'mute' ? 'muted' : 'removed'} by global blacklist.${reasonHtml}`);
        await logAction(ctx, {
          action: action === 'mute' ? 'global_blacklist_mute' : 'global_blacklist_kick',
          action_type: 'security',
          violation: 'blacklist',
          user: member,
          chat: ctx.chat,
          content: `action=${action}; origin=join; reason=${reason || '-'}`,
        });
      } catch (err) {
        const errMsg = String(err?.description || err?.message || err || '').slice(0, 160);
        await logAction(ctx, {
          action: 'global_blacklist_failed',
          action_type: 'security',
          violation: 'blacklist',
          user: member,
          chat: ctx.chat,
          content: `action=${action}; origin=join; error=${errMsg}`,
        });
        allowed.push(member);
      }
    }

    if (blockedNotices.length) {
      const notice = ['🚫 <b>Global blacklist enforcement</b>', ...blockedNotices].join('\n');
      try {
        await sendHtml(ctx, ctx.chat.id, notice);
      } catch {}
    }
    if (flaggedNameNotices.length) {
      const notice = [
        '⚠️ <b>Name/username policy warning</b>',
        ...flaggedNameNotices,
        '',
        'Update your display name/username to avoid moderation actions.',
      ].join('\n');
      try {
        await sendHtml(ctx, ctx.chat.id, notice);
      } catch {}
    }

    if (!allowed.length) return;

    const names = allowed.map(linkMention).join(', ');
    const title = escapeHtml(ctx.chat?.title || 'this group');
    const welcomeRules = [
      '• No links',
      '• No explicit content',
      '• Keep it concise, be respectful',
      '• No edits to messages',
    ].join('\n');

    const msg = `👋 Welcome ${names} to <b>${title}</b>!\n\nPlease follow the rules:\n${welcomeRules}\n\nUse /settings for options.`;
    await sendHtml(ctx, ctx.chat.id, msg);
  } catch (_) {}
});

// Optional: simple liveness command
bot.command('ping', (ctx) => ctx.reply('pong'));

// DM onboarding: /start shows add-to-group link and basics
bot.command('start', async (ctx) => {
  const chatType = ctx.chat?.type;
  const username = ctx.me?.username;
  const addUrl = username ? `https://t.me/${username}?startgroup=true` : undefined;
  if (chatType === 'private') {
    const lines = [
      'Namaste! I can help secure your groups:',
      '- Block links and explicit content',
      '- Enforce no-edits and max message length',
      '- Bio/content checks + whitelist',
      '',
      'Add me to a group and make me admin (Delete messages; optionally Ban users).',
    ];
    return ctx.reply(lines.join('\n'), {
      reply_markup: addUrl
        ? {
            inline_keyboard: [[{ text: '➕ Add me to your group', url: addUrl }], [{ text: 'ℹ️ Help / Settings', callback_data: 'noop' }]],
          }
        : undefined,
      disable_web_page_preview: true,
    });
  }
  // In groups: short intro
  return ctx.reply('Hello! I am active here. Use /settings for commands.');
});

// Log when bot is added to a new group and pin the log message
bot.on('my_chat_member', async (ctx) => {
  try {
    const oldStatus = ctx.myChatMember?.old_chat_member?.status;
    const newStatus = ctx.myChatMember?.new_chat_member?.status;
    const joined = (oldStatus === 'left' || oldStatus === 'kicked') && (newStatus === 'member' || newStatus === 'administrator');
    if (!joined) return;
    const chat = ctx.chat ?? ctx.myChatMember?.chat;
    let groupLink;
    try {
      if (chat?.username) {
        groupLink = `https://t.me/${chat.username}`;
      } else if (chat?.id) {
        // Requires admin right; may fail for non-admin joins
        groupLink = await bot.api.exportChatInviteLink(chat.id);
      }
    } catch (_) {}
    await logActionPinned(bot, {
      action: 'bot_joined_group',
      action_type: 'lifecycle',
      chat,
      violation: '-',
      content: `Joined group: ${chat?.title || chat?.id}`,
      group_link: groupLink,
    });
  } catch (_) {}
});

// Bootstrap admins from env
await bootstrapAdminsFromEnv(BOT_OWNER_ID, BOT_ADMIN_IDS);

// Global error handler
bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;
  const meta = {
    updateId: ctx?.update?.update_id,
    chatId: ctx?.chat?.id,
    userId: ctx?.from?.id,
  };
  console.error('Unhandled bot error', meta, e?.description || e?.message || e);
});

// On first run, set bot commands automatically
async function ensureBotCommands() {
  try {
    const already = await areCommandsInitialized();
    const forceFlag = String(process.env.FORCE_SET_COMMANDS || '').toLowerCase();
    const force = forceFlag === '1' || forceFlag === 'true' || forceFlag === 'yes' || forceFlag === 'on';
    if (already && !force) return;
    // Clear any previously published commands so only the current set remains active
    await bot.api.deleteMyCommands({ scope: { type: 'default' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });
    await bot.api.deleteMyCommands({ scope: { type: 'all_private_chats' } });
    // Default (all users) concise commands
    await bot.api.setMyCommands(defaultCommands, { scope: { type: 'default' } });
    // Admin commands menu for all chat administrators
    await bot.api.setMyCommands(adminCommands, { scope: { type: 'all_chat_administrators' } });
    // Owner-level commands for private chats
    await bot.api.setMyCommands(ownerPrivateCommands, { scope: { type: 'all_private_chats' } });
    await markCommandsInitialized();
    console.log('Bot commands initialized.');
  } catch (e) {
    console.warn('Failed to initialize bot commands:', e?.message || e);
  }
}

// Startup: webhook (worker/server) or high-load runner
const allowedUpdates = ['message', 'edited_message', 'my_chat_member', 'callback_query', 'poll', 'poll_answer'];

const USE_WEBHOOK = Boolean(process.env.WEBHOOK_URL);
// Kick off first-run command setup (best-effort)
ensureBotCommands();
if (USE_WEBHOOK) {
  const PORT = numberEnv('PORT', 3000, { min: 1, integer: true });
  const SECRET = process.env.WEBHOOK_SECRET;
  const url = process.env.WEBHOOK_URL;
  // Set webhook and start minimal HTTP server
  try {
    await bot.api.setWebhook(url, {
      allowed_updates: allowedUpdates,
      secret_token: SECRET,
    });
    const server = http.createServer(webhookCallback(bot, 'http'));
    server.listen(PORT, () => {
      console.log(`Webhook server listening on :${PORT}`);
    });
    // Graceful shutdown
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (e) {
    console.error('Failed to set webhook, falling back to runner.', e);
    const concurrency = numberEnv('RUNNER_CONCURRENCY', 100, { min: 1, integer: true });
    const runner = run(bot, { fetch: { allowed_updates: allowedUpdates }, runner: { concurrency } });
    console.log('Runner started (fallback).');
    process.once('SIGINT', () => { runner.stop(); });
    process.once('SIGTERM', () => { runner.stop(); });
  }
} else {
  // High-load long polling with concurrency
  const concurrency = numberEnv('RUNNER_CONCURRENCY', 100, { min: 1, integer: true });
  const runner = run(bot, { fetch: { allowed_updates: allowedUpdates }, runner: { concurrency } });
  console.log('Runner started. Listening for updates...');
  // Graceful shutdown
  process.once('SIGINT', () => { runner.stop(); });
  process.once('SIGTERM', () => { runner.stop(); });
}
