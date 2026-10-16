-- =====================================================================
-- ZiGBoT Premium (per-server Razorpay subscriptions)
--
-- * One row per server: the subscription currently backing that server.
-- * Written ONLY by the service role (dashboard server routes after
--   re-fetching the subscription from Razorpay, or a signature-verified
--   Razorpay webhook). Browsers can never grant themselves Premium.
-- * Verified admins of a server may read that server's row (RLS).
-- * Additive and re-runnable. Also upgrades the earlier PayPal draft of
--   this table in place (its sandbox-only rows are removed: they can never
--   be valid Razorpay subscriptions).
-- =====================================================================

create table if not exists public.zb_guild_subscriptions (
    guild_id            text primary key references public.zb_guilds (guild_id) on delete cascade,
    provider            text not null default 'razorpay',
    subscription_id     text not null unique,
    plan_period         text not null,
    status              text not null,
    current_period_end  timestamptz,
    purchased_by        uuid references auth.users (id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

alter table public.zb_guild_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
-- Checkout started but not paid yet (so a running Premium is not replaced by an unpaid one).
alter table public.zb_guild_subscriptions add column if not exists pending_subscription_id text;

-- Drop the PayPal draft's checks (auto-named) before re-adding the Razorpay ones.
alter table public.zb_guild_subscriptions drop constraint if exists zb_guild_subscriptions_provider_check;
alter table public.zb_guild_subscriptions drop constraint if exists zb_guild_subscriptions_subscription_id_check;
alter table public.zb_guild_subscriptions drop constraint if exists zb_guild_subscriptions_plan_period_check;
alter table public.zb_guild_subscriptions drop constraint if exists zb_guild_subscriptions_status_check;
alter table public.zb_guild_subscriptions drop constraint if exists zb_guild_subscriptions_pending_check;
delete from public.zb_guild_subscriptions where provider <> 'razorpay';
alter table public.zb_guild_subscriptions alter column provider set default 'razorpay';

alter table public.zb_guild_subscriptions
    add constraint zb_guild_subscriptions_provider_check check (provider in ('razorpay')),
    add constraint zb_guild_subscriptions_subscription_id_check check (subscription_id ~ '^sub_[A-Za-z0-9]{8,40}$'),
    add constraint zb_guild_subscriptions_plan_period_check check (plan_period in ('monthly', 'yearly')),
    add constraint zb_guild_subscriptions_status_check check (status in ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired', 'paused')),
    add constraint zb_guild_subscriptions_pending_check check (pending_subscription_id is null or pending_subscription_id ~ '^sub_[A-Za-z0-9]{8,40}$');

alter table public.zb_guild_subscriptions enable row level security;

revoke all on public.zb_guild_subscriptions from anon;
revoke all on public.zb_guild_subscriptions from authenticated;
grant select on public.zb_guild_subscriptions to authenticated;
grant all on public.zb_guild_subscriptions to service_role;

drop policy if exists zb_guild_subscriptions_select_admin on public.zb_guild_subscriptions;
create policy zb_guild_subscriptions_select_admin on public.zb_guild_subscriptions
    for select to authenticated using (public.zb_is_guild_admin(guild_id));
