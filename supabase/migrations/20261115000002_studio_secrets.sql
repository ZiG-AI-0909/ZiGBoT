-- =====================================================================
-- ZiGBoT Studio, Phase 3: encrypted secrets (bot token, later env vars).
-- Values are AES-256-GCM ciphertext (key STUDIO_SECRETS_KEY, server only);
-- only the last 4 characters are kept in clear, to show "configured ✓ …abcd".
-- Browsers get NO access at all (not even their own rows): only the
-- dashboard server, with the service role, after checking the owner.
-- Additive and re-runnable. Rollback: drop table public.studio_secrets;
-- =====================================================================

create table if not exists public.studio_secrets (
    id          bigint generated always as identity primary key,
    project_id  uuid not null references public.studio_projects (id) on delete cascade,
    owner_id    uuid not null references auth.users (id) on delete cascade,
    name        text not null check (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    ciphertext  text not null check (char_length(ciphertext) between 16 and 20000),
    iv          text not null check (iv ~ '^[A-Za-z0-9+/=]{16}$'),
    tag         text not null check (tag ~ '^[A-Za-z0-9+/=]{24}$'),
    last4       text not null check (char_length(last4) <= 4),
    meta        jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object' and pg_column_size(meta) < 4096),
    updated_at  timestamptz not null default now(),
    unique (project_id, name)
);

alter table public.studio_secrets enable row level security;
revoke all on public.studio_secrets from anon;
revoke all on public.studio_secrets from authenticated;
grant all on public.studio_secrets to service_role;
-- Deliberately no policy for authenticated: RLS on + no grant = no access.
