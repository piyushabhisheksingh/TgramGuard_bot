# Telegram Group Security Bot (grammY)

A Telegram group security bot built with grammY that enforces:

- Max message length of 200 characters
- No message edits (edited messages are deleted)
- No sexual/explicit content (applies to messages and media captions)
- No links of any kind (including Telegram links; applies to messages and media captions)
- Users with links or explicit content in their bio cannot post
- Exemptions: group owner/admins and bot owner/admins are not moderated

## Prerequisites

- Node.js 18+
- A Telegram Bot token from @BotFather
- Add the bot to your group as an admin with at least:
  - Delete messages
  - Restrict members (optional but recommended)
- Disable Privacy Mode in @BotFather for the bot so it can see all group messages:
  - /setprivacy → choose your bot → Disable

## Setup

1. Copy `.env.example` to `.env` and set `BOT_TOKEN`.
2. Install dependencies:

```bash
npm install
```

3. Run the bot (high-load runner by default):

```bash
npm start
```

## How It Works

- Listens to `message` and `edited_message` updates.
- Deletes edited messages immediately and posts a short-lived notice.
- Checks message text or caption for:
  - Character length > 200
  - Links (via Telegram entities and regex)
  - Sexual/explicit terms (keyword list)
- Before allowing any post, checks the sender's bio (`getChat(userId)`) for links.
  - If the bio contains a link, the user's messages are deleted and a notice is posted.
  - Result is cached per user to reduce API calls.

Notes:
- Telegram may not always expose user bios to bots; if not accessible, the bot assumes no bio link (best effort).
- All notices are auto-deleted after a few seconds to avoid clutter.

## Commands

- `/ping` — simple liveness check (responds with `pong`).
- `/settings` or `/help` — show available admin commands.
- `/rules_status` — show global/chat/effective rule status for the current chat.

Admin commands
- Owner: `/botadmin_add <user_id>`, `/botadmin_remove <user_id>`
- Owner or bot admin: `/rule_global_enable <rule>`, `/rule_global_disable <rule>`
- Owner or bot admin: `/maxlen_global_set <n>`
- Group owner/admin (with ban rights), bot admin or owner: `/rule_chat_enable <rule>`, `/rule_chat_disable <rule>`
- Group owner/admin (with ban rights), bot admin or owner: `/maxlen_chat_set <n>`
- Group owner/admin (with ban rights), bot admin or owner: `/whitelist_add <user_id>`, `/whitelist_remove <user_id>`, `/whitelist_list`

Rules keys
- `no_edit`, `max_len`, `no_links`, `no_explicit`, `bio_block`

Limits
- `max_len` limit defaults to 200 characters.
- Set global limit: `/maxlen_global_set 200`
- Set per-chat limit: `/maxlen_chat_set 150`

## Customization

- Update explicit word list and link regexes in `src/filters.js` as needed for your community.
- Adjust notice TTL in `notifyAndCleanup` within `src/bot.js`.
- Change max length in `overCharLimit` usage.

## Deployment

- High-load long polling: uses grammY Runner for concurrent update handling. Control concurrency with `RUNNER_CONCURRENCY` (default 100).
- Webhook/worker mode: set `WEBHOOK_URL` (and optional `WEBHOOK_SECRET`, `PORT`). The bot sets the webhook and starts a minimal HTTP server. Suitable for server environments or reverse proxy setups. For serverless/Workers, reuse `webhookCallback(bot, 'cloudflare')` pattern.

### Env variables

- `BOT_TOKEN`: Telegram bot token from @BotFather
- `RUNNER_CONCURRENCY`: number of concurrent update handlers (default 100)
- `WEBHOOK_URL`: full https URL for webhook mode (enables webhook + HTTP server)
- `WEBHOOK_SECRET`: optional secret token for webhook verification
- `PORT`: port for the minimal HTTP server (default 3000)
- `BOT_OWNER_ID`: Telegram user ID of the bot owner (exempt from moderation)
- `BOT_ADMIN_IDS`: comma or space-separated Telegram user IDs of bot admins (exempt)

### Persistence

- Bot settings are stored in `data/settings.json`. It is created automatically on first run.

## Troubleshooting

- If messages are not being deleted:
  - Ensure the bot is an admin with Delete messages permission.
  - Disable Privacy Mode in @BotFather.
  - Check the bot logs for permission errors.
