alter table public.zb_guild_configs
    add column if not exists utility_commands jsonb not null default '[]'::jsonb;

alter table public.zb_guild_configs
    drop constraint if exists zb_guild_configs_utility_commands_check;

alter table public.zb_guild_configs
    add constraint zb_guild_configs_utility_commands_check
    check (case
        when jsonb_typeof(utility_commands) = 'array'
            then jsonb_array_length(utility_commands) <= 20
        else false
    end);
