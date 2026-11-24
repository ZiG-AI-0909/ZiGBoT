-- Enforce one active ticket per opener across all categories in a guild.
-- Closed tickets remain available for transcript and rating history.
drop index if exists public.zb_tickets_one_open_per_category;

create unique index if not exists zb_tickets_one_open_per_user
    on public.zb_tickets (guild_id, opener_id)
    where status in ('open', 'closing');
