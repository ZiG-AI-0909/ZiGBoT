-- =====================================================================
-- Platform Phase 3 (completed): active workflows run on the owner's runner.
-- studio_runners.workflows_deployed   the last bundle contained live workflows
-- studio_runners.entitlement_checked_at  throttle for the Premium re-check the
--                                     poll route does (every 10 minutes); if
--                                     Premium lapsed, the server queues a
--                                     redeploy without the workflows.
-- Additive and re-runnable.
-- Rollback: alter table public.studio_runners drop column workflows_deployed, drop column entitlement_checked_at;
-- =====================================================================

alter table public.studio_runners add column if not exists workflows_deployed boolean not null default false;
alter table public.studio_runners add column if not exists entitlement_checked_at timestamptz;
