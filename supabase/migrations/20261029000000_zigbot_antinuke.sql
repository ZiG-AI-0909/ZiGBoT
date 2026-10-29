-- =====================================================================
-- ZiGBoT Anti-Nuke (free for every server).
--   zb_security_settings  per-server alert + optional containment settings
--   zb_security_events    incident history (kept 90 days; the bot purges older rows)
--   zb_security_status    what the bot can actually see, reported by the bot
-- Only the service role (bot worker, dashboard server routes after a live
-- admin check) can read or write these tables; browsers get nothing.
-- Additive and re-runnable.
-- =====================================================================

create table if not exists public.zb_security_settings (
    guild_id               text primary key check (guild_id ~ '^\d{17,20}$'),
    alert_channel_id       text check (alert_channel_id is null or alert_channel_id ~ '^\d{17,20}$'),
    notify_owner           boolean not null default true,
    staff_role_id          text check (staff_role_id is null or staff_role_id ~ '^\d{17,20}$'),
    everyone_on_critical   boolean not null default false,
    cooldown_minutes       integer not null default 10 check (cooldown_minutes between 1 and 120),
    thresholds             jsonb not null default '{}'::jsonb check (jsonb_typeof(thresholds) = 'object'),
    containment            jsonb not null default '{}'::jsonb check (jsonb_typeof(containment) = 'object'),
    trusted_user_ids       text[] not null default '{}' check (cardinality(trusted_user_ids) <= 25),
    maintenance_until      timestamptz,
    updated_by_discord_id  text,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now()
);

create table if not exists public.zb_security_events (
    id                   bigint generated always as identity primary key,
    guild_id             text not null check (guild_id ~ '^\d{17,20}$'),
    rule                 text not null check (char_length(rule) between 1 and 40),
    severity             text not null check (severity in ('CRITICAL', 'HIGH', 'MEDIUM')),
    actor_id             text check (actor_id is null or actor_id ~ '^\d{17,20}$'),
    actor_is_bot         boolean not null default false,
    target_ids           text[] not null default '{}' check (cardinality(target_ids) <= 50),
    resource_count       integer not null default 0 check (resource_count >= 0),
    occurrences          integer not null default 1 check (occurrences >= 1),
    reason               text check (reason is null or char_length(reason) <= 500),
    evidence             jsonb not null default '{}'::jsonb,
    containment_status   text not null default 'not_enabled'
        check (containment_status in ('not_enabled', 'not_applicable', 'succeeded', 'partial', 'failed', 'skipped')),
    containment_actions  jsonb not null default '[]'::jsonb,
    -- held: recorded but not posted (alert storm protection: max alerts per server per 10 min).
    alert_status         text not null default 'pending' check (alert_status in ('pending', 'sent', 'dm', 'failed', 'held')),
    status               text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);
create index if not exists zb_security_events_guild_idx on public.zb_security_events (guild_id, created_at desc);
create index if not exists zb_security_events_open_idx on public.zb_security_events (guild_id, status, severity);

create table if not exists public.zb_security_status (
    guild_id             text primary key check (guild_id ~ '^\d{17,20}$'),
    monitoring           boolean not null default false,
    missing_permissions  text[] not null default '{}',
    alert_channel_ok     boolean not null default false,
    last_event_at        timestamptz,
    last_checked_at      timestamptz not null default now(),
    bot_version          text check (bot_version is null or char_length(bot_version) <= 40)
);

alter table public.zb_security_settings enable row level security;
alter table public.zb_security_events enable row level security;
alter table public.zb_security_status enable row level security;
revoke all on public.zb_security_settings, public.zb_security_events, public.zb_security_status from anon;
revoke all on public.zb_security_settings, public.zb_security_events, public.zb_security_status from authenticated;
grant all on public.zb_security_settings, public.zb_security_events, public.zb_security_status to service_role;
