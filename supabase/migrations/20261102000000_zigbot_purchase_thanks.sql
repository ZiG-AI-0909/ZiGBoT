-- =====================================================================
-- ZiGBoT: "thank you for purchasing" DM after a verified Premium purchase.
-- thanks_claimed_at is set by ONE conditional update before the DM is sent
-- (where it is still null), so the checkout callback and the Razorpay
-- webhook can never both send it. thanks_status records the outcome.
-- Additive and re-runnable.
-- =====================================================================

alter table public.zb_premium_purchases add column if not exists thanks_claimed_at timestamptz;
alter table public.zb_premium_purchases add column if not exists thanks_status text;

alter table public.zb_premium_purchases drop constraint if exists zb_premium_purchases_thanks_status_check;
alter table public.zb_premium_purchases add constraint zb_premium_purchases_thanks_status_check
    check (thanks_status is null or thanks_status in ('sent', 'dm_closed', 'failed', 'no_recipient'));
