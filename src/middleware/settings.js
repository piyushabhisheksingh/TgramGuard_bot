import { Composer } from 'grammy';
import { logAction, getBotStats, getGroupStats } from '../logger.js';
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
  getChatRules,
  getChatMaxLen,
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
      '  /botadmin_add <user_id> — or reply to a user to add as bot admin',
      '  /botadmin_remove <user_id> — or reply to a user to remove from bot admins',
      'Bot owner or bot admin:',
      '  /rule_global_enable <rule> — enable a rule globally',
      '  /rule_global_disable <rule> — disable a rule globally',
      '  /maxlen_global_set <n> — set global max length limit',
      '  /bot_stats — show bot-wide moderation stats',
      'Group owner/admin (with ban rights), bot admin or owner:',
      '  /rule_chat_enable <rule> — enable a rule for this chat',
      '  /rule_chat_disable <rule> — disable a rule for this chat',
      '  /maxlen_chat_set <n> — set max length limit for this chat',
      '  /whitelist_add <user_id> — or reply to a user to whitelist',
      '  /whitelist_remove <user_id> — or reply to a user to unwhitelist',
      '  /whitelist_list — show chat whitelist',
      '  /group_stats — show this chat’s moderation stats',
      '  /user_stats [user_id] — show user stats (reply or pass id; defaults to you)',
      '  /rules_status — show global/chat/effective rule status',
      '',
      `Rules: ${RULE_KEYS.join(', ')}`,
    ].join('\n');
    return ctx.reply(msg);
  });

  // Bot-wide stats (owner or bot admin)
  composer.command('bot_stats', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const daily = await import('../logger.js').then(m => m.getBotStatsPeriod(1));
    const weekly = await import('../logger.js').then(m => m.getBotStatsPeriod(7));
    const lines = [
      'Bot stats:',
      `- today total: ${daily.total}`,
      '- today by violation:',
      ...Object.entries(daily.byViolation).map(([k, v]) => `  • ${k}: ${v}`),
      '- today by action:',
      ...Object.entries(daily.byAction).map(([k, v]) => `  • ${k}: ${v}`),
      `- last 7 days total: ${weekly.total}`,
      '- last 7 days by violation:',
      ...Object.entries(weekly.byViolation).map(([k, v]) => `  • ${k}: ${v}`),
      '- last 7 days by action:',
      ...Object.entries(weekly.byAction).map(([k, v]) => `  • ${k}: ${v}`),
    ];
    return ctx.reply(lines.join('\n'));
  });

  // Per-chat stats (chat admin with ban rights, or bot admin/owner)
  composer.command('group_stats', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const daily = await import('../logger.js').then(m => m.getGroupStatsPeriod(ctx.chat.id, 1));
    const weekly = await import('../logger.js').then(m => m.getGroupStatsPeriod(ctx.chat.id, 7));
    const lines = [
      `Stats for chat ${ctx.chat.title || ctx.chat.id}:`,
      `- today total: ${daily.total}`,
      '- today by violation:',
      ...Object.entries(daily.byViolation).map(([k, v]) => `  • ${k}: ${v}`),
      '- today by action:',
      ...Object.entries(daily.byAction).map(([k, v]) => `  • ${k}: ${v}`),
      `- last 7 days total: ${weekly.total}`,
      '- last 7 days by violation:',
      ...Object.entries(weekly.byViolation).map(([k, v]) => `  • ${k}: ${v}`),
      '- last 7 days by action:',
      ...Object.entries(weekly.byAction).map(([k, v]) => `  • ${k}: ${v}`),
    ];
    return ctx.reply(lines.join('\n'));
  });

  // User stats (per-chat, with optional "global" flag). Anyone can view.
  composer.command('user_stats', async (ctx) => {
    const tokens = ctx.message.text.trim().split(/\s+/);
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    // Accept numeric id in args
    for (const t of tokens.slice(1)) {
      const n = Number(t);
      if (Number.isFinite(n)) { targetId = n; break; }
    }
    // Default to caller
    if (!Number.isFinite(targetId)) targetId = ctx.from?.id;
    if (!Number.isFinite(targetId)) return;
    const globalFlag = tokens.includes('global');
    const mod = await import('../logger.js');
    const scopeChatId = globalFlag ? null : ctx.chat?.id;
    const daily = await mod.getUserStatsPeriod(targetId, scopeChatId, 1);
    const weekly = await mod.getUserStatsPeriod(targetId, scopeChatId, 7);
    const lifetime = await mod.getUserLifetimeStats(targetId, scopeChatId);
    const dailyAvg = weekly.total / 7;
    const weekly28 = await mod.getUserStatsPeriod(targetId, scopeChatId, 28);
    const weeklyAvg = weekly28.total / 4; // per-week avg over last 28 days
    const risk = mod.computeRiskScore(weekly.byViolation);
    const riskLabel = (s) => (s < 3 ? 'Low' : s < 10 ? 'Medium' : 'High');
    const topViolations = Object.entries(weekly.byViolation)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`);
    const scopeLabel = globalFlag ? 'across all chats' : 'in this chat';
    const lines = [
      `User stats for ${targetId} ${scopeLabel}:`,
      `- today total: ${daily.total}`,
      `- last 7 days total: ${weekly.total}`,
      `- daily average (7d): ${isFinite(dailyAvg) ? dailyAvg.toFixed(2) : '0.00'}`,
      `- weekly average (28d): ${isFinite(weeklyAvg) ? weeklyAvg.toFixed(2) : '0.00'}`,
      `- lifetime total: ${lifetime.total}`,
      `- risk score (7d): ${risk.toFixed(2)} (${riskLabel(risk)})`,
      ...(topViolations.length ? [
        '- top violations (7d):',
        ...topViolations.map((s) => `  • ${s}`),
      ] : []),
      '- 7d by violation:',
      ...Object.entries(weekly.byViolation).map(([k, v]) => `  • ${k}: ${v}`),
    ];
    return ctx.reply(lines.join('\n'));
  });

  // Global user stats command (alias)
  composer.command('user_stats_global', async (ctx) => {
    // Reuse handler with implicit global flag
    const base = ctx.message.text.replace(/^\/user_stats_global\b/, '/user_stats global');
    ctx.message.text = base;
    return composer.middleware()(ctx, () => Promise.resolve());
  });

  // Admin management (owner only)
  composer.command('botadmin_add', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const replyFrom = ctx.message?.reply_to_message?.from;
    let id = replyFrom?.id;
    if (!Number.isFinite(id)) {
      const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
      id = Number(idStr);
    }
    if (!Number.isFinite(id)) {
      return ctx.reply('Usage: Reply to a user with /botadmin_add, or provide /botadmin_add <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be promoted to bot admin.');
    }
    await addBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_add', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Added bot admin: ${id}` });
    return ctx.reply(`Added bot admin: ${id}`);
  });

  composer.command('botadmin_remove', async (ctx) => {
    if (!isBotOwner(ctx)) return;
    const replyFrom = ctx.message?.reply_to_message?.from;
    let id = replyFrom?.id;
    if (!Number.isFinite(id)) {
      const [, idStr] = ctx.message.text.trim().split(/\s+/, 2);
      id = Number(idStr);
    }
    if (!Number.isFinite(id)) {
      return ctx.reply('Usage: Reply to a user with /botadmin_remove, or provide /botadmin_remove <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots are not in the bot admin list.');
    }
    await removeBotAdmin(id);
    await logAction(ctx, { action: 'botadmin_remove', action_type: 'admin', user: replyFrom || { id }, chat: ctx.chat, violation: '-', content: `Removed bot admin: ${id}` });
    return ctx.reply(`Removed bot admin: ${id}`);
  });

  // Global rule toggles (owner or bot admin)
  composer.command('rule_global_enable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, true);
    await logAction(ctx, { action: 'rule_global_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} globally` });
    return ctx.reply(`Enabled ${rule} globally.`);
  });

  composer.command('rule_global_disable', async (ctx) => {
    if (!(await isBotAdminOrOwner(ctx))) return;
    const [, rule] = ctx.message.text.trim().split(/\s+/, 2);
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    await setGlobalRule(rule, false);
    await logAction(ctx, { action: 'rule_global_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} globally` });
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
    await logAction(ctx, { action: 'rule_chat_enable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Enabled ${rule} for chat` });
    return ctx.reply(`Enabled ${rule} for this chat.`);
  });

  composer.command('rule_chat_disable', async (ctx) => {
    const rule = ctx.message.text.trim().split(/\s+/, 2)[1];
    if (!RULE_KEYS.includes(rule)) return ctx.reply(`Unknown rule. Use one of: ${RULE_KEYS.join(', ')}`);
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    await setChatRule(String(ctx.chat.id), rule, false);
    await logAction(ctx, { action: 'rule_chat_disable', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Disabled ${rule} for chat` });
    return ctx.reply(`Disabled ${rule} for this chat.`);
  });

  // Status
  composer.command('rules_status', async (ctx) => {
    const s = await getSettings();
    const chatId = String(ctx.chat.id);
    const effective = await getEffectiveRules(chatId);
    const chatRules = await getChatRules(chatId);
    const effectiveMax = await getEffectiveMaxLen(chatId);
    const globalMax = s.global_limits?.max_len ?? DEFAULT_LIMITS.max_len;
    const chatMax = await getChatMaxLen(chatId);
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
    await logAction(ctx, { action: 'maxlen_global_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Global max_len=${Math.trunc(n)}` });
    return ctx.reply(`Global max length limit set to ${Math.trunc(n)}.`);
  });

  composer.command('maxlen_chat_set', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    const n = Number(ctx.message.text.trim().split(/\s+/, 2)[1]);
    if (!Number.isFinite(n)) return ctx.reply('Usage: /maxlen_chat_set <number>');
    await setChatMaxLenLimit(String(ctx.chat.id), n);
    await logAction(ctx, { action: 'maxlen_chat_set', action_type: 'settings', chat: ctx.chat, violation: '-', content: `Chat max_len=${Math.trunc(n)}` });
    return ctx.reply(`Chat max length limit set to ${Math.trunc(n)}.`);
  });

  // Chat whitelist commands (chat admin with ban rights, or bot admin/owner)
  composer.command('whitelist_add', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    // Prefer reply target if command is used as a reply
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    if (!Number.isFinite(targetId)) {
      const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
      targetId = Number(arg);
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('Usage: Reply to a user with /whitelist_add, or provide /whitelist_add <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be whitelisted.');
    }
    await addChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_add', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Whitelisted user ${targetId}` });
    return ctx.reply(`User ${targetId} added to whitelist for this chat.`);
  });

  composer.command('whitelist_remove', async (ctx) => {
    const userId = ctx.from?.id;
    const ok = (await isBotAdminOrOwner(ctx)) || (await isChatAdminWithBan(ctx, userId));
    if (!ok) return;
    // Prefer reply target if command is used as a reply
    const replyFrom = ctx.message?.reply_to_message?.from;
    let targetId = replyFrom?.id;
    if (!Number.isFinite(targetId)) {
      const arg = ctx.message.text.trim().split(/\s+/, 2)[1];
      targetId = Number(arg);
    }
    if (!Number.isFinite(targetId)) {
      return ctx.reply('Usage: Reply to a user with /whitelist_remove, or provide /whitelist_remove <user_id>');
    }
    if (replyFrom?.is_bot) {
      return ctx.reply('Bots cannot be whitelisted.');
    }
    await removeChatWhitelistUser(String(ctx.chat.id), targetId);
    await logAction(ctx, { action: 'whitelist_remove', action_type: 'settings', user: replyFrom || { id: targetId }, chat: ctx.chat, violation: '-', content: `Removed user ${targetId} from whitelist` });
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
          { command: 'help', description: 'Show help and commands' },
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
      await ctx.api.setMyCommands(
        [
          { command: 'botadmin_add', description: 'Add a bot admin (owner only)' },
          { command: 'botadmin_remove', description: 'Remove a bot admin' },
          { command: 'rule_global_enable', description: 'Enable a rule globally' },
          { command: 'rule_global_disable', description: 'Disable a rule globally' },
          { command: 'maxlen_global_set', description: 'Set global max length' },
        ],
        { scope: { type: 'default' } }
      );

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
