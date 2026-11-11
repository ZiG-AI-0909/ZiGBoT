/**
 * Avatar viewer: spotting a request ("av @user", "show me the pfp of @user",
 * "@ZiGBoT server avatar @user") and building the reply. Pure functions,
 * unit-tested; src/avatar/handler.js does the Discord side.
 *
 * A message is a request only when, besides the mentions, it holds nothing
 * but an avatar keyword and filler words ("show me the avatar of"). So
 * "nice pfp @user" or "I love the new avatar movie" never trigger.
 */
const { escapeMarkdown } = require('discord.js');

const COLOR = 0xa855f7; // ZiGBoT purple, as in the music and voice panels
const SIZE = 4096; // largest size Discord's CDN serves
const MAX_TARGETS = 5; // 2 cards each fits Discord's 10-embed limit
const MAX_WORDS = 10;
const COOLDOWN_MS = 4000; // per member
const ASK_WHO = '👀 Whose avatar do you want to see? Mention a user!';
const NOT_FOUND = "😕 I couldn't find that user. Mention someone with @ so I can show their avatar.";

const SNOWFLAKE = '\\d{17,20}';
const KEYWORD = /\b(?:av|avatars?|pfps?|dps?|profile\s+pic(?:ture)?s?|display\s+pic(?:ture)?s?)\b/i;
const KEYWORD_WORDS = new Set(['av', 'avatar', 'avatars', 'pfp', 'pfps', 'dp', 'dps', 'profile', 'pic', 'pics', 'picture', 'pictures', 'display']);
const FILLER = new Set([
    'show', 'me', 'the', 'of', 'for', 'send', 'give', 'get', 'see', 'post', 'and', 'a', 'this', 'that', 'here', 'now', 'also',
    'his', 'her', 'their', 'them', 'my', 'mine', 'your', 'ur', 'whats', "what's", 'pls', 'please', 'plz', 'can', 'could', 'would',
    'you', 'u', 'bro', 'yo', 'hey', 'server', 'guild', 'global', 'main', 'full', 'size', 'big', 'hd'
]);

/**
 * { targets, invalid, serverRequested, askWho[, truncated] } or null.
 * targets: user ids in the order written (the author for "my"), at most 5.
 * A leading @ZiGBoT is the address; ZiGBoT mentioned elsewhere is a target.
 */
function detectAvatarRequest({ content, botId, authorId }) {
    if (typeof content !== 'string' || !content.trim()) return null;
    let text = content.trim();
    let addressed = false;
    if (botId) {
        const lead = new RegExp(`^<@!?${botId}>\\s*`);
        if (lead.test(text)) {
            addressed = true;
            text = text.replace(lead, '');
        }
    }
    const ids = [];
    for (const match of text.matchAll(new RegExp(`<@!?(${SNOWFLAKE})>`, 'g'))) if (!ids.includes(match[1])) ids.push(match[1]);

    const words = text
        .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
        .toLowerCase()
        .replace(/[?!.,:;]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    if (!KEYWORD.test(words.join(' '))) return null;
    if (words.length > MAX_WORDS) return null;
    if (!words.every((w) => KEYWORD_WORDS.has(w) || FILLER.has(w))) return null;

    if (ids.length === 0 && authorId && words.some((w) => w === 'my' || w === 'mine')) ids.push(String(authorId));
    const serverRequested = words.includes('server') || words.includes('guild');
    if (ids.length === 0) {
        // Only an explicit "@ZiGBoT av" gets the question; a lone "av" is just chat.
        return addressed ? { targets: [], invalid: [], serverRequested, askWho: true } : null;
    }
    const result = { targets: ids.slice(0, MAX_TARGETS), invalid: [], serverRequested, askWho: false };
    if (ids.length > MAX_TARGETS) result.truncated = true;
    return result;
}

/**
 * Highest-quality URLs from discord.js's own avatarURL() (User or GuildMember).
 * Animated avatars stay animated (GIF). No custom avatar: the user gets
 * Discord's default avatar; a member (server avatar) gets null.
 */
function avatarUrls(source, { member = false } = {}) {
    const hash = source?.avatar;
    if (!hash) {
        if (member) return null;
        const url = source?.defaultAvatarURL || null;
        return { isDefault: true, animated: false, main: url, png: url, jpg: null, webp: null, gif: null };
    }
    const animated = String(hash).startsWith('a_');
    const at = (extension) => source.avatarURL({ extension, size: SIZE, forceStatic: true });
    return {
        isDefault: false,
        animated,
        main: source.avatarURL({ size: SIZE }),
        png: at('png'),
        jpg: at('jpg'),
        webp: at('webp'),
        gif: animated ? source.avatarURL({ extension: 'gif', size: SIZE }) : null
    };
}

// Names are shown as text: no markdown tricks, no @everyone/@here.
const safe = (text) => escapeMarkdown(String(text || '')).replace(/@(everyone|here)/gi, '@​$1').slice(0, 100);
const nameOf = ({ user, member }) => member?.displayName || user.globalName || user.username;

function card(entry, urls, kind) {
    const { user } = entry;
    const links = urls.isDefault
        ? `[PNG](${urls.png})`
        : [`[PNG](${urls.png})`, `[JPG](${urls.jpg})`, `[WEBP](${urls.webp})`, urls.gif ? `[GIF](${urls.gif})` : null].filter(Boolean).join(' · ');
    return {
        color: COLOR,
        title: kind === 'server' ? '🖼️ AVATAR VIEWER · Server avatar' : '🖼️ AVATAR VIEWER',
        url: urls.main,
        description: [
            `👤 **User:** <@${user.id}>`,
            '',
            '**Avatar Information**',
            `- Username: ${safe(user.username)}`,
            `- Display Name: ${safe(nameOf(entry))}`,
            `- User ID: \`${user.id}\``,
            urls.isDefault ? '- Default Discord avatar (no custom one set)' : null,
            urls.animated ? '- Animated avatar' : null,
            '',
            links
        ].filter((line) => line !== null).join('\n'),
        image: { url: urls.main }
    };
}

/** Discord message payload: cards (global and server avatar), full-size buttons, no pings. */
function buildAvatarReply(entries, { serverRequested = false, truncated = false, invalidCount = 0 } = {}) {
    const embeds = [];
    const buttons = [];
    const notes = [];
    for (const entry of entries) {
        const { global, server } = entry;
        const cards = [];
        if (serverRequested && server) {
            cards.push(card(entry, server, 'server'), card(entry, global, 'global'));
        } else {
            cards.push(card(entry, global, 'global'));
            if (server && server.main !== global.main) cards.push(card(entry, server, 'server'));
            if (serverRequested && !server) notes.push(`${safe(nameOf(entry))} has no server avatar, so here is their main one.`);
        }
        embeds.push(...cards);
        buttons.push({ type: 2, style: 5, label: `Open ${nameOf(entry)} full size`.slice(0, 80), url: cards[0].url });
    }
    if (truncated) notes.push(`Showing the first ${MAX_TARGETS} people.`);
    if (invalidCount > 0) notes.push(`I couldn't find ${invalidCount === 1 ? 'one of the people' : `${invalidCount} of the people`} you mentioned.`);
    const reply = {
        embeds: embeds.slice(0, 10),
        components: [{ type: 1, components: buttons.slice(0, 5) }],
        allowedMentions: { parse: [], repliedUser: false }
    };
    if (notes.length) reply.content = notes.join('\n');
    return reply;
}

module.exports = { COLOR, SIZE, MAX_TARGETS, COOLDOWN_MS, ASK_WHO, NOT_FOUND, detectAvatarRequest, avatarUrls, buildAvatarReply };
