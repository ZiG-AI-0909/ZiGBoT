-- =====================================================================
-- ZiGBoT: Savage mode roast intensity (dashboard AI behaviour tab + /setup).
-- mild | spicy (default) | savage. Hard limits apply at every level and are
-- enforced on the bot's output in code (dashboard/lib/shared/roast.js).
-- Additive and re-runnable. Until it runs, dashboard saves report the
-- missing column; /setup without the roast_intensity option keeps working.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists roast_intensity text not null default 'spicy';

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'zb_guild_configs_roast_intensity_check'
          and conrelid = 'public.zb_guild_configs'::regclass
    ) then
        alter table public.zb_guild_configs
            add constraint zb_guild_configs_roast_intensity_check
            check (roast_intensity in ('mild', 'spicy', 'savage'));
    end if;
end $$;
