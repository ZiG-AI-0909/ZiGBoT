-- =====================================================================
-- ZiGBoT Studio, Phase 8: template marketplace.
-- A template is a copy of a project's exportable files (text only, no
-- secrets) with a static scan result. Every new template starts as
-- 'pending_review'; only the server (service role, Super Admin review)
-- changes the status. Signed-in users see published templates and their
-- own; installing copies the files into a new project, nothing is run.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_templates;
-- =====================================================================

create table if not exists public.studio_templates (
    id                 uuid primary key default gen_random_uuid(),
    owner_id           uuid not null references auth.users (id) on delete cascade,
    source_project_id  uuid references public.studio_projects (id) on delete set null,
    name               text not null check (char_length(name) between 3 and 60),
    description        text not null default '' check (char_length(description) <= 500),
    framework          text not null check (framework in ('discordjs', 'discordjs-ts', 'discordpy')),
    base_template      text not null check (base_template in ('blank', 'moderation', 'community', 'ai-assistant', 'ticket-support')),
    files              jsonb not null check (jsonb_typeof(files) = 'array' and octet_length(files::text) <= 6291456),
    scan               jsonb not null default '{}'::jsonb,
    status             text not null default 'pending_review' check (status in ('pending_review', 'published', 'rejected', 'unpublished')),
    installs           integer not null default 0 check (installs >= 0),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);
create index if not exists studio_templates_status_idx on public.studio_templates (status, created_at desc);
create index if not exists studio_templates_owner_idx on public.studio_templates (owner_id);

-- Install counter: bumps only published templates; callable by the server only.
create or replace function public.studio_count_install(template uuid) returns void
    language sql security definer set search_path = public as
$$
    update public.studio_templates set installs = installs + 1 where id = template and status = 'published';
$$;
revoke all on function public.studio_count_install(uuid) from public;
revoke all on function public.studio_count_install(uuid) from anon;
revoke all on function public.studio_count_install(uuid) from authenticated;
grant execute on function public.studio_count_install(uuid) to service_role;

alter table public.studio_templates enable row level security;
revoke all on public.studio_templates from anon;
revoke all on public.studio_templates from authenticated;
grant select on public.studio_templates to authenticated;
grant all on public.studio_templates to service_role;

drop policy if exists studio_templates_visible on public.studio_templates;
create policy studio_templates_visible on public.studio_templates
    for select to authenticated using (status = 'published' or owner_id = auth.uid());
