-- =====================================================================
-- ZiGBoT: "Roast the owner too" (dashboard AI behaviour tab).
-- Off (default): the server owner always gets the respectful mode.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists owner_roast boolean not null default false;
