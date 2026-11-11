/**
 * Avatar viewer on normal messages (no slash command): "av @user",
 * "@ZiGBoT show pfp @user", "server avatar @user", "my pfp".
 *
 * handle() returns true when the message was an avatar request (answered,
 * or skipped as a duplicate or by the cooldown), so the caller stops and the
 * AI does not answer it as well. Users come from the message's own
 * resolved mentions (Discord validated the ids), with an API fetch as a
 * fallback; discord.js queues requests under Discord's rate limits.
 * Nothing here throws.
 */
const av = require('./avatar');

function createAvatarHandler({ botId: botIdOption, fetchUser, now = Date.now, logger = console }) {
    const currentBotId = () => (typeof botIdOption === 'function' ? botIdOption() : botIdOption);
    const seen = new Set(); // message ids already answered (duplicate events)
    const lastByUser = new Map(); // author id -> last answer time
    const fail = (what, error) => logger.error(`[ZiGBoT AVATAR] ${what} failed: ${error?.code || error?.message || error}`);

    async function reply(message, payload) {
        try {
            await message.reply({ allowedMentions: { parse: [], repliedUser: false }, ...payload });
        } catch (error) {
            fail('reply', error);
        }
    }

    async function resolveUser(message, id) {
        if (String(id) === String(message.author.id)) return message.author;
        const mentioned = message.mentions?.users?.get?.(id);
        if (mentioned) return mentioned;
        try {
            return (await fetchUser(id)) || null;
        } catch {
            return null;
        }
    }

    async function resolveMember(message, id) {
        if (!message.guild) return null;
        if (String(id) === String(message.author.id) && message.member) return message.member;
        const mentioned = message.mentions?.members?.get?.(id);
        if (mentioned) return mentioned;
        try {
            return (await message.guild.members.fetch(id)) || null;
        } catch {
            return null; // not in this server: global avatar only
        }
    }

    async function handle(message) {
        const botId = currentBotId();
        if (!message?.author || message.author.bot || message.webhookId || message.system) return false;
        if (botId && String(message.author.id) === String(botId)) return false;

        const request = av.detectAvatarRequest({ content: message.content, botId, authorId: message.author.id });
        if (!request) return false;

        if (message.id && seen.has(message.id)) return true;
        const t = now();
        const last = lastByUser.get(message.author.id);
        if (last !== undefined && t - last < av.COOLDOWN_MS) return true;
        if (message.id) {
            seen.add(message.id);
            if (seen.size > 500) seen.delete(seen.values().next().value);
        }
        lastByUser.set(message.author.id, t);
        if (lastByUser.size > 1000) for (const [id, at] of lastByUser) if (t - at >= av.COOLDOWN_MS) lastByUser.delete(id);

        if (request.askWho) {
            await reply(message, { content: av.ASK_WHO });
            return true;
        }

        const entries = [];
        let invalidCount = 0;
        for (const id of request.targets) {
            const user = await resolveUser(message, id);
            if (!user?.id) {
                invalidCount += 1;
                continue;
            }
            const member = await resolveMember(message, id);
            entries.push({ user, member, global: av.avatarUrls(user), server: member ? av.avatarUrls(member, { member: true }) : null });
        }
        if (entries.length === 0) {
            await reply(message, { content: av.NOT_FOUND });
            return true;
        }
        await reply(message, av.buildAvatarReply(entries, { serverRequested: request.serverRequested, truncated: Boolean(request.truncated), invalidCount }));
        return true;
    }

    return { handle };
}

module.exports = { createAvatarHandler };
