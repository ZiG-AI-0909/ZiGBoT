alter table public.zb_guild_configs
    add column if not exists warning_escalation_enabled boolean not null default false,
    add column if not exists temporary_bans_enabled boolean not null default false,
    add column if not exists moderation_spam_filter_enabled boolean not null default false,
    add column if not exists moderation_caps_filter_enabled boolean not null default false,
    add column if not exists moderation_mentions_filter_enabled boolean not null default false,
    add column if not exists moderation_invites_filter_enabled boolean not null default false,
    add column if not exists moderation_word_filter_enabled boolean not null default false,
    add column if not exists moderation_filtered_words text not null default '',
    add column if not exists moderation_appeals_enabled boolean not null default false;
