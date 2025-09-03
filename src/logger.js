// Simple centralized logger to send moderation/admin actions to a log chat
// Configure via env:
// - LOG_CHAT_ID: Telegram chat ID (group/channel) where logs will be sent
// - LOG_ENABLE: true/1/yes/on to enable (defaults to enabled if LOG_CHAT_ID present)

function boolFromEnv(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatUser(user) {
  if (!user) return '-';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'user';
  const mention = user.id ? `<a href="tg://user?id=${user.id}">${escapeHtml(name)}</a>` : escapeHtml(name);
  const uname = user.username ? ` (@${escapeHtml(user.username)})` : '';
  return `${mention}${uname} [${user.id ?? '?'}]`;
}

function formatChat(chat) {
  if (!chat) return '-';
  const title = escapeHtml(chat.title || '');
  const id = chat.id ?? '?';
  let link = '';
  if (chat.username) {
    const u = escapeHtml(chat.username);
    link = ` — <a href="https://t.me/${u}">@${u}</a>`;
  }
  return `${title} [${id}]${link}`;
}

export async function logAction(ctxOrApi, details = {}) {
  const LOG_CHAT_ID = process.env.LOG_CHAT_ID;
  if (!LOG_CHAT_ID) return; // disabled if not configured
  const enabled = boolFromEnv(process.env.LOG_ENABLE || 'true');
  if (!enabled) return;

  const api = ctxOrApi?.api || ctxOrApi; // support ctx or api

  const now = new Date();
  const ts = now.toISOString();

  const user = details.user || (ctxOrApi?.from || ctxOrApi?.msg?.from);
  const chat = details.chat || ctxOrApi?.chat;
  const action = details.action || 'action';
  const actionType = details.action_type || details.actionType || 'moderation';
  const violation = details.violation || '-';
  const contentRaw = typeof details.content === 'string' ? details.content : details.content?.text || '';
  const content = contentRaw ? escapeHtml(String(contentRaw).slice(0, 512)) : '';

  const lines = [];
  lines.push(`<b>Action:</b> ${escapeHtml(action)} (${escapeHtml(actionType)})`);
  lines.push(`<b>Violation:</b> ${escapeHtml(String(violation))}`);
  if (chat) lines.push(`<b>Group:</b> ${formatChat(chat)}`);
  if (user) lines.push(`<b>User:</b> ${formatUser(user)}`);
  if (content) lines.push(`<b>Content:</b> ${content}`);
  lines.push(`<b>Time:</b> ${escapeHtml(ts)}`);

  const html = lines.join('\n');
  try {
    await api.sendMessage(LOG_CHAT_ID, html, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (_) {}
}

