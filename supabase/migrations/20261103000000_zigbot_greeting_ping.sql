-- =====================================================================
-- ZiGBoT scheduled greetings: optional ping. null = ping nobody (default),
-- 'everyone' / 'here', or one role id. The bot allows mentions for ONLY
-- this target, so nothing typed in the message itself can ping.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_greeting_schedules add column if not exists ping_target text;

alter table public.zb_greeting_schedules drop constraint if exists zb_greeting_schedules_ping_target_check;
alter table public.zb_greeting_schedules add constraint zb_greeting_schedules_ping_target_check
    check (ping_target is null or ping_target in ('everyone', 'here') or ping_target ~ '^\d{17,20}$');
