-- TG Group Security Bot — Supabase schema

-- Helper: auto-update updated_at columns
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  if NEW is distinct from OLD then
    NEW.updated_at := now();
  end if;
  return NEW;
end $$;

-- Bot/global settings
create table if not exists bot_settings (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_bot_settings_updated on bot_settings;
create trigger trg_bot_settings_updated
before update on bot_settings
for each row execute function set_updated_at();

-- Per-chat settings
create table if not exists chat_settings (
  chat_id text primary key,
  rules jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  whitelist jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_chat_settings_updated on chat_settings;
create trigger trg_chat_settings_updated
before update on chat_settings
for each row execute function set_updated_at();

-- Global daily stats
create table if not exists stats_global_daily (
  day date primary key,
  total integer not null default 0,
  by_violation jsonb not null default '{}'::jsonb,
  by_action jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Per-chat daily stats
create table if not exists stats_chat_daily (
  chat_id text not null,
  day date not null,
  total integer not null default 0,
  by_violation jsonb not null default '{}'::jsonb,
  by_action jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (chat_id, day)
);
create index if not exists idx_stats_chat_daily_day on stats_chat_daily (day);
drop trigger if exists trg_stats_chat_daily_updated on stats_chat_daily;
create trigger trg_stats_chat_daily_updated
before update on stats_chat_daily
for each row execute function set_updated_at();

-- Per-user (per-chat) daily stats
create table if not exists stats_user_daily (
  user_id text not null,
  chat_id text not null,
  day date not null,
  total integer not null default 0,
  by_violation jsonb not null default '{}'::jsonb,
  by_action jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, chat_id, day)
);
create index if not exists idx_stats_user_daily_user on stats_user_daily (user_id);
create index if not exists idx_stats_user_daily_chat on stats_user_daily (chat_id);
create index if not exists idx_stats_user_daily_day on stats_user_daily (day);
drop trigger if exists trg_stats_user_daily_updated on stats_user_daily;
create trigger trg_stats_user_daily_updated
before update on stats_user_daily
for each row execute function set_updated_at();

-- Optional moderation logs (read by logger.getRecentLogsSupabase)
create table if not exists moderation_logs (
  id bigserial primary key,
  ts timestamptz,
  created_at timestamptz not null default now(),
  action text not null,
  action_type text not null,
  violation text not null,
  chat_id text,
  chat_title text,
  chat_username text,
  user_id text,
  user_first_name text,
  user_last_name text,
  user_username text,
  content text,
  group_link text
);
create index if not exists idx_mlogs_ts on moderation_logs (ts desc, created_at desc);
create index if not exists idx_mlogs_chat on moderation_logs (chat_id);
create index if not exists idx_mlogs_violation on moderation_logs (violation);

-- Presence (used for user_groups and health candidates)
create table if not exists user_chat_presence (
  user_id text not null,
  chat_id text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (user_id, chat_id)
);
create index if not exists idx_presence_user on user_chat_presence (user_id);
create index if not exists idx_presence_chat on user_chat_presence (chat_id);

-- Health profile document per user
create table if not exists health_profiles (
  user_id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_health_profiles_updated on health_profiles;
create trigger trg_health_profiles_updated
before update on health_profiles
for each row execute function set_updated_at();

-- Health opt-out list
create table if not exists health_optout (
  user_id text primary key,
  created_at timestamptz not null default now()
);

-- Safelist terms (schema-tolerant: code upserts with either term or pattern)
create table if not exists safe_terms (
  id bigserial primary key,
  term text,
  pattern text,
  created_at timestamptz not null default now()
);
create unique index if not exists ux_safe_terms_term on safe_terms (term) where term is not null;
create unique index if not exists ux_safe_terms_pattern on safe_terms (pattern) where pattern is not null;

-- Custom explicit terms (added via /abuse or learner)
create table if not exists explicit_terms (
  pattern text primary key,
  created_at timestamptz not null default now()
);

