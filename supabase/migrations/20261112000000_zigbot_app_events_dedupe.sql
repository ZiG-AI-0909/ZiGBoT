-- =====================================================================
-- ZiGBoT install log: store each Discord webhook delivery once.
-- Discord resends an event it thinks failed. The dashboard now sends a
-- dedupe_key (sha256 of event type, user, server, install type and
-- timestamp) and inserts with ON CONFLICT DO NOTHING, so a retry adds no
-- row and sends no second DM. Rows from before this migration keep a null
-- key (Postgres allows any number of nulls under a unique index).
-- Additive and re-runnable. Until it is run, the dashboard falls back to
-- a plain insert (the old behaviour).
-- =====================================================================

alter table public.zb_app_events
    add column if not exists dedupe_key text;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'zb_app_events_dedupe_key_format' and conrelid = 'public.zb_app_events'::regclass
    ) then
        alter table public.zb_app_events
            add constraint zb_app_events_dedupe_key_format check (dedupe_key is null or dedupe_key ~ '^[a-f0-9]{64}$');
    end if;
end $$;

-- ON CONFLICT (dedupe_key) needs a plain (non-partial) unique index.
create unique index if not exists zb_app_events_dedupe_key_idx on public.zb_app_events (dedupe_key);
