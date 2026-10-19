-- =====================================================================
-- ZiGBoT music: per-server settings, live player state and health.
--
-- * zb_guild_configs gets the dashboard's Music settings (DJ roles, request
--   channel, idle disconnect, default volume). music_enabled already exists.
-- * zb_music_state: one row per server, written ONLY by the bot (service
--   role) — what is playing and what is queued. Server admins may read their
--   own server's row (RLS).
-- * zb_music_health: one row ('main'), written by the bot — yt-dlp / ffmpeg
--   availability and the last playback error. Any signed-in admin may read.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists music_dj_role_ids text[] not null default '{}';
alter table public.zb_guild_configs add column if not exists music_channel_id text;
alter table public.zb_guild_configs add column if not exists music_idle_minutes integer not null default 3;
alter table public.zb_guild_configs add column if not exists music_default_volume integer not null default 80;

alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_music_check;
alter table public.zb_guild_configs
    add constraint zb_guild_configs_music_check check (
        cardinality(music_dj_role_ids) <= 10
        and (music_channel_id is null or music_channel_id ~ '^\d{17,20}$')
        and music_idle_minutes between 1 and 60
        and music_default_volume between 1 and 100
    );

create table if not exists public.zb_music_state (
    guild_id       text primary key references public.zb_guilds (guild_id) on delete cascade,
    status         text not null default 'idle' check (status in ('idle', 'playing', 'paused')),
    current_track  jsonb,
    upcoming       jsonb not null default '[]'::jsonb,
    queue_length   integer not null default 0 check (queue_length between 0 and 1000),
    volume         integer not null default 80 check (volume between 0 and 100),
    loop_mode      text not null default 'off' check (loop_mode in ('off', 'track', 'queue')),
    updated_at     timestamptz not null default now()
);

create table if not exists public.zb_music_health (
    id                text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
    ready             boolean not null default false,
    ytdlp_version     text check (ytdlp_version is null or char_length(ytdlp_version) <= 40),
    ffmpeg_ready      boolean not null default false,
    preferred_source  text not null default 'youtube' check (preferred_source in ('youtube', 'soundcloud')),
    active_players    integer not null default 0,
    last_error        text check (last_error is null or char_length(last_error) <= 300),
    last_error_at     timestamptz,
    updated_at        timestamptz not null default now()
);

alter table public.zb_music_state  enable row level security;
alter table public.zb_music_health enable row level security;

revoke all on public.zb_music_state, public.zb_music_health from anon;
revoke all on public.zb_music_state, public.zb_music_health from authenticated;
grant select on public.zb_music_state, public.zb_music_health to authenticated;
grant all on public.zb_music_state, public.zb_music_health to service_role;

drop policy if exists zb_music_state_select_admin on public.zb_music_state;
create policy zb_music_state_select_admin on public.zb_music_state
    for select to authenticated using (public.zb_is_guild_admin(guild_id));

drop policy if exists zb_music_health_select on public.zb_music_health;
create policy zb_music_health_select on public.zb_music_health
    for select to authenticated using (true);
