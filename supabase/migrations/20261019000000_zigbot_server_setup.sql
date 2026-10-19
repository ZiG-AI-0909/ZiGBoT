-- =====================================================================
-- ZiGBoT /setup: who the server owner is and which roles mean what.
--
-- * owner_pronouns: the server owner's pronouns (the bot cannot know them).
-- * male/female_role_ids: roles that mean he/him and she/her.
-- * adult_role_ids: 18+ members (roast mode).
-- * minor_role_ids: under-18 members (always gentle, clean, never roasted;
--   this wins over every other role and setting).
-- * Language stays in the existing `language` column ("English" or "Hinglish").
-- Written by the bot's /setup command (service role). Additive and re-runnable.
-- =====================================================================

alter table public.zb_guild_configs add column if not exists owner_pronouns text;
alter table public.zb_guild_configs add column if not exists male_role_ids text[] not null default '{}';
alter table public.zb_guild_configs add column if not exists female_role_ids text[] not null default '{}';
alter table public.zb_guild_configs add column if not exists adult_role_ids text[] not null default '{}';
alter table public.zb_guild_configs add column if not exists minor_role_ids text[] not null default '{}';

alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_owner_pronouns_check;
alter table public.zb_guild_configs drop constraint if exists zb_guild_configs_setup_roles_check;
alter table public.zb_guild_configs
    add constraint zb_guild_configs_owner_pronouns_check
        check (owner_pronouns is null or owner_pronouns in ('she/her', 'he/him', 'they/them')),
    add constraint zb_guild_configs_setup_roles_check
        check (cardinality(male_role_ids) <= 10 and cardinality(female_role_ids) <= 10
           and cardinality(adult_role_ids) <= 10 and cardinality(minor_role_ids) <= 10);
