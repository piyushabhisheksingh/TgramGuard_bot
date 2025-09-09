// Centralized bot command menus to avoid drift between startup and /set_mycommands

export const defaultCommands = [
  { command: 'start', description: 'Add bot to a group' },
  { command: 'help', description: 'Show help and commands' },
  { command: 'ping', description: 'Check bot availability' },
  { command: 'settings', description: 'Show settings help' },
  { command: 'rules_status', description: 'Show rules status' },
  { command: 'group_stats', description: "Show this chat's stats" },
  { command: 'user_stats', description: 'Show your stats (or reply/id)' },
  { command: 'user_stats_global', description: 'Show your global stats' },
  { command: 'top_violators', description: 'List top violators' },
];

export const adminCommands = [
  { command: 'rules_status', description: 'Show rules status' },
  { command: 'group_stats', description: "Show this chat's stats" },
  { command: 'user_stats', description: 'Show user stats (reply/id)' },
  { command: 'user_stats_global', description: 'Show global user stats' },
  { command: 'rule_chat_enable', description: 'Enable a rule in this chat' },
  { command: 'rule_chat_disable', description: 'Disable a rule in this chat' },
  { command: 'maxlen_chat_set', description: 'Set max message length for chat' },
  { command: 'whitelist_add', description: 'Whitelist a user ID in this chat' },
  { command: 'whitelist_remove', description: 'Remove a whitelisted user ID' },
  { command: 'whitelist_list', description: 'List chat whitelist' },
  { command: 'top_violators', description: 'List top violators' },
];

export const ownerPrivateCommands = [
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
];

