-- =====================================================================
-- ZiGBoT optional features (docs/ZIGBOT_FEATURE_MATRIX.md), Section C.
--
-- 1. zb_guild_configs.feature_settings: one jsonb object holding every
--    optional feature's settings ({ community: {...}, ... }). Everything
--    in it is off by default (dashboard/lib/shared/features.js), so a
--    server that changes nothing behaves exactly as before.
-- 2. zb_feature_records: one guild-scoped table for feature data (role
--    panels, birthdays, starboard posts, suggestions, scheduled jobs...).
--    kind + key name the record; due_at is set for scheduled jobs only.
--    The bot (service role) is the only reader and writer; browsers get
--    nothing.
-- Additive and re-runnable.
-- Rollback: drop table public.zb_feature_records;
--           alter table public.zb_guild_configs drop column feature_settings;
-- =====================================================================

alter table public.zb_guild_configs add column if not exists feature_settings jsonb not null default '{}'::jsonb;
alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_feature_settings_check;
alter table public.zb_guild_configs add constraint zb_guild_configs_feature_settings_check
    check (jsonb_typeof(feature_settings) = 'object' and pg_column_size(feature_settings) < 65536);

create table if not exists public.zb_feature_records (
    id          bigint generated always as identity primary key,
    guild_id    text not null check (guild_id ~ '^\d{17,20}$'),
    kind        text not null check (kind ~ '^[a-z][a-z0-9_]{0,39}$'),
    key         text not null check (char_length(key) between 1 and 120),
    data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 32768),
    due_at      timestamptz,
    version     integer not null default 1,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (guild_id, kind, key)
);
create index if not exists zb_feature_records_due_idx on public.zb_feature_records (due_at) where due_at is not null;
create index if not exists zb_feature_records_kind_idx on public.zb_feature_records (guild_id, kind, updated_at desc);

alter table public.zb_feature_records enable row level security;
revoke all on public.zb_feature_records from anon;
revoke all on public.zb_feature_records from authenticated;
grant select, insert, update, delete on public.zb_feature_records to service_role;
