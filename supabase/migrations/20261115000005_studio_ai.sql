-- =====================================================================
-- ZiGBoT Studio, Phase 6: AI creator proposals and daily usage.
-- The AI only proposes changes (status 'pending'); the owner approves or
-- rejects them. Usage rows back the per-user daily AI limit (claimed before
-- each AI call). Owner-only RLS. Proposals keep the newest 30 per project.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_ai_proposals; drop table public.studio_ai_usage;
--           drop function public.studio_prune_proposals();
-- =====================================================================

create table if not exists public.studio_ai_proposals (
    id          uuid primary key default gen_random_uuid(),
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    request     text not null check (char_length(request) between 1 and 2000),
    plan        jsonb not null default '[]'::jsonb,
    changes     jsonb not null default '[]'::jsonb,
    rejected    jsonb not null default '[]'::jsonb,
    status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at  timestamptz not null default now(),
    decided_at  timestamptz,
    check (octet_length(changes::text) <= 2097152)
);
create index if not exists studio_ai_proposals_project_idx on public.studio_ai_proposals (project_id, created_at desc);

create or replace function public.studio_prune_proposals() returns trigger
    language plpgsql security definer set search_path = public as
$$
begin
    delete from public.studio_ai_proposals
    where project_id = new.project_id
      and id not in (select id from public.studio_ai_proposals where project_id = new.project_id order by created_at desc, id limit 30);
    return null;
end
$$;
drop trigger if exists studio_ai_proposals_prune on public.studio_ai_proposals;
create trigger studio_ai_proposals_prune after insert on public.studio_ai_proposals
    for each row execute function public.studio_prune_proposals();

create table if not exists public.studio_ai_usage (
    id          bigint generated always as identity primary key,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    project_id  uuid references public.studio_projects (id) on delete set null,
    created_at  timestamptz not null default now()
);
create index if not exists studio_ai_usage_owner_idx on public.studio_ai_usage (owner_id, created_at desc);

alter table public.studio_ai_proposals enable row level security;
alter table public.studio_ai_usage enable row level security;
revoke all on public.studio_ai_proposals from anon;
revoke all on public.studio_ai_proposals from authenticated;
revoke all on public.studio_ai_usage from anon;
revoke all on public.studio_ai_usage from authenticated;
grant select, insert, update on public.studio_ai_proposals to authenticated;
grant select, insert on public.studio_ai_usage to authenticated;
grant all on public.studio_ai_proposals to service_role;
grant all on public.studio_ai_usage to service_role;

drop policy if exists studio_ai_proposals_own on public.studio_ai_proposals;
create policy studio_ai_proposals_own on public.studio_ai_proposals
    for all to authenticated
    using (owner_id = auth.uid())
    with check (
        owner_id = auth.uid()
        and exists (select 1 from public.studio_projects p where p.id = project_id and p.owner_id = auth.uid())
    );
drop policy if exists studio_ai_usage_select_own on public.studio_ai_usage;
create policy studio_ai_usage_select_own on public.studio_ai_usage
    for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_ai_usage_insert_own on public.studio_ai_usage;
create policy studio_ai_usage_insert_own on public.studio_ai_usage
    for insert to authenticated with check (owner_id = auth.uid());
