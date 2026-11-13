-- =====================================================================
-- Platform Phase 3: automation activation is Premium.
-- * studio_accounts.plan_expires_at: paid Studio plans can expire
--   (null = no end date). Set by the service role only, like the plan.
-- * studio_workflows.active / activated_at: only the server sets these,
--   after checking the user's entitlement. Browsers can still create, rename
--   and edit drafts, but can no longer write the activation columns.
-- Additive and re-runnable.
-- Rollback: alter table public.studio_workflows drop column active, drop column activated_at;
--           alter table public.studio_accounts drop column plan_expires_at;
--           grant update on public.studio_workflows to authenticated;
-- =====================================================================

alter table public.studio_accounts add column if not exists plan_expires_at timestamptz;

alter table public.studio_workflows add column if not exists active boolean not null default false;
alter table public.studio_workflows add column if not exists activated_at timestamptz;
create index if not exists studio_workflows_active_idx on public.studio_workflows (owner_id) where active;

-- Column-level write access: drafts yes, activation no.
revoke insert, update on public.studio_workflows from authenticated;
grant insert (project_id, owner_id, name, graph) on public.studio_workflows to authenticated;
grant update (name, graph, updated_at) on public.studio_workflows to authenticated;
