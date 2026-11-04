-- =====================================================================
-- ZiGBoT: "18+ only" (dashboard Roles tab).
-- On: the AI chats only with members who have an 18+ role. Adult humour
-- also unlocks for them, in age-restricted channels only.
-- Off (default): behaviour is unchanged. Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists adults_only boolean not null default false;
