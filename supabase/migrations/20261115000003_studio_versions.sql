-- =====================================================================
-- ZiGBoT Studio, Phase 4: version history for the Code Studio.
-- A snapshot of a file is taken on every save; each project keeps its
-- newest 50 snapshots (a trigger removes older ones). Owner-only RLS, the
-- same path and size rules as studio_project_files.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_file_versions; drop function public.studio_prune_versions();
-- =====================================================================

create table if not exists public.studio_file_versions (
    id          bigint generated always as identity primary key,
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    path        text not null check (char_length(path) between 1 and 200 and path ~ '^[A-Za-z0-9._/-]+$' and path !~ '(^|/)\.\.(/|$)'),
    content     text not null default '' check (octet_length(content) <= 512000),
    created_at  timestamptz not null default now()
);
create index if not exists studio_file_versions_project_idx on public.studio_file_versions (project_id, id desc);

create or replace function public.studio_prune_versions() returns trigger
    language plpgsql security definer set search_path = public as
$$
begin
    delete from public.studio_file_versions
    where project_id = new.project_id
      and id not in (select id from public.studio_file_versions where project_id = new.project_id order by id desc limit 50);
    return null;
end
$$;
drop trigger if exists studio_file_versions_prune on public.studio_file_versions;
create trigger studio_file_versions_prune after insert on public.studio_file_versions
    for each row execute function public.studio_prune_versions();

alter table public.studio_file_versions enable row level security;
revoke all on public.studio_file_versions from anon;
revoke all on public.studio_file_versions from authenticated;
grant select, insert on public.studio_file_versions to authenticated;
grant all on public.studio_file_versions to service_role;

drop policy if exists studio_versions_select_own on public.studio_file_versions;
create policy studio_versions_select_own on public.studio_file_versions
    for select to authenticated using (owner_id = auth.uid());
drop policy if exists studio_versions_insert_own on public.studio_file_versions;
create policy studio_versions_insert_own on public.studio_file_versions
    for insert to authenticated with check (
        owner_id = auth.uid()
        and exists (select 1 from public.studio_projects p where p.id = project_id and p.owner_id = auth.uid())
    );
