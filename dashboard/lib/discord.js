import 'server-only';
import { env } from './env';

/**
 * Minimal Discord REST client. Uses the BOT token server-side to read
 * trusted data (guild roles/owner, a member's roles, channels). Browser input
 * is never used as a source of truth for permissions.
 */
const API = 'https://discord.com/api/v10';

export class DiscordError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function call(path, { token, bearer = false, retries = 1 } = {}) {
    const response = await fetch(`${API}${path}`, {
        headers: { Authorization: bearer ? `Bearer ${token}` : `Bot ${token}` },
        cache: 'no-store'
    });
    if (response.status === 429 && retries > 0) {
        const body = await response.json().catch(() => ({}));
        const waitMs = Math.min(5000, Math.ceil((Number(body.retry_after) || 1) * 1000));
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return call(path, { token, bearer, retries: retries - 1 });
    }
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) throw new DiscordError(`Discord API ${response.status} on ${path.split('?')[0]}`, response.status);
    return response.json();
}

const botToken = () => env.discordBotToken;
const SNOWFLAKE = /^\d{17,20}$/;
const assertId = (id) => {
    if (!SNOWFLAKE.test(String(id))) throw new DiscordError('Invalid Discord id', 400);
    return String(id);
};

/** Guild incl. roles + owner_id. null when the bot is not in the guild. */
export function getGuild(guildId) {
    return call(`/guilds/${assertId(guildId)}`, { token: botToken() });
}

/** Member (roles array). null when the user is not in the guild. */
export function getMember(guildId, userId) {
    return call(`/guilds/${assertId(guildId)}/members/${assertId(userId)}`, { token: botToken() });
}

export async function getChannels(guildId) {
    return (await call(`/guilds/${assertId(guildId)}/channels`, { token: botToken() })) || [];
}

/** The logged-in user's guilds, via their own OAuth access token (scope "guilds"). */
export async function getUserGuilds(accessToken) {
    if (!accessToken) return null;
    return call('/users/@me/guilds', { token: accessToken, bearer: true });
}

// Text-like channel types the bot can talk in: text, announcement, forum, voice-text, stage-text.
const TEXT_TYPES = new Set([0, 5, 15, 2, 13]);
export function textChannels(channels) {
    return (channels || [])
        .filter((channel) => TEXT_TYPES.has(channel.type))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((channel) => ({ id: String(channel.id), name: channel.name, type: channel.type, parent_id: channel.parent_id || null }));
}

export function assignableRoles(guild) {
    return (guild?.roles || [])
        .filter((role) => String(role.id) !== String(guild.id) && !role.managed)
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: String(role.id), name: role.name, color: role.color, position: role.position }));
}

// View Channel, Send Messages, Embed Links, Read History, Add Reactions,
// Connect, Speak, Manage Messages, Kick, Ban, Manage Channels, Manage Roles,
// Moderate Members — exactly what ZiGBoT's tools use, never Administrator.
const INVITE_PERMISSIONS = [10n, 11n, 14n, 16n, 6n, 20n, 21n, 13n, 1n, 2n, 4n, 28n, 40n]
    .reduce((acc, bit) => acc | (1n << bit), 0n)
    .toString();

export function inviteUrl(guildId) {
    const params = new URLSearchParams({
        client_id: env.discordClientId,
        scope: 'bot applications.commands',
        permissions: INVITE_PERMISSIONS
    });
    if (guildId && SNOWFLAKE.test(String(guildId))) {
        params.set('guild_id', String(guildId));
        params.set('disable_guild_select', 'true');
    }
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Link to the bot creator's Discord profile (Message button), or null if unset. */
export function contactUrl() {
    const id = env.botCreatorId;
    return SNOWFLAKE.test(String(id || '')) ? `https://discord.com/users/${id}` : null;
}

export function guildIconUrl(guildId, icon) {
    return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=96` : null;
}
