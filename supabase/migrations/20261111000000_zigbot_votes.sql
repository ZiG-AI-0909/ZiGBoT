-- =====================================================================
-- ZiGBoT bot-list votes (/admin/installs). One row per upvote, sent by
-- discordbotlist.com's vote webhook to /api/votes/discordbotlist (checked
-- against DBL_WEBHOOK_SECRET). Server-side only: browsers get no access.
-- Additive and re-runnable.
-- =====================================================================

create table if not exists public.zb_votes (
    id                bigint generated always as identity primary key,
    site              text not null default 'discordbotlist' check (site in ('discordbotlist')),
    user_discord_id   text not null check (user_discord_id ~ '^\d{17,20}$'),
    user_name         text check (user_name is null or char_length(user_name) <= 100),
    voted_at          timestamptz not null default now()
);
create index if not exists zb_votes_voted_idx on public.zb_votes (voted_at desc);

alter table public.zb_votes enable row level security;
revoke all on public.zb_votes from anon;
revoke all on public.zb_votes from authenticated;
grant select, insert on public.zb_votes to service_role;
