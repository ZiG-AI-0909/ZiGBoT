-- =====================================================================
-- ZiGBoT Studio, Phase 7: deployment history (foundation).
-- Real hosting is NOT available yet; this table is written only when a
-- runtime provider exists. Rows keep the deployed (exportable) files so a
-- rollback can re-deploy them; secrets are never stored here. Newest 10 per
-- project. Owner can read; only the server (service role) writes.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_deployments;
-- =====================================================================

create table if not exists public.studio_deployments (
    id               uuid primary key default gen_random_uuid(),
    project_id       uuid not null references public.studio_projects (id) on delete cascade,
    owner_id         uuid not null references auth.users (id) on delete cascade,
    version          integer not null check (version > 0),
    status           text not null check (status in ('live', 'stopped', 'failed', 'superseded', 'rolled_back')),
    provider         text not null check (char_length(provider) between 1 and 40),
    ref              text check (char_length(ref) <= 200),
    error            text check (char_length(error) <= 300),
    manifest         jsonb not null default '[]'::jsonb,
    files            jsonb,
    source_version   integer,
    rolled_back_from integer,
    created_at       timestamptz not null default now(),
    unique (project_id, version),
    check (files is null or octet_length(files::text) <= 8388608)
);
create index if not exists studio_deployments_project_idx on public.studio_deployments (project_id, version desc);

alter table public.studio_deployments enable row level security;
revoke all on public.studio_deployments from anon;
revoke all on public.studio_deployments from authenticated;
grant select (id, project_id, owner_id, version, status, provider, error, manifest, source_version, rolled_back_from, created_at) on public.studio_deployments to authenticated;
grant all on public.studio_deployments to service_role;

drop policy if exists studio_deployments_select_own on public.studio_deployments;
create policy studio_deployments_select_own on public.studio_deployments
    for select to authenticated using (owner_id = auth.uid());
