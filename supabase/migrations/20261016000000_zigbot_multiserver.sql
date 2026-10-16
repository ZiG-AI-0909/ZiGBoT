-- =====================================================================
-- ZiGBoT multi-server configuration schema
-- =====================================================================
-- * Additive only: every object is prefixed `zb_` and created with
--   IF NOT EXISTS / CREATE OR REPLACE, so it is safe to run in an existing
--   Supabase project (e.g. one shared with another app) and never touches
--   other tables or existing data.
-- * Existing bot data (memories, warnings, behaviour ledger, YouTube state)
--   stays in MongoDB; this schema only holds per-server configuration.
-- * RLS is enabled on every table. Browser (anon/authenticated) access is
--   limited to servers the user was VERIFIED (live, via Discord, by our
--   server code) to manage within the last 15 minutes. The service-role
--   key — used only by the bot worker and dashboard server routes —
--   bypasses RLS and must never reach a browser.
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+ (Supabase runs 15+).

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.zb_profiles (
    user_id          uuid primary key references auth.users (id) on delete cascade,
    discord_user_id  text not null unique check (discord_user_id ~ '^\d{17,20}$'),
    username         text not null default '' check (char_length(username) <= 100),
    avatar_url       text check (avatar_url is null or char_length(avatar_url) <= 500),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create table if not exists public.zb_guilds (
    guild_id          text primary key check (guild_id ~ '^\d{17,20}$'),
    name              text not null default '' check (char_length(name) <= 100),
    icon              text check (icon is null or char_length(icon) <= 200),
    owner_discord_id  text check (owner_discord_id is null or owner_discord_id ~ '^\d{17,20}$'),
    bot_installed     boolean not null default false,
    installed_at      timestamptz default now(),
    removed_at        timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- Servers the user belongs to, from Discord OAuth (/users/@me/guilds) at
-- login. Written only by server code. Used for the server picker; every
-- privileged action is still re-verified live against Discord.
create table if not exists public.zb_user_guilds (
    user_id     uuid not null references auth.users (id) on delete cascade,
    guild_id    text not null check (guild_id ~ '^\d{17,20}$'),
    name        text not null default '' check (char_length(name) <= 100),
    icon        text check (icon is null or char_length(icon) <= 200),
    can_manage  boolean not null default false,
    fetched_at  timestamptz not null default now(),
    primary key (user_id, guild_id)
);
create index if not exists zb_user_guilds_user_idx on public.zb_user_guilds (user_id) where can_manage;

-- Short-lived proof that server code verified (live, via the bot token) that
-- this user can manage this guild. RLS policies key off this table.
create table if not exists public.zb_guild_admins (
    user_id          uuid not null references auth.users (id) on delete cascade,
    guild_id         text not null references public.zb_guilds (guild_id) on delete cascade,
    discord_user_id  text not null check (discord_user_id ~ '^\d{17,20}$'),
    verified_at      timestamptz not null default now(),
    primary key (user_id, guild_id)
);
create index if not exists zb_guild_admins_guild_idx on public.zb_guild_admins (guild_id);

create table if not exists public.zb_guild_configs (
    guild_id               text primary key references public.zb_guilds (guild_id) on delete cascade,
    enabled                boolean not null default true,
    default_tone           text not null default 'gentle' check (default_tone in ('gentle', 'savage', 'neutral')),
    replace_base_persona   boolean not null default false,
    custom_system_prompt   text not null default '' check (char_length(custom_system_prompt) <= 4000),
    response_instructions  text not null default '' check (char_length(response_instructions) <= 2000),
    server_rules           text not null default '' check (char_length(server_rules) <= 2000),
    language               text not null default '' check (char_length(language) <= 60),
    response_style         text not null default '' check (char_length(response_style) <= 300),
    response_length        text not null default 'short' check (response_length in ('short', 'medium', 'long')),
    respond_to_all         boolean not null default false,
    auto_reply_keywords    boolean not null default false,
    cooldown_seconds       integer not null default 15 check (cooldown_seconds between 0 and 3600),
    allowed_channel_ids    text[] not null default '{}' check (cardinality(allowed_channel_ids) <= 100),
    chat_channel_ids       text[] not null default '{}' check (cardinality(chat_channel_ids) <= 100),
    blocked_channel_ids    text[] not null default '{}' check (cardinality(blocked_channel_ids) <= 100),
    log_channel_id         text check (log_channel_id is null or log_channel_id ~ '^\d{17,20}$'),
    memory_enabled         boolean not null default false,
    reputation_enabled     boolean not null default true,
    music_enabled          boolean not null default true,
    voice_enabled          boolean not null default true,
    legacy_role_rules      boolean not null default false,
    version                integer not null default 1,
    updated_by             uuid references auth.users (id) on delete set null,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create table if not exists public.zb_role_mappings (
    id                uuid primary key default gen_random_uuid(),
    guild_id          text not null references public.zb_guilds (guild_id) on delete cascade,
    role_id           text not null check (role_id ~ '^\d{17,20}$'),
    role_name         text not null default '' check (char_length(role_name) <= 100),
    tier              text not null default 'custom' check (tier in ('admin', 'moderator', 'member', 'custom')),
    priority          integer not null default 0 check (priority between -1000 and 1000),
    tone              text check (tone is null or tone in ('gentle', 'savage', 'neutral')),
    pronouns          text check (pronouns is null or pronouns in ('she/her', 'he/him', 'they/them')),
    instructions      text not null default '' check (char_length(instructions) <= 1000),
    allowed_features  text[] not null default '{}'
        check (allowed_features <@ array['chat','roast','memory','music','voice','moderation','admin_tools']::text[]),
    denied_features   text[] not null default '{}'
        check (denied_features <@ array['chat','roast','memory','music','voice','moderation','admin_tools']::text[]),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    unique (guild_id, role_id)
);
create index if not exists zb_role_mappings_guild_idx on public.zb_role_mappings (guild_id);

create table if not exists public.zb_config_audit_log (
    id             bigint generated always as identity primary key,
    guild_id       text not null,
    actor_user_id  uuid,
    actor_role     text,
    action         text not null check (action in ('INSERT', 'UPDATE', 'DELETE', 'RESET', 'INSTALL', 'UNINSTALL')),
    table_name     text not null,
    record_key     text,
    before         jsonb,
    after          jsonb,
    created_at     timestamptz not null default now()
);
create index if not exists zb_config_audit_guild_idx on public.zb_config_audit_log (guild_id, created_at desc);

create table if not exists public.zb_bot_heartbeat (
    id            text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
    last_seen_at  timestamptz not null default now(),
    guild_count   integer not null default 0,
    version       text not null default '' check (char_length(version) <= 40)
);

create table if not exists public.zb_preview_usage (
    id          bigint generated always as identity primary key,
    user_id     uuid not null references auth.users (id) on delete cascade,
    guild_id    text not null,
    created_at  timestamptz not null default now()
);
create index if not exists zb_preview_usage_user_idx on public.zb_preview_usage (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Helper: is the current user a freshly verified admin of this guild?
-- SECURITY DEFINER so the check itself is not subject to RLS recursion.
-- ---------------------------------------------------------------------
create or replace function public.zb_is_guild_admin(gid text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.zb_guild_admins a
        where a.user_id = auth.uid()
          and a.guild_id = gid
          and a.verified_at > now() - interval '15 minutes'
    );
$$;
revoke all on function public.zb_is_guild_admin(text) from public;
grant execute on function public.zb_is_guild_admin(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Integrity triggers: browser-originated updates can never move a row to
-- another guild, and version/updated_by/updated_at are server-assigned.
-- ---------------------------------------------------------------------
create or replace function public.zb_guard_config_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.guild_id is distinct from old.guild_id then
        raise exception 'guild_id is immutable';
    end if;
    new.version := old.version + 1;
    new.updated_at := now();
    new.created_at := old.created_at;
    if auth.uid() is not null then
        new.updated_by := auth.uid();
    end if;
    return new;
end;
$$;

create or replace function public.zb_guard_config_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
end;
$$;

drop trigger if exists zb_guard_config_insert on public.zb_guild_configs;
create trigger zb_guard_config_insert
    before insert on public.zb_guild_configs
    for each row execute function public.zb_guard_config_insert();

drop trigger if exists zb_guard_config_update on public.zb_guild_configs;
create trigger zb_guard_config_update
    before update on public.zb_guild_configs
    for each row execute function public.zb_guard_config_update();

create or replace function public.zb_guard_mapping_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.guild_id is distinct from old.guild_id then
        raise exception 'guild_id is immutable';
    end if;
    new.updated_at := now();
    new.created_at := old.created_at;
    return new;
end;
$$;

drop trigger if exists zb_guard_mapping_update on public.zb_role_mappings;
create trigger zb_guard_mapping_update
    before update on public.zb_role_mappings
    for each row execute function public.zb_guard_mapping_update();

-- ---------------------------------------------------------------------
-- Audit log: every config / role-mapping change is recorded automatically,
-- whoever made it (dashboard user or bot service role).
-- ---------------------------------------------------------------------
create or replace function public.zb_audit_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    gid text;
    key text;
begin
    gid := coalesce(new.guild_id, old.guild_id);
    if tg_table_name = 'zb_role_mappings' then
        key := coalesce(new.role_id, old.role_id);
    else
        key := gid;
    end if;
    insert into public.zb_config_audit_log (guild_id, actor_user_id, actor_role, action, table_name, record_key, before, after)
    values (
        gid,
        auth.uid(),
        coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                 (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
                 current_user),
        tg_op,
        tg_table_name,
        key,
        case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
        case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
    );
    return coalesce(new, old);
end;
$$;

drop trigger if exists zb_audit_guild_configs on public.zb_guild_configs;
create trigger zb_audit_guild_configs
    after insert or update or delete on public.zb_guild_configs
    for each row execute function public.zb_audit_change();

drop trigger if exists zb_audit_role_mappings on public.zb_role_mappings;
create trigger zb_audit_role_mappings
    after insert or update or delete on public.zb_role_mappings
    for each row execute function public.zb_audit_change();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.zb_profiles          enable row level security;
alter table public.zb_guilds            enable row level security;
alter table public.zb_user_guilds       enable row level security;
alter table public.zb_guild_admins      enable row level security;
alter table public.zb_guild_configs     enable row level security;
alter table public.zb_role_mappings     enable row level security;
alter table public.zb_config_audit_log  enable row level security;
alter table public.zb_bot_heartbeat     enable row level security;
alter table public.zb_preview_usage     enable row level security;

-- The anon role (logged-out browsers) gets nothing at all.
revoke all on public.zb_profiles, public.zb_guilds, public.zb_user_guilds, public.zb_guild_admins,
    public.zb_guild_configs, public.zb_role_mappings, public.zb_config_audit_log,
    public.zb_bot_heartbeat, public.zb_preview_usage from anon;

-- Authenticated users: least privilege. Identity tables are read-only.
revoke all on public.zb_profiles, public.zb_guilds, public.zb_user_guilds, public.zb_guild_admins,
    public.zb_guild_configs, public.zb_role_mappings, public.zb_config_audit_log,
    public.zb_bot_heartbeat, public.zb_preview_usage from authenticated;
grant select on public.zb_profiles, public.zb_guilds, public.zb_user_guilds, public.zb_guild_admins,
    public.zb_config_audit_log, public.zb_bot_heartbeat, public.zb_preview_usage to authenticated;
grant select, insert, update on public.zb_guild_configs to authenticated;
grant select, insert, update, delete on public.zb_role_mappings to authenticated;
grant insert on public.zb_preview_usage to authenticated;

grant all on public.zb_profiles, public.zb_guilds, public.zb_user_guilds, public.zb_guild_admins,
    public.zb_guild_configs, public.zb_role_mappings, public.zb_config_audit_log,
    public.zb_bot_heartbeat, public.zb_preview_usage to service_role;

-- Policies (drop + create so the migration is re-runnable)
drop policy if exists zb_profiles_select_own on public.zb_profiles;
create policy zb_profiles_select_own on public.zb_profiles
    for select to authenticated using (user_id = auth.uid());

drop policy if exists zb_user_guilds_select_own on public.zb_user_guilds;
create policy zb_user_guilds_select_own on public.zb_user_guilds
    for select to authenticated using (user_id = auth.uid());

drop policy if exists zb_guild_admins_select_own on public.zb_guild_admins;
create policy zb_guild_admins_select_own on public.zb_guild_admins
    for select to authenticated using (user_id = auth.uid());

drop policy if exists zb_guilds_select_admin on public.zb_guilds;
create policy zb_guilds_select_admin on public.zb_guilds
    for select to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_guild_configs_select_admin on public.zb_guild_configs;
create policy zb_guild_configs_select_admin on public.zb_guild_configs
    for select to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_guild_configs_insert_admin on public.zb_guild_configs;
create policy zb_guild_configs_insert_admin on public.zb_guild_configs
    for insert to authenticated with check (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_guild_configs_update_admin on public.zb_guild_configs;
create policy zb_guild_configs_update_admin on public.zb_guild_configs
    for update to authenticated
    using (public.zb_is_guild_admin(guild_id))
    with check (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_role_mappings_select_admin on public.zb_role_mappings;
create policy zb_role_mappings_select_admin on public.zb_role_mappings
    for select to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_role_mappings_insert_admin on public.zb_role_mappings;
create policy zb_role_mappings_insert_admin on public.zb_role_mappings
    for insert to authenticated with check (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_role_mappings_update_admin on public.zb_role_mappings;
create policy zb_role_mappings_update_admin on public.zb_role_mappings
    for update to authenticated
    using (public.zb_is_guild_admin(guild_id))
    with check (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_role_mappings_delete_admin on public.zb_role_mappings;
create policy zb_role_mappings_delete_admin on public.zb_role_mappings
    for delete to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_audit_select_admin on public.zb_config_audit_log;
create policy zb_audit_select_admin on public.zb_config_audit_log
    for select to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_heartbeat_select on public.zb_bot_heartbeat;
create policy zb_heartbeat_select on public.zb_bot_heartbeat
    for select to authenticated using (true);

drop policy if exists zb_preview_usage_select_own on public.zb_preview_usage;
create policy zb_preview_usage_select_own on public.zb_preview_usage
    for select to authenticated using (user_id = auth.uid());

drop policy if exists zb_preview_usage_insert_own on public.zb_preview_usage;
create policy zb_preview_usage_insert_own on public.zb_preview_usage
    for insert to authenticated
    with check (user_id = auth.uid() and public.zb_is_guild_admin(guild_id));
