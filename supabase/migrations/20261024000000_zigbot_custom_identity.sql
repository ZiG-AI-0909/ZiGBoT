-- =====================================================================
-- ZiGBoT Custom Bot Identity (Premium): a per-server nickname, avatar and
-- bio for the existing bot (Discord "Modify Current Member").
--
-- * zb_guild_identity: one row per server that saved an identity. Servers
--   without a row are never touched by the bot's identity sync.
-- * zb_identity_blocks: servers or Discord users barred from the feature.
-- * Avatars live in the PRIVATE storage bucket zb-identity as processed
--   512x512 PNGs (metadata stripped), at <guild_id>/<sha256>.png.
-- * Written ONLY by the service role (dashboard API routes after a live
--   Manage Server check, and the bot worker). No browser access at all:
--   RLS is on with no policies for anon/authenticated.
-- * Audit: every change is recorded in zb_config_audit_log; this widens
--   its action check with APPLY / REVERT / REVIEW / BLOCK.
-- * Additive and re-runnable. Nothing existing is dropped or rewritten.
-- =====================================================================

create table if not exists public.zb_guild_identity (
    guild_id                text primary key references public.zb_guilds (guild_id) on delete cascade,
    -- What the admins saved (null = keep the ZiGBoT default for that field).
    nick                    text,
    bio                     text,
    -- The approved avatar (applied when the server is Premium and not blocked).
    avatar_path             text,
    avatar_sha256           text,
    -- An uploaded avatar waiting for the bot owner's review (never applied).
    pending_avatar_path     text,
    pending_avatar_sha256   text,
    pending_submitted_at    timestamptz,
    pending_submitted_by    text,
    review_note             text,
    -- What was last sent to Discord, so the sync only sends real changes.
    applied_nick            text,
    applied_bio             text,
    applied_avatar_sha256   text,
    applied_at              timestamptz,
    reverted_at             timestamptz,
    revert_reason           text,
    updated_by              uuid references auth.users (id) on delete set null,
    updated_by_discord_id   text,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    constraint zb_guild_identity_nick_check check (nick is null or char_length(nick) between 1 and 32),
    constraint zb_guild_identity_bio_check check (bio is null or char_length(bio) between 1 and 190),
    -- A picture is both columns or neither, and always <this guild>/<sha256>.png.
    -- (coalesce: a NULL check result would otherwise pass.)
    constraint zb_guild_identity_avatar_check check (
        (avatar_path is null and avatar_sha256 is null)
        or coalesce(avatar_sha256 ~ '^[0-9a-f]{64}$' and avatar_path = guild_id || '/' || avatar_sha256 || '.png', false)
    ),
    constraint zb_guild_identity_pending_check check (
        (pending_avatar_path is null and pending_avatar_sha256 is null)
        or coalesce(pending_avatar_sha256 ~ '^[0-9a-f]{64}$' and pending_avatar_path = guild_id || '/' || pending_avatar_sha256 || '.png', false)
    ),
    constraint zb_guild_identity_applied_check check (applied_avatar_sha256 is null or applied_avatar_sha256 ~ '^[0-9a-f]{64}$'),
    constraint zb_guild_identity_review_note_check check (review_note is null or char_length(review_note) <= 300)
);
create index if not exists zb_guild_identity_pending_idx on public.zb_guild_identity (pending_submitted_at) where pending_avatar_path is not null;

create table if not exists public.zb_identity_blocks (
    id                      bigint generated always as identity primary key,
    kind                    text not null check (kind in ('guild', 'user')),
    target_id               text not null check (target_id ~ '^\d{17,20}$'),
    reason                  text check (reason is null or char_length(reason) <= 300),
    -- The server the block was made from (audit entries are filed under it).
    context_guild_id        text not null check (context_guild_id ~ '^\d{17,20}$'),
    created_by_discord_id   text,
    created_at              timestamptz not null default now(),
    unique (kind, target_id)
);

-- Audit actions for identity events (the original check is auto-named).
alter table public.zb_config_audit_log drop constraint if exists zb_config_audit_log_action_check;
alter table public.zb_config_audit_log add constraint zb_config_audit_log_action_check
    check (action in ('INSERT', 'UPDATE', 'DELETE', 'RESET', 'INSTALL', 'UNINSTALL', 'APPLY', 'REVERT', 'REVIEW', 'BLOCK'));

alter table public.zb_guild_identity enable row level security;
alter table public.zb_identity_blocks enable row level security;
revoke all on public.zb_guild_identity, public.zb_identity_blocks from anon;
revoke all on public.zb_guild_identity, public.zb_identity_blocks from authenticated;
grant all on public.zb_guild_identity, public.zb_identity_blocks to service_role;

-- Private bucket: PNG only, 1 MB per file. No storage policies, so only the
-- service role can read or write it. (Skipped where Supabase Storage is absent.)
do $$
begin
    if to_regclass('storage.buckets') is not null then
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values ('zb-identity', 'zb-identity', false, 1048576, array['image/png'])
        on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/png'];
    end if;
end $$;
