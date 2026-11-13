/**
 * Shared helpers for the optional features (src/features/*): settings lookup,
 * permission and role-hierarchy checks, safe text, private replies and the
 * existing audit log.
 */
const { PermissionFlagsBits } = require('discord.js');
const { defaultFeatureSettings } = require('../../dashboard/lib/shared');

const NO_PINGS = Object.freeze({ parse: [], repliedUser: false });

// Roles that must never be handed out by a self-service panel or automation.
const ELEVATED = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.MentionEveryone, PermissionFlagsBits.ManageNicknames
];

/** One section of a guild's feature settings (defaults = everything off). */
function sectionOf(config, name) {
    return config?.feature_settings?.[name] || defaultFeatureSettings()[name];
}

const safeText = (text, max = 1000) => String(text ?? '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@&(\d+)>/g, '<@​&$1>')
    .slice(0, max);

function has(permissions, flag) {
    try {
        return Boolean(permissions?.has?.(flag));
    } catch {
        return false;
    }
}

const botCan = (guild, flag) => has(guild?.members?.me?.permissions, flag);
const memberCan = (member, flag) => has(member?.permissions, flag);

/**
 * Why the bot must not give/take this role, or null when it may: the role
 * exists, is not @everyone or managed, carries no staff permission, is below
 * the bot's highest role, and the bot has Manage Roles.
 */
function roleProblem(guild, role) {
    if (!role) return 'That role no longer exists.';
    if (String(role.id) === String(guild.id)) return '@everyone cannot be assigned.';
    if (role.managed) return 'That role is managed by an integration.';
    if (ELEVATED.some((flag) => has(role.permissions, flag))) return 'That role has staff permissions, so it cannot be self-assigned.';
    if (!botCan(guild, PermissionFlagsBits.ManageRoles)) return 'I need the Manage Roles permission.';
    const top = guild.members?.me?.roles?.highest?.position;
    if (!Number.isFinite(top) || role.position >= top) return 'That role is above my highest role.';
    return null;
}

/** Discord's rule for the person asking: only the owner may act on roles at or above their own. */
function requesterOutranks(guild, member, role) {
    if (guild.ownerId && guild.ownerId === member?.id) return true;
    const own = member?.roles?.highest?.position;
    return Number.isFinite(own) && role.position < own;
}

async function reply(interaction, content, extra = {}) {
    const payload = { ...(typeof content === 'string' ? { content } : content), allowedMentions: NO_PINGS, ...extra };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply({ ...payload, ephemeral: true });
}

/** Writes to the existing audit log (src/logging/auditLog.js). Never throws. */
function makeAudit({ auditLog, logger = console, event }) {
    return async function audit(source, settings, { action, target = null, result = 'SUCCESS', details = {} }) {
        try {
            const guild = source.guild || null;
            const userId = source.user?.id || source.author?.id || source.id || 'system';
            await auditLog({
                message: { author: { id: userId }, guild, client: source.client || guild?.client },
                settings: settings || {},
                event,
                action,
                target,
                result,
                details: { guild_id: guild?.id || 'none', ...details }
            });
        } catch (error) {
            logger.error?.(`[ZiGBoT ${event}] Audit write failed: ${error?.message || error}`);
        }
    };
}

module.exports = { NO_PINGS, ELEVATED, sectionOf, safeText, botCan, memberCan, roleProblem, requesterOutranks, reply, makeAudit };
