-- =====================================================================
-- ZiGBoT Studio, Phase 5: visual builder workflows and their test runs.
-- A workflow is JSON (blocks + connections from a fixed catalog; no code).
-- Runs are SIMULATOR results only (a mocked Discord); each workflow keeps
-- its newest 20. Owner-only RLS; at most 20 workflows per project.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_workflow_runs; drop table public.studio_workflows;
--           drop function public.studio_prune_runs(); drop function public.studio_workflow_limit();
-- =====================================================================

create table if not exists public.studio_workflows (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    name        text not null check (char_length(btrim(name)) between 1 and 60),
    graph       jsonb not null default '{"version":1,"nodes":[],"edges":[]}'::jsonb check (octet_length(graph::text) <= 262144),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists studio_workflows_project_idx on public.studio_workflows (project_id);

create or replace function public.studio_workflow_limit() returns trigger
    language plpgsql security definer set search_path = public as
$$
begin
    perform pg_advisory_xact_lock(hashtext('studio_workflows:' || new.project_id::text));
    if (select count(*) from public.studio_workflows where project_id = new.project_id) >= 20 then
        raise exception 'studio_workflow_limit: at most 20 workflows per project' using errcode = 'check_violation';
    end if;
    return new;
end
$$;
drop trigger if exists studio_workflows_limit on public.studio_workflows;
create trigger studio_workflows_limit before insert on public.studio_workflows
    for each row execute function public.studio_workflow_limit();

create table if not exists public.studio_workflow_runs (
    id           bigint generated always as identity primary key,
    workflow_id  uuid not null references public.studio_workflows (id) on delete cascade,
    project_id   uuid not null references public.studio_projects (id) on delete cascade,
    owner_id     uuid not null references auth.users (id) on delete cascade,
    ok           boolean not null,
    result       jsonb not null default '{}'::jsonb check (octet_length(result::text) <= 131072),
    created_at   timestamptz not null default now()
);
create index if not exists studio_workflow_runs_wf_idx on public.studio_workflow_runs (workflow_id, id desc);
create index if not exists studio_workflow_runs_owner_idx on public.studio_workflow_runs (owner_id, created_at desc);

create or replace function public.studio_prune_runs() returns trigger
    language plpgsql security definer set search_path = public as
$$
begin
    delete from public.studio_workflow_runs
    where workflow_id = new.workflow_id
      and id not in (select id from public.studio_workflow_runs where workflow_id = new.workflow_id order by id desc limit 20);
    return null;
end
$$;
drop trigger if exists studio_workflow_runs_prune on public.studio_workflow_runs;
create trigger studio_workflow_runs_prune after insert on public.studio_workflow_runs
    for each row execute function public.studio_prune_runs();

alter table public.studio_workflows enable row level security;
alter table public.studio_workflow_runs enable row level security;
revoke all on public.studio_workflows from anon;
revoke all on public.studio_workflows from authenticated;
revoke all on public.studio_workflow_runs from anon;
revoke all on public.studio_workflow_runs from authenticated;
grant select, insert, update, delete on public.studio_workflows to authenticated;
grant select, insert on public.studio_workflow_runs to authenticated;
grant all on public.studio_workflows to service_role;
grant all on public.studio_workflow_runs to service_role;

drop policy if exists studio_workflows_own on public.studio_workflows;
create policy studio_workflows_own on public.studio_workflows
    for all to authenticated
    using (owner_id = auth.uid())
    with check (
        owner_id = auth.uid()
        and exists (select 1 from public.studio_projects p where p.id = project_id and p.owner_id = auth.uid())
    );
drop policy if exists studio_runs_select_own on public.studio_workflow_runs;
create policy studio_runs_select_own on public.studio_workflow_runs
    for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_runs_insert_own on public.studio_workflow_runs;
create policy studio_runs_insert_own on public.studio_workflow_runs
    for insert to authenticated with check (
        owner_id = auth.uid()
        and exists (select 1 from public.studio_workflows w where w.id = workflow_id and w.owner_id = auth.uid() and w.project_id = project_id)
    );
