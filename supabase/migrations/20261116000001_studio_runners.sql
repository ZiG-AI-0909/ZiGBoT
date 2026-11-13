-- =====================================================================
-- Self-hosted runners: the owner's own machine runs their bot.
-- studio_runners          one row per paired (or pairing) machine
-- studio_runner_commands  deploy/start/stop/restart queue
-- studio_runner_logs      recent log lines (newest 500 per runner)
-- Owners can read their own rows; every write goes through the server
-- (service role) after an ownership or runner-token check. Token and
-- pairing code are stored only as SHA-256 hashes.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_runner_logs; drop table public.studio_runner_commands;
--           drop table public.studio_runners; drop function public.studio_prune_runner_logs();
-- =====================================================================

create table if not exists public.studio_runners (
    id                  uuid primary key default gen_random_uuid(),
    project_id          uuid not null references public.studio_projects (id) on delete cascade,
    owner_id            uuid not null references auth.users (id) on delete cascade,
    name                text not null check (char_length(name) between 1 and 40),
    status              text not null default 'pairing' check (status in ('pairing', 'paired', 'revoked')),
    pairing_code_hash   text check (pairing_code_hash ~ '^[0-9a-f]{64}$'),
    pairing_expires_at  timestamptz,
    token_hash          text unique check (token_hash ~ '^[0-9a-f]{64}$'),
    state               text not null default 'unknown' check (state in ('unknown', 'installing', 'running', 'stopped', 'crashed')),
    platform            text check (char_length(platform) <= 60),
    version             text check (char_length(version) <= 20),
    last_seen_at        timestamptz,
    created_at          timestamptz not null default now()
);
create index if not exists studio_runners_project_idx on public.studio_runners (project_id);
create unique index if not exists studio_runners_pairing_idx on public.studio_runners (pairing_code_hash) where status = 'pairing';

create table if not exists public.studio_runner_commands (
    id          bigint generated always as identity primary key,
    runner_id   uuid not null references public.studio_runners (id) on delete cascade,
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    action      text not null check (action in ('deploy', 'start', 'stop', 'restart')),
    status      text not null default 'queued' check (status in ('queued', 'sent', 'done', 'failed', 'cancelled')),
    message     text check (char_length(message) <= 500),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists studio_runner_commands_runner_idx on public.studio_runner_commands (runner_id, id);

create table if not exists public.studio_runner_logs (
    id          bigint generated always as identity primary key,
    runner_id   uuid not null references public.studio_runners (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    level       text not null default 'info' check (level in ('info', 'warn', 'error')),
    line        text not null check (char_length(line) <= 500),
    created_at  timestamptz not null default now()
);
create index if not exists studio_runner_logs_runner_idx on public.studio_runner_logs (runner_id, id desc);

create or replace function public.studio_prune_runner_logs() returns trigger
    language plpgsql security definer set search_path = public as
$$
begin
    delete from public.studio_runner_logs
    where runner_id = new.runner_id
      and id < (select min(id) from (select id from public.studio_runner_logs where runner_id = new.runner_id order by id desc limit 500) newest);
    return null;
end
$$;
drop trigger if exists studio_runner_logs_prune on public.studio_runner_logs;
create trigger studio_runner_logs_prune after insert on public.studio_runner_logs
    for each row execute function public.studio_prune_runner_logs();

alter table public.studio_runners enable row level security;
alter table public.studio_runner_commands enable row level security;
alter table public.studio_runner_logs enable row level security;
revoke all on public.studio_runners, public.studio_runner_commands, public.studio_runner_logs from anon, authenticated;
-- Owners read their own rows, never the hashes.
grant select (id, project_id, owner_id, name, status, state, platform, version, last_seen_at, created_at) on public.studio_runners to authenticated;
grant select on public.studio_runner_commands, public.studio_runner_logs to authenticated;
grant all on public.studio_runners, public.studio_runner_commands, public.studio_runner_logs to service_role;

drop policy if exists studio_runners_select_own on public.studio_runners;
create policy studio_runners_select_own on public.studio_runners for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_runner_commands_select_own on public.studio_runner_commands;
create policy studio_runner_commands_select_own on public.studio_runner_commands for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_runner_logs_select_own on public.studio_runner_logs;
create policy studio_runner_logs_select_own on public.studio_runner_logs for select to authenticated using (owner_id = auth.uid());
