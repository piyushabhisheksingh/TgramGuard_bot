import { boolEnv, numberEnv } from '../config.js';

const botPermsCache = new Map(); // chatId -> { until, isAdmin, canDelete }
const lastDeletePermWarning = new Map(); // chatId -> timestamp

export function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function codeMention(user) {
  return `<code>${escapeHtml(String(user?.id ?? '?'))}</code>`;
}

export function linkMention(user) {
  return `<a href="tg://user?id=${user?.id ?? '?'}">${escapeHtml(String(user?.id ?? '?'))}</a>`;
}

export function displayName(user = {}) {
  return [user.first_name, user.last_name, user.username ? `@${user.username}` : null]
    .filter(Boolean)
    .join(' ');
}

export function isGroupChat(ctx) {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export async function sendHtml(ctx, chatId, text, options = {}) {
  return ctx.api.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

export async function notifyAndCleanup(ctx, text, seconds = 8) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const cleanup = boolEnv('NOTIFY_CLEANUP');
  const cleanupSeconds = numberEnv('NOTIFY_CLEANUP_SECONDS', seconds, { min: 1 });
  const send = (replyTo) =>
    sendHtml(ctx, chatId, text, replyTo ? { reply_to_message_id: replyTo } : {});

  let sent;
  try {
    sent = await send(ctx.msg?.message_id);
  } catch {
    try {
      sent = await send();
    } catch {
      return;
    }
  }

  if (cleanup && sent?.message_id) {
    setTimeout(() => {
      ctx.api.deleteMessage(chatId, sent.message_id).catch(() => {});
    }, cleanupSeconds * 1000);
  }
}

export async function getBotPermissions(ctx) {
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
    botPermsCache.set(chatId, { until: now + 5 * 1000, isAdmin, canDelete });
    return { isAdmin, canDelete };
  } catch {
    botPermsCache.set(chatId, { until: now + 5 * 1000, isAdmin: false, canDelete: false });
    return { isAdmin: false, canDelete: false };
  }
}

export async function ensureBotCanDelete(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return false;
  const { canDelete } = await getBotPermissions(ctx);
  if (canDelete) return true;

  const now = Date.now();
  const last = lastDeletePermWarning.get(chatId) || 0;
  if (now - last > 10 * 60 * 1000) {
    lastDeletePermWarning.set(chatId, now);
    await notifyAndCleanup(
      ctx,
      '⚠️ <b>Missing permission:</b> I need admin permission <b>Delete messages</b> to enforce group rules. Please promote the bot and enable this permission.',
      15
    );
  }
  return false;
}
