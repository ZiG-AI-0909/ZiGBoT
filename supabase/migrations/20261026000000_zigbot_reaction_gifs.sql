-- =====================================================================
-- ZiGBoT reaction GIFs: per-server GIF settings per persona mode.
--
-- One JSON column on zb_guild_configs, validated in code on every save
-- (dashboard/lib/shared/gifs.js validateGifSettings) and coerced on every
-- load by the bot (sanitizeGifSettings). '{}' means "the defaults":
-- GIFs on, roast GIFs on in Savage mode, chat channels only.
-- Covered by the existing config RLS policies and audit trigger.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists gif_settings jsonb not null default '{}'::jsonb;

alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_gif_settings_check;
alter table public.zb_guild_configs add constraint zb_guild_configs_gif_settings_check
    check (jsonb_typeof(gif_settings) = 'object' and pg_column_size(gif_settings) < 8192);
