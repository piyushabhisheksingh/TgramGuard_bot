import 'dotenv/config';
import { Bot, webhookCallback } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { autoRetry } from '@grammyjs/auto-retry';
import throttlerModule from '@grammyjs/transformer-throttler';
import http from 'node:http';
import { securityMiddleware } from './middleware/security.js';
import { settingsMiddleware } from './middleware/settings.js';
import { bootstrapAdminsFromEnv, areCommandsInitialized, markCommandsInitialized } from './store/settings.js';
import { logActionPinned } from './logger.js';

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
const ENV_BOT_OWNER_ID = Number(process.env.BOT_OWNER_ID || NaN);
const ENV_BOT_ADMIN_IDS = new Set(
  (process.env.BOT_ADMIN_IDS || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
);
await bootstrapAdminsFromEnv(ENV_BOT_OWNER_ID, ENV_BOT_ADMIN_IDS);

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
    if (already) return;
    // Default (all users) concise commands
    await bot.api.setMyCommands(
      [
        { command: 'start', description: 'Add bot to a group' },
        { command: 'help', description: 'Show help and commands' },
        { command: 'ping', description: 'Check bot availability' },
        { command: 'settings', description: 'Show settings help' },
        { command: 'rules_status', description: 'Show rules status' },
        { command: 'group_stats', description: 'Show this chat\'s stats' },
        { command: 'user_stats', description: 'Show your stats (or reply/id)' },
        { command: 'user_stats_global', description: 'Show your global stats' },
        { command: 'top_violators', description: 'List top violators' },
      ],
      { scope: { type: 'default' } }
    );
    // Admin commands menu for all chat administrators
    await bot.api.setMyCommands(
      [
        { command: 'rules_status', description: 'Show rules status' },
        { command: 'group_stats', description: 'Show this chat\'s stats' },
        { command: 'user_stats', description: 'Show user stats (reply/id)' },
        { command: 'user_stats_global', description: 'Show global user stats' },
        { command: 'rule_chat_enable', description: 'Enable a rule in this chat' },
        { command: 'rule_chat_disable', description: 'Disable a rule in this chat' },
        { command: 'maxlen_chat_set', description: 'Set max message length for chat' },
        { command: 'whitelist_add', description: 'Whitelist a user ID in this chat' },
        { command: 'whitelist_remove', description: 'Remove a whitelisted user ID' },
        { command: 'whitelist_list', description: 'List chat whitelist' },
        { command: 'top_violators', description: 'List top violators' },
      ],
      { scope: { type: 'all_chat_administrators' } }
    );
    // Owner-level commands for private chats
    await bot.api.setMyCommands(
      [
        { command: 'bot_stats', description: 'Show bot-wide stats' },
        { command: 'botadmin_add', description: 'Add a bot admin (owner only)' },
        { command: 'botadmin_remove', description: 'Remove a bot admin' },
        { command: 'rule_global_enable', description: 'Enable a rule globally' },
        { command: 'rule_global_disable', description: 'Disable a rule globally' },
        { command: 'maxlen_global_set', description: 'Set global max length' },
        { command: 'user_stats', description: 'Show user stats (reply/id)' },
        { command: 'user_stats_global', description: 'Show global user stats' },
        { command: 'user_groups', description: 'Show user group presence' },
        { command: 'set_mycommands', description: 'Publish command menus' },
        { command: 'remove_mycommands', description: 'Clear command menus' },
      ],
      { scope: { type: 'all_private_chats' } }
    );
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
  const PORT = Number(process.env.PORT || 3000);
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
    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (e) {
    console.error('Failed to set webhook, falling back to runner.', e);
    const concurrency = Number(process.env.RUNNER_CONCURRENCY || 100);
    const runner = run(bot, { fetch: { allowed_updates: allowedUpdates }, runner: { concurrency } });
    console.log('Runner started (fallback).');
    process.once('SIGINT', () => runner.stop());
    process.once('SIGTERM', () => runner.stop());
  }
} else {
  // High-load long polling with concurrency
  const concurrency = Number(process.env.RUNNER_CONCURRENCY || 100);
  const runner = run(bot, { fetch: { allowed_updates: allowedUpdates }, runner: { concurrency } });
  console.log('Runner started. Listening for updates...');
  // Graceful shutdown
  process.once('SIGINT', () => runner.stop());
  process.once('SIGTERM', () => runner.stop());
}
