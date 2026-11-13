-- =====================================================================
-- Platform Phase 6: a Studio project's specialization (onboarding choice).
-- One value today ('coding', 'workflow' or 'prompt'); existing projects
-- become 'coding'. Chosen at creation; owners cannot change it afterwards
-- through the API (validateProjectPatch only allows name, description,
-- status and visibility).
-- Additive and re-runnable.
-- Rollback: alter table public.studio_projects drop column specialization;
-- =====================================================================

alter table public.studio_projects add column if not exists specialization text not null default 'coding';
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'studio_projects_specialization_check') then
        alter table public.studio_projects add constraint studio_projects_specialization_check check (specialization in ('coding', 'workflow', 'prompt'));
    end if;
end
$$;
