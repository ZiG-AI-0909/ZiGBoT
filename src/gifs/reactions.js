/**
 * Reaction GIFs: decide whether a reply gets a GIF, and send it.
 *
 * decideGif() is pure (tested directly); createReactionGifs() keeps the
 * per-channel / per-member counters and talks to GIPHY. A GIF is only ever
 * an extra: any "no" or failure simply leaves the text reply on its own.
 *
 * Moments:
 *  - 'chat'   the AI suggested a style that this mode allows
 *  - 'roast'  savage comeback at someone trash-talking ZiGBoT
 *  - 'defend' ZiGBoT standing up for a member who was insulted
 * Roast/defend moments skip the per-channel "every N replies" rule but keep
 * the per-member cooldown.
 */
const { GIF_FREQUENCIES, GIF_STYLES, buildGifQuery, validateGifStyle } = require('../../dashboard/lib/shared');

const pick = (list, rng) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/** The GIF style for this moment, or null. Gentle rules never return a roast style. */
function chooseStyle({ rules, moment, aiStyle = null, rng = Math.random }) {
    const allowed = rules.styles;
    const roastStyles = allowed.filter((s) => GIF_STYLES[s].roast);
    if (moment === 'roast') {
        if (!rules.roastAllowed || roastStyles.length === 0) return null;
        return roastStyles.includes(aiStyle) ? aiStyle : pick(roastStyles, rng);
    }
    if (moment === 'defend') {
        if (rules.roastAllowed && roastStyles.length) return roastStyles.includes(aiStyle) ? aiStyle : pick(roastStyles, rng);
        return allowed.includes('hug') ? 'hug' : null;
    }
    return aiStyle && allowed.includes(aiStyle) ? aiStyle : null;
}

/**
 * Should this reply get a GIF? Pure.
 * Returns { send: false, reason } or { send: true, style, query, fallbackQuery }.
 */
function decideGif({
    providerEnabled, gifSettings, rules, channelId, inChatChannel, isCrisis = false, moment = 'chat',
    aiStyle = null, aiTheme = null, repliesSinceGif = 0, lastGifForUserAt = 0, now = Date.now(), rng = Math.random
}) {
    const no = (reason) => ({ send: false, reason });
    if (!providerEnabled) return no('no_provider');
    if (isCrisis) return no('crisis');
    if (!gifSettings?.enabled || !rules?.enabled) return no('disabled');
    if ((gifSettings.blocked_channel_ids || []).includes(String(channelId))) return no('channel_blocked');
    if (gifSettings.channels !== 'all' && !inChatChannel) return no('not_chat_channel');
    const style = chooseStyle({ rules, moment, aiStyle, rng });
    if (!style) return no('no_style');
    const frequency = GIF_FREQUENCIES[rules.frequency] || GIF_FREQUENCIES.normal;
    if (moment === 'chat' && repliesSinceGif < frequency.every) return no('channel_frequency');
    if (now - lastGifForUserAt < frequency.cooldownMs) return no('user_cooldown');
    // Persona style: the admin's (Premium), else the AI's 1-2 word guess when allowed.
    let theme = rules.customStyle;
    if (!theme && rules.inferStyle && aiTheme) {
        const checked = validateGifStyle(aiTheme);
        theme = !checked.error && checked.value && checked.value.split(' ').length <= 2 ? checked.value : null;
    }
    const fallbackQuery = buildGifQuery(style, { rng });
    const query = theme ? buildGifQuery(style, { customStyle: theme, rng }) || fallbackQuery : fallbackQuery;
    if (!query) return no('query_blocked');
    return { send: true, style, query, fallbackQuery: query === fallbackQuery ? null : fallbackQuery };
}

function createReactionGifs({ giphy, now = () => Date.now(), logger = console, rng = Math.random }) {
    const repliesSince = new Map(); // channelId -> bot replies since its last GIF
    const lastForUser = new Map(); // guildId:userId -> time of their last GIF
    const trim = (map) => {
        if (map.size > 5000) map.delete(map.keys().next().value);
    };

    function noteReply(channelId) {
        const id = String(channelId);
        repliesSince.set(id, (repliesSince.get(id) || 0) + 1);
        trim(repliesSince);
    }

    /** Never throws; returns the decision (with `sent`) for logging/tests. */
    async function maybeSend({ channel, guildId, userId, gifSettings, rules, inChatChannel, isCrisis = false, moment = 'chat', aiGif = null }) {
        const userKey = `${guildId}:${userId}`;
        const decision = decideGif({
            providerEnabled: Boolean(giphy?.enabled),
            gifSettings,
            rules,
            channelId: channel?.id,
            inChatChannel,
            isCrisis,
            moment,
            aiStyle: aiGif?.style || null,
            aiTheme: aiGif?.theme || null,
            repliesSinceGif: repliesSince.get(String(channel?.id)) || 0,
            lastGifForUserAt: lastForUser.get(userKey) || 0,
            now: now(),
            rng
        });
        if (!decision.send) return decision;
        try {
            let url = await giphy.search(decision.query);
            if (!url && decision.fallbackQuery) url = await giphy.search(decision.fallbackQuery);
            if (!url) return { ...decision, send: false, reason: 'no_result' };
            // GIPHY requires visible attribution; the link itself shows as an embed.
            await channel.send({ content: `${url}\n-# Powered by GIPHY`, allowedMentions: { parse: [] } });
            repliesSince.set(String(channel.id), 0);
            lastForUser.set(userKey, now());
            trim(lastForUser);
            return { ...decision, sent: true };
        } catch (error) {
            logger.error?.(`[ZiGBoT GIF] Send failed: ${error?.code || error?.name || 'Error'}`);
            return { ...decision, send: false, reason: 'send_failed' };
        }
    }

    return { noteReply, maybeSend };
}

module.exports = { createReactionGifs, decideGif, chooseStyle };
