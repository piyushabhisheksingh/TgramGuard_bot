import { Composer } from 'grammy';
import { RULE_KEYS, DEFAULT_RULES, DEFAULT_LIMITS } from '../rules.js';
import {
  addBotAdmin,
  removeBotAdmin,
  setGlobalRule,
  setChatRule,
  getSettings,
  getEffectiveRules,
  setGlobalMaxLenLimit,
  setChatMaxLenLimit,
  getEffectiveMaxLen,
  addChatWhitelistUser,
  removeChatWhitelistUser,
  getChatWhitelist,
} from '../store/settings.js';

// Utilities shared with security middleware (re-implemented minimal)
async function isChatAdminWithBan(ctx, userId) {
  const chatId = ctx.chat?.id;
  if (!chatId || !userId) return false;
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    if (!member) return false;
    if (member.status === 'creator') return true;
    if (member.status === 'administrator') {
      return Boolean(member.can_restrict_members ?? true);
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isBotOwner(ctx) {
  const userId = ctx.from?.id;
  const ownerId = Number(process.env.BOT_OWNER_ID || NaN);
  return Number.isFinite(ownerId) && userId === ownerId;
}

async function isBotAdminOrOwner(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isBotOwner(ctx)) return true;
  try {
    const s = await getSettings();
    return s.bot_admin_ids.includes(userId);
  } catch {
    return false;
  }
}

function formatRulesStatus(globalRules, chatRules, effective, limits) {
  const lines = [];
  lines.push('Rules status:');
  for (const k of RULE_KEYS) {
    const g = globalRules[k] ? 'ON' : 'off';
    const c = chatRules?.[k];
    const cStr = c === undefined ? '-' : c ? 'ON' : 'off';
    const e = effective[k] ? 'ON' : 'off';
    lines.push(`- ${k}: effective ${e} (global ${g}, chat ${cStr})`);
  }
  // Limits
  lines.push('Limits:');
  lines.push(
    `- max_len: effective ${limits.effectiveMax} (global ${limits.globalMax}, chat ${limits.chatMax ?? '-'})`
  );
  return lines.join('\n');
}

export function settingsMiddleware() {
  const composer = new Composer();

  // Help
  composer.command(['settings', 'help'], async (ctx) => {
    const msg = [
      'Settings commands:',
      'Bot owner only:',
      '  /botadmin_add <user_id> — add a bot admin',
      '  /botadmin_remove <user_id> — remove a bot admin',
      'Bot owner or bot admin:',
      '  /rule_global_enable <rule> — enable a rule globally',
      '  /rule_global_disable <rule> — disable a rule globally',
      '  /maxlen_global_set <n> — set global max length limit',
      'Group owner/admin (with ban rights), bot admin or owner:',
      '  /rule_chat_enable <rule> — enable a rule for this chat',
      '  /rule_chat_disable <rule> — disable a rule for this chat',
      '  /maxlen_chat_set <n> — set max length limit for this chat',
      '  /whitelist_add <user_id> — exempt a user in this chat',
      '  /whitelist_remove <user_id> — remove exemption in this chat',
      '  /whitelist_list — show chat whitelist',
      '  /rules_status — show global/chat/effective rule status',
      '',
      `Rules: ${RULE_KEYS.join(', ')}`,
    ].join('\n');
    return ctx.reply(msg);
  });

  // Admin management (owner only)
  composer.command('botadmin_add', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
    const id = Number(idStr);
    if (!Number.isFinite(id)) return ctx.reply('Usage: /botadmin_add <user_id>');
    await addBotAdmin(id);
    return ctx.reply(`Added bot admin: ${id}`);
  });

  composer.command('botadmin_remove', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
    const id = Number(idStr);
    if (!Number.isFinite(id)) return ctx.reply('Usage: /botadmin_remove <user_id>');
    await removeBotAdmin(id);
    return ctx.reply(`Removed bot admin: ${id}`);
  });

  // Global rule toggles (owner or bot admin)
  composer.command('rule_global_enable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, true);
    return ctx.reply(`Enabled ${rule} globally.`);
  });

  composer.command('rule_global_disable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, false);
    return ctx.reply(`Disabled ${rule} globally.`);
  });

  // Chat rule toggles (chat admin with ban rights, or bot admin/owner)
  composer.command('rule_chat_enable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, true);
    return ctx.reply(`Enabled ${rule} for this chat.`);
  });

  composer.command('rule_chat_disable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, false);
    return ctx.reply(`Disabled ${rule} for this chat.`);
  });

  // Status
  composer.command('rules_status', async (ctx) => {
    const s = await getSettings();
    const effective = await getEffectiveRules(String(ctx.chat.id));
    const chatRules = s.chat_rules[String(ctx.chat.id)];
    const effectiveMax = await getEffectiveMaxLen(String(ctx.chat.id));
    const globalMax = s.global_limits?.max_len ?? DEFAULT_LIMITS.max_len;
    const chatMax = s.chat_limits?.[String(ctx.chat.id)]?.max_len;
    const msg = formatRulesStatus(s.global_rules, chatRules, effective, {
      effectiveMax,
      globalMax,
      chatMax,
    });
    return ctx.reply(msg);
  });

  // Global and chat max_len setters
  composer.command('maxlen_global_set', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('Usage: /maxlen_global_set <number>');
    await setGlobalMaxLenLimit(n);
    return ctx.reply(`Global max length limit set to ${Math.trunc(n)}.`);
  });

  composer.command('maxlen_chat_set', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('Usage: /maxlen_chat_set <number>');
    await setChatMaxLenLimit(String(ctx.chat.id), n);
    return ctx.reply(`Chat max length limit set to ${Math.trunc(n)}.`);
  });

  // Chat whitelist commands (chat admin with ban rights, or bot admin/owner)
  composer.command('whitelist_add', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
    const targetId = Number(arg);
    if (!Number.isFinite(targetId)) return ctx.reply('Usage: /whitelist_add <user_id>');
    await addChatWhitelistUser(String(ctx.chat.id), targetId);
    return ctx.reply(`User ${targetId} added to whitelist for this chat.`);
  });

  composer.command('whitelist_remove', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
    const targetId = Number(arg);
    if (!Number.isFinite(targetId)) return ctx.reply('Usage: /whitelist_remove <user_id>');
    await removeChatWhitelistUser(String(ctx.chat.id), targetId);
    return ctx.reply(`User ${targetId} removed from whitelist for this chat.`);
  });

  composer.command('whitelist_list', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const list = await getChatWhitelist(String(ctx.chat.id));
    if (!list.length) return ctx.reply('Whitelist is empty for this chat.');
    return ctx.reply(`Whitelisted user IDs:\n${list.join('\n')}`);
  });

  // Bot command menu management
  // Set up command list for users and for all chat administrators
  composer.command('set_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      // Default (all users) concise commands
      await ctx.api.setMyCommands(
        [
          { command: 'ping', description: 'Check bot availability' },
          { command: 'settings', description: 'Show settings help' },
          { command: 'rules_status', description: 'Show rules status' },
        ],
        { scope: { type: 'default' } }
      );

      // Admin commands menu for all chat administrators
      await ctx.api.setMyCommands(
        [
          { command: 'rules_status', description: 'Show rules status' },
          { command: 'rule_chat_enable', description: 'Enable a rule in this chat' },
          { command: 'rule_chat_disable', description: 'Disable a rule in this chat' },
          { command: 'maxlen_chat_set', description: 'Set max message length for chat' },
          { command: 'whitelist_add', description: 'Whitelist a user ID in this chat' },
          { command: 'whitelist_remove', description: 'Remove a whitelisted user ID' },
          { command: 'whitelist_list', description: 'List chat whitelist' },
        ],
        { scope: { type: 'all_chat_administrators' } }
      );

      // Owner-level commands (optional): keep minimal to avoid clutter
      // Uncomment to expose owner tools globally
      // await ctx.api.setMyCommands(
      //   [
      //     { command: 'botadmin_add', description: 'Add a bot admin (owner only)' },
      //     { command: 'botadmin_remove', description: 'Remove a bot admin' },
      //     { command: 'rule_global_enable', description: 'Enable a rule globally' },
      //     { command: 'rule_global_disable', description: 'Disable a rule globally' },
      //     { command: 'maxlen_global_set', description: 'Set global max length' },
      //   ],
      //   { scope: { type: 'default' } }
      // );

      return ctx.reply('Bot commands have been set.');
    } catch (e) {
      return ctx.reply(`Failed to set commands: ${e?.description || e?.message || e}`);
    }
  });

  // Remove command menu (default and admin scopes)
  composer.command('remove_mycommands', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    try {
      await ctx.api.deleteMyCommands({ scope: { type: 'default' } });
      await ctx.api.deleteMyCommands({ scope: { type: 'all_chat_administrators' } });
      return ctx.reply('Bot commands have been removed.');
    } catch (e) {
      return ctx.reply(`Failed to remove commands: ${e?.description || e?.message || e}`);
    }
  });

  return composer;
}
