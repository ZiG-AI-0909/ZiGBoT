/**
 * Validates a Discord bot token server-side with ONE call: GET /users/@me
 * (no other Discord endpoint is touched, nothing is changed). The token is
 * never logged and never part of a returned value or error message.
 */
const { DISCORD_TOKEN } = require('./secrets');

async function checkBotToken(token, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || !DISCORD_TOKEN.test(token.trim())) return { ok: false, reason: 'That does not look like a bot token (three parts separated by dots).' };
    let res;
    try {
        res = await fetchImpl('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${token.trim()}`, 'User-Agent': 'DiscordBot (https://www.zigbot.in, 1.0)' },
            signal: AbortSignal.timeout(8000)
        });
    } catch {
        return { ok: false, reason: 'Could not reach Discord. Try again in a moment.', retry: true };
    }
    if (res.status === 401) return { ok: false, reason: 'Discord says this token is not valid (it may have been reset).' };
    if (res.status === 429) return { ok: false, reason: 'Discord is rate-limiting checks. Wait a minute and try again.', retry: true };
    if (!res.ok) return { ok: false, reason: `Discord answered ${res.status}. Try again later.`, retry: true };
    const user = await res.json().catch(() => null);
    if (!user?.id || user.bot !== true) return { ok: false, reason: 'That token belongs to a user account, not a bot. Use the token from Developer Portal → Bot.' };
    return { ok: true, bot: { id: String(user.id), username: String(user.username || '').slice(0, 64) } };
}

module.exports = { checkBotToken };
