/**
 * The automatic AFK workflow, run on every server message:
 *   "afk <reason>"      -> save, optional "[AFK]" nickname, AFK ALERT card
 *   mention of AFK user -> AFK NOTIFICATION card (cooldown, max 3 per message)
 *   AFK user's next msg -> remove, restore nickname, WELCOME BACK card
 *
 * handle() returns { handled: true } only for the "afk" command itself (the
 * caller then stops); every other message continues to the normal bot flow.
 * Nothing here throws: Discord or database failures are logged.
 */
const { PermissionFlagsBits } = require('discord.js');
const afk = require('./afk');

// botId: the bot's user id, or a function returning it (it is only known after login).
function createAfkHandler({ store, botId: botIdOption, now = Date.now, logger = console }) {
    const currentBotId = () => (typeof botIdOption === 'function' ? botIdOption() : botIdOption);
    const cooldowns = new Map(); // `${channelId}:${afkUserId}` -> last notification time
    const fail = (what, error) => logger.error(`[ZiGBoT AFK] ${what} failed: ${error?.code || error?.message || error}`);

    async function send(message, payload) {
        try {
            await message.channel.send(payload);
        } catch (error) {
            fail('send', error);
        }
    }

    // Only when allowed: not the server owner (Discord forbids it), ZiGBoT's
    // role is above theirs, and ZiGBoT has Manage Nicknames.
    async function applyNickname(message) {
        const member = message.member;
        const originalNick = member?.nickname ?? null;
        const canChange = member
            && member.id !== message.guild.ownerId
            && member.manageable
            && message.guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames);
        if (!canChange) return { originalNick, afkNick: null };
        const target = afk.afkNickname(member.displayName);
        if (target === member.displayName) return { originalNick, afkNick: null };
        try {
            await member.setNickname(target, 'AFK');
            return { originalNick, afkNick: target };
        } catch (error) {
            fail('nickname', error);
            return { originalNick, afkNick: null };
        }
    }

    // Put the old nickname back, but only if it is still the one ZiGBoT set.
    async function restoreNickname(member, record) {
        if (!record.afkNick || !member || member.nickname !== record.afkNick) return;
        try {
            await member.setNickname(record.originalNick ?? null, 'Back from AFK');
        } catch (error) {
            fail('nickname restore', error);
        }
    }

    function pruneCooldowns(t) {
        if (cooldowns.size < 1000) return;
        for (const [k, last] of cooldowns) if (t - last >= afk.NOTIFY_COOLDOWN_MS) cooldowns.delete(k);
    }

    async function handle(message) {
        if (!message?.guild || !message.author || message.author.bot || message.system || message.webhookId) return { handled: false };
        const botId = currentBotId();
        const guildId = message.guild.id;
        const userId = message.author.id;
        const current = store.get(guildId, userId);

        const command = afk.parseAfkCommand(message.content, botId);
        if (command) {
            const reason = afk.cleanReason(command.reason);
            if (current) {
                // Already AFK: new reason, same start time, same nickname.
                await store.set({ ...current, reason });
                await send(message, afk.alertMessage({ userId, reason, since: current.since }));
                return { handled: true };
            }
            const since = now();
            const nick = await applyNickname(message);
            await store.set({ guildId, userId, reason, since, ...nick });
            await send(message, afk.alertMessage({ userId, reason, since }));
            return { handled: true };
        }

        // Any other message from an AFK user: they are back.
        if (current) {
            await store.remove(guildId, userId);
            await restoreNickname(message.member, current);
            await send(message, afk.welcomeBackMessage({ userId, reason: current.reason, since: current.since, now: now() }));
        }

        // Someone mentioned AFK users: tell them, once a minute per channel.
        const t = now();
        pruneCooldowns(t);
        const cards = [];
        for (const [id, user] of message.mentions?.users || []) {
            if (cards.length >= afk.MAX_NOTIFY_PER_MESSAGE) break;
            if (id === userId || id === botId || user?.bot) continue;
            const record = store.get(guildId, id);
            if (!record) continue;
            const cooldownKey = `${message.channel.id}:${id}`;
            const last = cooldowns.get(cooldownKey);
            if (last !== undefined && t - last < afk.NOTIFY_COOLDOWN_MS) continue;
            cooldowns.set(cooldownKey, t);
            cards.push(afk.notifyMessage({ userId: id, reason: record.reason, since: record.since, now: t }));
        }
        if (cards.length) {
            await send(message, { content: cards.map((card) => card.content).join('\n\n'), allowedMentions: { parse: [], users: [], repliedUser: false } });
        }
        return { handled: false };
    }

    return { handle };
}

module.exports = { createAfkHandler };
