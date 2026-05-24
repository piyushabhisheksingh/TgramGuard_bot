import { BOT_ADMIN_IDS, BOT_OWNER_ID } from '../config.js';
import { getSettings, isUserWhitelisted } from '../store/settings.js';

const adminStatusCache = new Map(); // `${chatId}:${userId}` -> { isAdmin, until }

export async function isBotPrivileged(userId) {
  if (!Number.isFinite(userId)) return false;
  if (Number.isFinite(BOT_OWNER_ID) && userId === BOT_OWNER_ID) return true;
  if (BOT_ADMIN_IDS.has(userId)) return true;
  try {
    const settings = await getSettings();
    return settings.bot_admin_ids.includes(userId);
  } catch {
    return false;
  }
}

export async function isChatAdminOrOwner(ctx, userId) {
  const chatId = ctx.chat?.id;
  if (!chatId || !userId) return false;
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const cached = adminStatusCache.get(key);
  if (cached && cached.until > now) return cached.isAdmin;

  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    const isAdmin = member?.status === 'administrator' || member?.status === 'creator';
    adminStatusCache.set(key, { isAdmin, until: now + 5 * 1000 });
    return isAdmin;
  } catch {
    adminStatusCache.set(key, { isAdmin: false, until: now + 5 * 1000 });
    return false;
  }
}

export async function isExempt(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (await isBotPrivileged(userId)) return true;
  if (await isChatAdminOrOwner(ctx, userId)) return true;
  const chatId = ctx.chat?.id;
  return Boolean(chatId && (await isUserWhitelisted(chatId, userId)));
}
