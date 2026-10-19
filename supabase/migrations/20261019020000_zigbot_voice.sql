-- =====================================================================
-- ZiGBoT voice chat: per-server voice settings (dashboard 🎙️ Voice tab).
--
-- * voice_speaker: Sarvam Bulbul voice ('' = the bot's default voice).
-- * voice_pace: speaking speed in percent (100 = normal, 50-200).
-- * voice_language: 'auto' (follow the server language), 'hi-IN' or 'en-IN'.
-- * voice_speak_replies: also speak typed replies when ZiGBoT is in that
--   voice channel.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists voice_speaker text not null default '';
alter table public.zb_guild_configs add column if not exists voice_pace integer not null default 100;
alter table public.zb_guild_configs add column if not exists voice_language text not null default 'auto';
alter table public.zb_guild_configs add column if not exists voice_speak_replies boolean not null default true;

alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_voice_check;
alter table public.zb_guild_configs
    add constraint zb_guild_configs_voice_check check (
        voice_speaker ~ '^[a-z_]{0,40}$'
        and voice_pace between 50 and 200
        and voice_language in ('auto', 'hi-IN', 'en-IN')
    );
