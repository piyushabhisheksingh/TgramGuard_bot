import 'dotenv/config';
import { Bot, webhookCallback } from 'grammy';
import { run, sequentialize } from '@grammyjs/runner';
import { autoRetry } from '@grammyjs/auto-retry';
import { throttler } from '@grammyjs/transformer-throttler';
import http from 'node:http';
import { securityMiddleware } from './middleware/security.js';
import { settingsMiddleware } from './middleware/settings.js';
import { bootstrapAdminsFromEnv } from './store/settings.js';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is not set. Put it in .env');
  process.exit(1);
}

const bot = new Bot(token);

// Reliability: auto-retry transient network errors and 429s with backoff
bot.api.config.use(autoRetry());

// Flood limits: queue API calls to respect Telegram rate limits
bot.api.config.use(throttler());

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

// Startup: webhook (worker/server) or high-load runner
const allowedUpdates = ['message', 'edited_message'];

const USE_WEBHOOK = Boolean(process.env.WEBHOOK_URL);
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
