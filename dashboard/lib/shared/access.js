/**
 * Pure access decisions for the dashboard backend (unit-tested).
 * Inputs must be TRUSTED: the Supabase-verified user object and Discord data
 * fetched server-side with the bot token.
 */
const { computeBasePermissions, canManageGuild } = require('./permissions');

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Discord user id of a Supabase user. Reads ONLY `identities` (written by
 * Supabase Auth during the Discord OAuth exchange). `user_metadata` is
 * deliberately ignored: users can edit it with auth.updateUser(), so it
 * could be used to impersonate another Discord account.
 */
function discordIdFromUser(user) {
    const identity = (user?.identities || []).find((i) => i?.provider === 'discord');
    if (!identity) return null;
    const candidates = [identity.identity_data?.provider_id, identity.identity_data?.sub, identity.id];
    const id = candidates.map((v) => (v === undefined || v === null ? '' : String(v))).find((v) => SNOWFLAKE.test(v));
    return id || null;
}

function decideGuildAccess({ guild, member, discordUserId }) {
    if (!SNOWFLAKE.test(String(discordUserId || ''))) {
        return { allowed: false, status: 401, code: 'no_discord_identity', reason: 'Your login has no verified Discord identity. Sign in with Discord again.' };
    }
    if (!guild) {
        return { allowed: false, status: 404, code: 'bot_not_installed', reason: 'ZiGBoT is not in this server (or the server does not exist).' };
    }
    if (!member) {
        return { allowed: false, status: 403, code: 'not_member', reason: 'You are not a member of this server.' };
    }
    if (String(member.user?.id) !== String(discordUserId)) {
        return { allowed: false, status: 403, code: 'identity_mismatch', reason: 'Discord identity mismatch.' };
    }
    const permissions = computeBasePermissions(guild, member);
    if (!canManageGuild(permissions)) {
        return { allowed: false, status: 403, code: 'missing_permission', reason: 'You need the Manage Server or Administrator permission in this server.' };
    }
    return {
        allowed: true,
        status: 200,
        code: 'ok',
        isOwner: String(guild.owner_id) === String(discordUserId),
        permissions: permissions.toString()
    };
}

/** Same-origin check for state-changing requests (CSRF defence in depth). */
function isSameOrigin({ origin, host, allowedOrigins = [] }) {
    if (!origin) return false;
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    if (allowedOrigins.map((o) => String(o).replace(/\/+$/, '')).includes(parsed.origin)) return true;
    return Boolean(host) && parsed.host === host;
}

module.exports = { discordIdFromUser, decideGuildAccess, isSameOrigin };
