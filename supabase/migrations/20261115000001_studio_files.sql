-- =====================================================================
-- ZiGBoT Studio, Phase 2: project files (generated source, later edited).
-- One row per file. Paths are relative, without "..", leading "/" or "\";
-- a file is at most 500 KB. Only the project's owner can reach its files
-- (row-level security on owner_id, and the project must be theirs too).
-- Files are text only and are NEVER executed by ZiGBoT.
-- Additive and re-runnable. Rollback: drop table public.studio_project_files;
-- =====================================================================

create table if not exists public.studio_project_files (
    id          bigint generated always as identity primary key,
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    path        text not null check (
        char_length(path) between 1 and 200
        and path !~ '(^|/)\.\.(/|$)'
        and path !~ '^[/\\]'
        and path !~ '\\'
        and path ~ '^[A-Za-z0-9._/-]+$'),
    content     text not null default '' check (octet_length(content) <= 512000),
    updated_at  timestamptz not null default now(),
    unique (project_id, path)
);
create index if not exists studio_project_files_project_idx on public.studio_project_files (project_id);

alter table public.studio_project_files enable row level security;
revoke all on public.studio_project_files from anon;
revoke all on public.studio_project_files from authenticated;
grant select, insert, update, delete on public.studio_project_files to authenticated;
grant all on public.studio_project_files to service_role;

drop policy if exists studio_files_own on public.studio_project_files;
create policy studio_files_own on public.studio_project_files
    for all to authenticated
    using (owner_id = auth.uid())
    with check (
        owner_id = auth.uid()
        and exists (select 1 from public.studio_projects p where p.id = project_id and p.owner_id = auth.uid())
    );
