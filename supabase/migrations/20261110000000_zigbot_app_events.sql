-- =====================================================================
-- ZiGBoT install log (/admin/installs). One row per event:
--   APPLICATION_AUTHORIZED / APPLICATION_DEAUTHORIZED: Discord's webhook
--     (dashboard route /api/discord/webhook), with who added ZiGBoT.
--   GUILD_REMOVED: the bot itself, when it leaves or is kicked from a server
--     (Discord sends no webhook for that).
-- Server-side only: browsers get no access. Additive and re-runnable.
-- =====================================================================

create table if not exists public.zb_app_events (
    id                bigint generated always as identity primary key,
    event_type        text not null check (event_type in ('APPLICATION_AUTHORIZED', 'APPLICATION_DEAUTHORIZED', 'GUILD_REMOVED')),
    -- 0 = added to a server, 1 = added to a user's account; null when unknown.
    integration_type  smallint check (integration_type is null or integration_type in (0, 1)),
    user_discord_id   text check (user_discord_id is null or user_discord_id ~ '^\d{17,20}$'),
    user_name         text check (user_name is null or char_length(user_name) <= 100),
    guild_id          text check (guild_id is null or guild_id ~ '^\d{17,20}$'),
    guild_name        text check (guild_name is null or char_length(guild_name) <= 100),
    scopes            text[] not null default '{}',
    occurred_at       timestamptz not null default now(),
    created_at        timestamptz not null default now()
);
create index if not exists zb_app_events_occurred_idx on public.zb_app_events (occurred_at desc);
create index if not exists zb_app_events_guild_idx on public.zb_app_events (guild_id);

alter table public.zb_app_events enable row level security;
revoke all on public.zb_app_events from anon;
revoke all on public.zb_app_events from authenticated;
grant select, insert on public.zb_app_events to service_role;
