-- =====================================================================
-- ZiGBoT scheduled greetings (dashboard Roles tab). The bot worker sends
-- them; the dashboard's server routes create and edit them after a live
-- admin check. Only the service role can read or write: browsers get nothing.
--
-- Duplicate-free sending: before each send the bot "claims" the occurrence
-- with one conditional UPDATE (id + version + enabled), which moves
-- next_run_at forward and bumps version. Only one claim can win, so
-- retries, restarts or a second worker never send the same occurrence twice.
-- Every dashboard edit bumps version too, so a claim made from a stale
-- read loses. Additive and re-runnable.
-- =====================================================================

create table if not exists public.zb_greeting_schedules (
    id                     uuid primary key default gen_random_uuid(),
    guild_id               text not null references public.zb_guilds (guild_id) on delete cascade,
    channel_id             text not null check (channel_id ~ '^\d{17,20}$'),
    created_by_discord_id  text check (created_by_discord_id is null or created_by_discord_id ~ '^\d{17,20}$'),
    updated_by_discord_id  text check (updated_by_discord_id is null or updated_by_discord_id ~ '^\d{17,20}$'),
    message                text not null check (char_length(message) between 1 and 1500),
    schedule_type          text not null check (schedule_type in ('once', 'daily', 'weekly', 'interval')),
    -- Local wall-clock start in time_zone, e.g. 2026-11-01T09:00.
    start_local            text not null check (start_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
    time_zone              text not null check (char_length(time_zone) between 1 and 64),
    weekdays               smallint[] not null default '{}' check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
    interval_minutes       integer check (interval_minutes is null or interval_minutes between 60 and 10080),
    end_date               date,
    enabled                boolean not null default false,
    next_run_at            timestamptz,
    last_attempt_at        timestamptz,
    last_sent_at           timestamptz,
    last_status            text check (last_status is null or last_status in
        ('sending', 'sent', 'missed', 'failed', 'channel_missing', 'no_permission', 'bot_not_in_server', 'completed')),
    last_error             text check (last_error is null or char_length(last_error) <= 200),
    recent_runs            jsonb not null default '[]'::jsonb check (jsonb_typeof(recent_runs) = 'array'),
    last_test_at           timestamptz,
    version                integer not null default 1,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    constraint zb_greeting_weekly_days check (schedule_type <> 'weekly' or cardinality(weekdays) > 0),
    constraint zb_greeting_interval_set check (schedule_type <> 'interval' or interval_minutes is not null)
);
create index if not exists zb_greeting_schedules_guild_idx on public.zb_greeting_schedules (guild_id, created_at);
create index if not exists zb_greeting_schedules_due_idx on public.zb_greeting_schedules (next_run_at) where enabled;

alter table public.zb_greeting_schedules enable row level security;
revoke all on public.zb_greeting_schedules from anon;
revoke all on public.zb_greeting_schedules from authenticated;
grant all on public.zb_greeting_schedules to service_role;
