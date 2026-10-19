/**
 * Safe default per-server configuration.
 *
 * A brand-new server gets the conservative profile: wholesome tone, replies
 * only when mentioned/replied to, no passive memory capture, admin tools only
 * for the real Discord owner/Administrators. The bot owner's home server is
 * seeded with `legacy_role_rules: true` so it keeps today's env-driven
 * gentle/savage role behaviour exactly.
 */

function defaultGuildConfig({ guildId, legacy = false, legacySettings = null } = {}) {
    const s = legacySettings || {};
    return {
        guild_id: guildId ? String(guildId) : null,
        enabled: true,
        default_tone: legacy ? 'savage' : 'gentle',
        replace_base_persona: false,
        custom_system_prompt: '',
        response_instructions: '',
        server_rules: '',
        language: legacy ? 'English-Hinglish mix' : '',
        response_style: '',
        response_length: 'short',
        respond_to_all: legacy ? Boolean(s.respondToAllMessages) : false,
        auto_reply_keywords: legacy ? Boolean(s.autoReplyKeywords) : false,
        cooldown_seconds: legacy && Number.isFinite(s.cooldownSeconds) ? s.cooldownSeconds : 15,
        allowed_channel_ids: [],
        chat_channel_ids: legacy && Array.isArray(s.chatChannelIds) ? [...s.chatChannelIds] : [],
        blocked_channel_ids: [],
        log_channel_id: legacy && s.logChannelId ? String(s.logChannelId) : null,
        memory_enabled: legacy,
        reputation_enabled: true,
        music_enabled: true,
        voice_enabled: true,
        legacy_role_rules: legacy,
        // Filled in by the bot's /setup command.
        owner_pronouns: null,
        male_role_ids: [],
        female_role_ids: [],
        adult_role_ids: [],
        minor_role_ids: [],
        // Music (dashboard Music tab).
        music_dj_role_ids: [],
        music_channel_id: null,
        music_idle_minutes: 3,
        music_default_volume: 80,
        // Voice chat (dashboard Voice tab).
        voice_speaker: '',
        voice_pace: 100,
        voice_language: 'auto',
        voice_speak_replies: true,
        version: 1
    };
}

module.exports = { defaultGuildConfig };
