export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function numberEnv(name, fallback, { min, max, integer = false } = {}) {
  const raw = Number(process.env[name]);
  let value = Number.isFinite(raw) ? raw : fallback;
  if (integer) value = Math.trunc(value);
  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);
  return value;
}

export function idSetEnv(name) {
  return new Set(
    (process.env[name] || '')
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  );
}

export const BOT_OWNER_ID = Number(process.env.BOT_OWNER_ID || NaN);
export const BOT_ADMIN_IDS = idSetEnv('BOT_ADMIN_IDS');

export const MUTE_PERMISSIONS = {
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
