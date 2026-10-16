/**
 * Message-level helpers that turn a guild config context into decisions:
 * effective settings, channel gating, and the member's resolved behaviour.
 * Role data always comes from the live discord.js member object (trusted
 * gateway data), never from anything a user typed.
 */
const { resolveMemberBehavior, hasFeature } = require('../../dashboard/lib/shared');

/** null in legacy mode => no feature gating (pre-multi-server behaviour). */
function behaviorForMember(ctx, member) {
    if (!ctx || ctx.mode !== 'multi') return null;
    const roles = member?.roles?.cache;
    const roleIds = [];
    const positions = new Map();
    if (roles && typeof roles.values === 'function') {
        for (const role of roles.values()) {
            if (String(role.id) === String(ctx.guildId)) continue; // @everyone
            roleIds.push(String(role.id));
            positions.set(String(role.id), Number(role.position) || 0);
        }
    }
    return resolveMemberBehavior({ config: ctx.config, mappings: ctx.mappings, memberRoleIds: roleIds, rolePositions: positions });
}

/** Blocked channels never get replies; a non-empty allow-list restricts replies to it. Threads inherit from their parent. */
function channelAllowed(config, channel) {
    if (!config || !channel) return true;
    const ids = [String(channel.id), channel.parentId ? String(channel.parentId) : null].filter(Boolean);
    const blocked = config.blocked_channel_ids || [];
    if (ids.some((id) => blocked.includes(id))) return false;
    const allowed = config.allowed_channel_ids || [];
    if (allowed.length > 0 && !ids.some((id) => allowed.includes(id))) return false;
    return true;
}

function isChatChannel(config, channel) {
    if (!config || !channel) return false;
    const ids = [String(channel.id), channel.parentId ? String(channel.parentId) : null].filter(Boolean);
    return ids.some((id) => (config.chat_channel_ids || []).includes(id));
}

/**
 * Effective settings for one guild: global settings overlaid with that
 * guild's own values. Secrets and global values (tokens, model, YouTube) are
 * untouched; per-guild values never leak across guilds because a fresh
 * object is built per event.
 */
function buildGuildSettings(settings, ctx) {
    if (!ctx) return settings;
    const cfg = ctx.config;
    return {
        ...settings,
        chatChannelIds: [...(cfg.chat_channel_ids || [])],
        respondToAllMessages: Boolean(cfg.respond_to_all),
        autoReplyKeywords: Boolean(cfg.auto_reply_keywords),
        cooldownSeconds: Number.isFinite(cfg.cooldown_seconds) ? cfg.cooldown_seconds : settings.cooldownSeconds,
        // In legacy mode the env log channel stays; in multi mode only the
        // guild's own configured log channel is used (auditLog also checks
        // the channel belongs to the same guild).
        logChannelId: ctx.mode === 'multi' ? (cfg.log_channel_id || '') : settings.logChannelId,
        guildContext: ctx
    };
}

function pronounsToGender(pronouns) {
    if (pronouns === 'she/her') return 'female';
    if (pronouns === 'he/him') return 'male';
    return null;
}

module.exports = { behaviorForMember, channelAllowed, isChatChannel, buildGuildSettings, pronounsToGender, hasFeature };
