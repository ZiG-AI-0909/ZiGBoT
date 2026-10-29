-- =====================================================================
-- ZiGBoT Super Admin audit log (/admin). Append-only: a trigger refuses
-- every UPDATE and DELETE, even from the service role, so recorded admin
-- actions cannot be rewritten through any API. Browsers get no access.
-- Admin identity itself is NOT stored in the database (it is server-side
-- configuration: SUPER_ADMIN_DISCORD_IDS), so no row can grant admin.
-- Additive and re-runnable.
-- =====================================================================

create table if not exists public.zb_admin_audit_log (
    id                bigint generated always as identity primary key,
    admin_user_id     uuid,
    admin_discord_id  text check (admin_discord_id is null or admin_discord_id ~ '^\d{17,20}$'),
    action            text not null check (char_length(action) between 1 and 60),
    target_type       text check (target_type is null or char_length(target_type) <= 40),
    target_id         text check (target_id is null or char_length(target_id) <= 100),
    outcome           text not null default 'ok' check (char_length(outcome) <= 20),
    metadata          jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    created_at        timestamptz not null default now()
);
create index if not exists zb_admin_audit_log_created_idx on public.zb_admin_audit_log (created_at desc);

create or replace function public.zb_admin_audit_append_only()
returns trigger
language plpgsql
as $$
begin
    raise exception 'zb_admin_audit_log is append-only';
end;
$$;

drop trigger if exists zb_admin_audit_log_append_only on public.zb_admin_audit_log;
create trigger zb_admin_audit_log_append_only
    before update or delete on public.zb_admin_audit_log
    for each row execute function public.zb_admin_audit_append_only();

alter table public.zb_admin_audit_log enable row level security;
revoke all on public.zb_admin_audit_log from anon;
revoke all on public.zb_admin_audit_log from authenticated;
-- Supabase's default privileges grant everything; take back what could rewrite
-- history (TRUNCATE skips row triggers, so it is revoked too).
revoke update, delete, truncate on public.zb_admin_audit_log from service_role;
grant select, insert on public.zb_admin_audit_log to service_role;
