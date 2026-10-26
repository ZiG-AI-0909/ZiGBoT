-- =====================================================================
-- ROLLBACK for supabase/migrations/20261024000000_zigbot_custom_identity.sql
--
-- Run ONLY after:
--   1. Turning custom identity off everywhere (CUSTOM_IDENTITY_ENABLED=false
--      on the bot and the dashboard) and letting the bot's revert-only sync
--      put every server back to the default ZiGBoT profile.
--   2. Taking a backup: Supabase Dashboard → Database → Backups (or
--      `pg_dump --table=public.zb_guild_identity --table=public.zb_identity_blocks
--       --table=public.zb_config_audit_log`), and downloading anything you
--      want to keep from the zb-identity storage bucket.
--   3. Emptying the zb-identity bucket (Dashboard → Storage), because
--      storage objects cannot be removed safely from SQL.
--
-- It refuses to run (and changes nothing) while audit history still uses
-- the identity actions, so that history is never deleted by accident.
-- =====================================================================

do $$
begin
    if exists (select 1 from public.zb_config_audit_log where action in ('APPLY', 'REVERT', 'REVIEW', 'BLOCK')) then
        raise exception 'zb_config_audit_log still has APPLY/REVERT/REVIEW/BLOCK rows. Export them, delete them deliberately, then run this rollback again.';
    end if;
end $$;

-- The audit action check as it was before the migration.
alter table public.zb_config_audit_log drop constraint if exists zb_config_audit_log_action_check;
alter table public.zb_config_audit_log add constraint zb_config_audit_log_action_check
    check (action in ('INSERT', 'UPDATE', 'DELETE', 'RESET', 'INSTALL', 'UNINSTALL'));

drop table if exists public.zb_identity_blocks;
drop table if exists public.zb_guild_identity;

-- Remove the bucket only once it is empty (see step 3).
do $$
begin
    if to_regclass('storage.buckets') is not null then
        if to_regclass('storage.objects') is not null
            and exists (select 1 from storage.objects where bucket_id = 'zb-identity') then
            raise notice 'zb-identity bucket still has files; empty it in the Dashboard, then delete the bucket there.';
        else
            delete from storage.buckets where id = 'zb-identity';
        end if;
    end if;
end $$;
