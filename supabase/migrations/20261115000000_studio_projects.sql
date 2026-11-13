-- =====================================================================
-- ZiGBoT Studio, Phase 1: accounts (plan flag) and projects.
-- Separate from ZiGBoT's own tables (all Studio tables start with studio_).
--
-- Row-level security: a signed-in user reaches ONLY rows whose owner_id is
-- their own auth.uid(); anon gets nothing. The dashboard API also filters
-- by owner_id server-side (defence in depth).
-- Plan limits are enforced in the database: a trigger takes a per-owner
-- advisory lock and counts, so parallel creates cannot pass the limit.
-- Plans are flags only; no payment exists (payments are BLOCKED).
-- Additive and re-runnable.
-- Rollback: drop table public.studio_projects; drop table public.studio_accounts;
--           drop function public.studio_project_limit(); drop function public.studio_plan_limit(text);
-- =====================================================================

create table if not exists public.studio_accounts (
    user_id     uuid primary key references auth.users (id) on delete cascade,
    plan        text not null default 'free' check (plan in ('free', 'developer', 'premium')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create table if not exists public.studio_projects (
    id           uuid primary key default gen_random_uuid(),
    owner_id     uuid not null references auth.users (id) on delete cascade,
    name         text not null check (char_length(name) between 3 and 40 and name ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$'),
    bot_name     text not null check (char_length(bot_name) between 2 and 32),
    description  text not null default '' check (char_length(description) <= 400),
    visibility   text not null default 'private' check (visibility in ('private', 'unlisted')),
    language     text not null check (language in ('javascript', 'typescript', 'python')),
    framework    text not null check (framework in ('discordjs', 'discordjs-ts', 'discordpy')),
    template     text not null check (template in ('blank', 'moderation', 'community', 'ai-assistant', 'ticket-support')),
    status       text not null default 'active' check (status in ('active', 'archived')),
    settings     jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) < 65536),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    -- A framework belongs to exactly one language.
    constraint studio_projects_framework_language check (
        (framework = 'discordjs' and language = 'javascript') or
        (framework = 'discordjs-ts' and language = 'typescript') or
        (framework = 'discordpy' and language = 'python'))
);
create unique index if not exists studio_projects_owner_name_idx on public.studio_projects (owner_id, lower(name));
create index if not exists studio_projects_owner_idx on public.studio_projects (owner_id, updated_at desc);

create or replace function public.studio_plan_limit(plan text) returns integer
    language sql immutable as
$$ select case plan when 'premium' then 100 when 'developer' then 20 else 3 end $$;

-- Archived projects still count (they keep their files); delete one to free a slot.
create or replace function public.studio_project_limit() returns trigger
    language plpgsql security definer set search_path = public as
$$
declare
    allowed integer;
    used integer;
begin
    perform pg_advisory_xact_lock(hashtext('studio_projects:' || new.owner_id::text));
    select public.studio_plan_limit(coalesce((select plan from public.studio_accounts where user_id = new.owner_id), 'free')) into allowed;
    select count(*) into used from public.studio_projects where owner_id = new.owner_id;
    if used >= allowed then
        raise exception 'studio_project_limit: plan allows % projects', allowed using errcode = 'P0001';
    end if;
    return new;
end
$$;
drop trigger if exists studio_projects_limit on public.studio_projects;
create trigger studio_projects_limit before insert on public.studio_projects
    for each row execute function public.studio_project_limit();

alter table public.studio_accounts enable row level security;
alter table public.studio_projects enable row level security;
revoke all on public.studio_accounts, public.studio_projects from anon;
revoke all on public.studio_accounts, public.studio_projects from authenticated;
grant select on public.studio_accounts to authenticated;
grant select, insert, update, delete on public.studio_projects to authenticated;
grant all on public.studio_accounts, public.studio_projects to service_role;

-- Users read their own plan; only the service role can change it.
drop policy if exists studio_accounts_select_own on public.studio_accounts;
create policy studio_accounts_select_own on public.studio_accounts
    for select to authenticated using (user_id = auth.uid());

drop policy if exists studio_projects_select_own on public.studio_projects;
create policy studio_projects_select_own on public.studio_projects
    for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_projects_insert_own on public.studio_projects;
create policy studio_projects_insert_own on public.studio_projects
    for insert to authenticated with check (owner_id = auth.uid());
drop policy if exists studio_projects_update_own on public.studio_projects;
create policy studio_projects_update_own on public.studio_projects
    for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists studio_projects_delete_own on public.studio_projects;
create policy studio_projects_delete_own on public.studio_projects
    for delete to authenticated using (owner_id = auth.uid());
