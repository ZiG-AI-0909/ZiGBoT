-- =====================================================================
-- Platform Phase 7: AI coding agents (owner's own API keys).
-- studio_agent_keys   per user + provider, AES-256-GCM sealed by the
--                     server (STUDIO_SECRETS_KEY); no browser access at all.
-- studio_agent_runs   usage tracking: provider, model, status, tokens, time.
-- studio_ai_proposals gains agent + model, so agent results use the same
--                     review-and-approve flow as the AI creator.
-- Additive and re-runnable.
-- Rollback: drop table public.studio_agent_runs; drop table public.studio_agent_keys;
--           alter table public.studio_ai_proposals drop column agent, drop column model;
-- =====================================================================

create table if not exists public.studio_agent_keys (
    owner_id    uuid not null references auth.users (id) on delete cascade,
    provider    text not null check (provider in ('anthropic', 'openai')),
    ciphertext  text not null,
    iv          text not null,
    tag         text not null,
    last4       text not null check (char_length(last4) = 4),
    model       text check (char_length(model) <= 64),
    updated_at  timestamptz not null default now(),
    primary key (owner_id, provider)
);
alter table public.studio_agent_keys enable row level security;
revoke all on public.studio_agent_keys from anon, authenticated;
grant all on public.studio_agent_keys to service_role;

create table if not exists public.studio_agent_runs (
    id             bigint generated always as identity primary key,
    owner_id       uuid not null references auth.users (id) on delete cascade,
    project_id     uuid references public.studio_projects (id) on delete set null,
    provider       text not null check (provider in ('anthropic', 'openai')),
    model          text not null check (char_length(model) <= 64),
    status         text not null default 'running' check (status in ('running', 'done', 'failed', 'cancelled')),
    error          text check (char_length(error) <= 300),
    input_tokens   integer not null default 0,
    output_tokens  integer not null default 0,
    duration_ms    integer,
    proposal_id    uuid references public.studio_ai_proposals (id) on delete set null,
    created_at     timestamptz not null default now()
);
create index if not exists studio_agent_runs_owner_idx on public.studio_agent_runs (owner_id, created_at desc);
alter table public.studio_agent_runs enable row level security;
revoke all on public.studio_agent_runs from anon, authenticated;
grant select on public.studio_agent_runs to authenticated;
grant all on public.studio_agent_runs to service_role;
drop policy if exists studio_agent_runs_select_own on public.studio_agent_runs;
create policy studio_agent_runs_select_own on public.studio_agent_runs for select to authenticated using (owner_id = auth.uid());

alter table public.studio_ai_proposals add column if not exists agent text check (agent in ('anthropic', 'openai'));
alter table public.studio_ai_proposals add column if not exists model text check (char_length(model) <= 64);
