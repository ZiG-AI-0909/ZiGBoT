alter table public.zb_guild_configs
    add column if not exists ticketing_enabled boolean not null default false,
    add column if not exists ticket_category_ids text[] not null default '{}',
    add column if not exists ticket_staff_role_ids text[] not null default '{}',
    add column if not exists ticket_senior_role_id text,
    add column if not exists ticket_log_channel_id text;

alter table public.zb_guild_configs
    drop constraint if exists zb_guild_configs_ticket_settings_check,
    drop constraint if exists zb_guild_configs_ticket_senior_role_id_check,
    drop constraint if exists zb_guild_configs_ticket_log_channel_id_check;

alter table public.zb_guild_configs
    add constraint zb_guild_configs_ticket_settings_check
        check (
            cardinality(ticket_category_ids) <= 10
            and cardinality(ticket_staff_role_ids) <= 10
            and (not ticketing_enabled or (
                cardinality(ticket_category_ids) > 0
                and cardinality(ticket_staff_role_ids) > 0
                and ticket_log_channel_id is not null
            ))
        ),
    add constraint zb_guild_configs_ticket_senior_role_id_check
        check (ticket_senior_role_id is null or ticket_senior_role_id ~ '^\d{17,20}$'),
    add constraint zb_guild_configs_ticket_log_channel_id_check
        check (ticket_log_channel_id is null or ticket_log_channel_id ~ '^\d{17,20}$');

create table if not exists public.zb_tickets (
    id                  uuid primary key default gen_random_uuid(),
    guild_id            text not null check (guild_id ~ '^\d{17,20}$'),
    channel_id          text not null unique check (channel_id ~ '^\d{17,20}$'),
    opener_id           text not null check (opener_id ~ '^\d{17,20}$'),
    category_id         text not null check (category_id ~ '^\d{17,20}$'),
    status              text not null default 'open' check (status in ('open', 'closing', 'closed')),
    priority            text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
    claimed_by          text check (claimed_by is null or claimed_by ~ '^\d{17,20}$'),
    participants        text[] not null default '{}',
    classification      text check (classification is null or char_length(classification) <= 40),
    summary             text check (summary is null or char_length(summary) <= 2000),
    suggested_reply     text check (suggested_reply is null or char_length(suggested_reply) <= 1000),
    rating              smallint check (rating is null or rating between 1 and 5),
    created_at          timestamptz not null default now(),
    closed_at           timestamptz,
    rated_at            timestamptz,
    check (cardinality(participants) <= 20)
);

create unique index if not exists zb_tickets_one_open_per_category
    on public.zb_tickets (guild_id, opener_id, category_id)
    where status in ('open', 'closing');
create index if not exists zb_tickets_guild_status_created
    on public.zb_tickets (guild_id, status, created_at desc);

alter table public.zb_tickets enable row level security;
revoke all on public.zb_tickets from anon, authenticated;
grant all on public.zb_tickets to service_role;
