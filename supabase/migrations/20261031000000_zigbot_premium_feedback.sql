-- =====================================================================
-- ZiGBoT Premium purchases + first-purchase feedback.
--
-- zb_premium_purchases: one row per Razorpay subscription that Razorpay
--   itself reported as ACTIVE (paid), written by the dashboard's billing
--   sync (checkout verify or signed webhook). Renewals are not new
--   purchases. A user's first-ever purchase is flagged once, enforced by a
--   unique index, so an upgrade (a second subscription) never counts as a
--   first purchase. No card or payment details are stored.
-- zb_premium_feedback: at most one response per purchase (unique), only
--   for the buyer's first purchase. review_status / archived_at /
--   admin_note are for the owner's admin view and never shown to customers.
-- Only the service role can read or write either table. Additive, re-runnable.
-- =====================================================================

create table if not exists public.zb_premium_purchases (
    id                     uuid primary key default gen_random_uuid(),
    subscription_id        text not null unique check (subscription_id ~ '^sub_[A-Za-z0-9]{8,40}$'),
    guild_id               text not null check (guild_id ~ '^\d{17,20}$'),
    user_id                uuid references auth.users (id) on delete set null,
    discord_user_id        text check (discord_user_id is null or discord_user_id ~ '^\d{17,20}$'),
    plan_period            text not null check (plan_period in ('monthly', 'yearly')),
    -- Verified from the Razorpay plan (paise); null if Razorpay could not be asked.
    amount_paise           integer check (amount_paise is null or amount_paise >= 0),
    currency               text check (currency is null or currency ~ '^[A-Z]{3}$'),
    is_first_purchase      boolean not null default false,
    feedback_state         text not null default 'not_offered' check (feedback_state in ('not_offered', 'pending', 'submitted')),
    feedback_remind_after  timestamptz,
    verified_at            timestamptz not null default now(),
    created_at             timestamptz not null default now()
);
create unique index if not exists zb_premium_purchases_first_idx on public.zb_premium_purchases (user_id) where is_first_purchase;
create index if not exists zb_premium_purchases_user_idx on public.zb_premium_purchases (user_id, verified_at desc);
create index if not exists zb_premium_purchases_verified_idx on public.zb_premium_purchases (verified_at desc);

create table if not exists public.zb_premium_feedback (
    id                  uuid primary key default gen_random_uuid(),
    purchase_id         uuid not null unique references public.zb_premium_purchases (id) on delete cascade,
    user_id             uuid references auth.users (id) on delete set null,
    discord_user_id     text check (discord_user_id is null or discord_user_id ~ '^\d{17,20}$'),
    plan_period         text not null check (plan_period in ('monthly', 'yearly')),
    amount_paise        integer check (amount_paise is null or amount_paise >= 0),
    currency            text check (currency is null or currency ~ '^[A-Z]{3}$'),
    overall_rating      smallint not null check (overall_rating between 1 and 5),
    purchase_reasons    text[] not null default '{}' check (cardinality(purchase_reasons) <= 10),
    valuable_features   text[] not null default '{}' check (cardinality(valuable_features) <= 10),
    activation_ease     smallint not null check (activation_ease between 1 and 5),
    value_for_money     text not null check (value_for_money in ('excellent', 'good', 'fair', 'too_expensive', 'need_time')),
    missing_features    text check (missing_features is null or char_length(missing_features) <= 2000),
    issues              text[] not null default '{}' check (cardinality(issues) <= 10),
    issue_details       text check (issue_details is null or char_length(issue_details) <= 2000),
    recommend_score     smallint not null check (recommend_score between 0 and 10),
    comments            text check (comments is null or char_length(comments) <= 2000),
    plan_answers        jsonb not null default '{}'::jsonb check (jsonb_typeof(plan_answers) = 'object'),
    -- Owner-only review fields (never shown to the customer; answers above are never edited).
    review_status       text not null default 'new' check (review_status in ('new', 'reviewed')),
    reviewed_at         timestamptz,
    archived_at         timestamptz,
    admin_note          text check (admin_note is null or char_length(admin_note) <= 2000),
    submitted_at        timestamptz not null default now()
);
create index if not exists zb_premium_feedback_submitted_idx on public.zb_premium_feedback (submitted_at desc);
create index if not exists zb_premium_feedback_plan_idx on public.zb_premium_feedback (plan_period, submitted_at desc);

alter table public.zb_premium_purchases enable row level security;
alter table public.zb_premium_feedback enable row level security;
revoke all on public.zb_premium_purchases, public.zb_premium_feedback from anon;
revoke all on public.zb_premium_purchases, public.zb_premium_feedback from authenticated;
grant all on public.zb_premium_purchases, public.zb_premium_feedback to service_role;
