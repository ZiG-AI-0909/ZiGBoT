/**
 * AFK: parsing, reason cleanup, durations and the three announcement cards.
 * Pure functions (no Discord, no database), so all of it is unit-tested.
 *
 * Tagging rules for every card:
 *  - the user is tagged with a real <@id> mention, exactly once;
 *  - allowedMentions never parses @everyone/@here/roles, and only lists
 *    the one user a card is meant to notify (or nobody);
 *  - times use Discord timestamps (<t:unix:t>), which every reader sees in
 *    their OWN timezone (the bot runs on UTC; India reads IST, and so on).
 */
const { moderateReplyText } = require('../../dashboard/lib/shared/safety');

const REASON_MAX = 100;
const DEFAULT_REASON = 'AFK';
const HIDDEN_REASON = '(reason hidden)';
const NOTIFY_COOLDOWN_MS = 60_000; // per channel, per AFK user
const MAX_NOTIFY_PER_MESSAGE = 3;
const NICK_MAX = 32; // Discord's limit
const NICK_SUFFIX = ' [AFK]';

/** { reason } when the message is "afk [reason]" (optionally after @ZiGBoT), else null. */
function parseAfkCommand(content, botId) {
    if (typeof content !== 'string') return null;
    let text = content.trim();
    if (botId) text = text.replace(new RegExp(`^<@!?${botId}>\\s*`), '');
    const match = text.match(/^afk(?:\s+([\s\S]*))?$/i);
    return match ? { reason: (match[1] || '').trim() } : null;
}

/** Safe, short, single-line reason: no pings, no code blocks, nothing the safety filter blocks. */
function cleanReason(raw) {
    let text = typeof raw === 'string' ? raw : '';
    text = text
        .replace(/`/g, "'")
        .replace(/<@!?\d+>/g, '@user')
        .replace(/<@&\d+>/g, '@role')
        .replace(/@(everyone|here)/gi, '@​$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return DEFAULT_REASON;
    if (!moderateReplyText(text).allowed) return HIDDEN_REASON;
    return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1).trimEnd()}…` : text;
}

/** "1 hour 35 minutes", "2 days 3 hours 1 minute", "less than a minute". */
function formatDuration(ms) {
    const totalMinutes = Number.isFinite(ms) ? Math.floor(ms / 60_000) : 0;
    if (totalMinutes < 1) return 'less than a minute';
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const part = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : null);
    return [part(days, 'day'), part(hours, 'hour'), part(minutes, 'minute')].filter(Boolean).join(' ');
}

// Discord timestamp. Longer than half a day: show the date too.
const stamp = (ms, { withDate = false } = {}) => `<t:${Math.floor(ms / 1000)}:${withDate ? 'f' : 't'}>`;
const tag = (userId) => `<@${userId}>`;
const notify = (userId) => ({ parse: [], users: userId ? [userId] : [], repliedUser: false });
const LONG_AWAY_MS = 12 * 60 * 60 * 1000;

function alertMessage({ userId, reason, since }) {
    return {
        content: [
            '💤 **AFK ALERT**',
            '',
            `👤 **User:** ${tag(userId)}`,
            `📝 **Reason:** ${reason}`,
            `⏰ **Since:** ${stamp(since)}`,
            '',
            "They've gone AFK. Don't disturb them! 💙"
        ].join('\n'),
        allowedMentions: notify(userId)
    };
}

/** For someone who mentioned an AFK user. Shows the tag without a second ping. */
function notifyMessage({ userId, reason, since, now }) {
    return {
        content: [
            '💤 **AFK NOTIFICATION**',
            '',
            `${tag(userId)} is currently AFK!`,
            '',
            `📝 Reason: ${reason}`,
            `⌛ Away for: ${formatDuration(now - since)} (since ${stamp(since, { withDate: now - since >= LONG_AWAY_MS })})`,
            '',
            'Please wait until they return!'
        ].join('\n'),
        allowedMentions: notify(null)
    };
}

function welcomeBackMessage({ userId, reason, since, now }) {
    const withDate = now - since >= LONG_AWAY_MS;
    return {
        content: [
            '🎉 **WELCOME BACK!**',
            '',
            `${tag(userId)} IS BACK ONLINE! 👋`,
            'We missed you!',
            '',
            '📊 **AFK REPORT**',
            `- Reason: ${reason}`,
            `- Left at: ${stamp(since, { withDate })}`,
            `- Returned at: ${stamp(now, { withDate })}`,
            `- Total Away Time: ${formatDuration(now - since)}`,
            '',
            '🔥 Welcome back to the server!'
        ].join('\n'),
        allowedMentions: notify(userId)
    };
}

/** "Name [AFK]" within Discord's 32 characters; unchanged if it already ends in [AFK]. */
function afkNickname(displayName) {
    const name = String(displayName || '').trim() || 'AFK';
    if (name.endsWith(NICK_SUFFIX)) return name.slice(0, NICK_MAX);
    return `${name.slice(0, NICK_MAX - NICK_SUFFIX.length).trimEnd()}${NICK_SUFFIX}`;
}

module.exports = {
    REASON_MAX,
    DEFAULT_REASON,
    HIDDEN_REASON,
    NOTIFY_COOLDOWN_MS,
    MAX_NOTIFY_PER_MESSAGE,
    parseAfkCommand,
    cleanReason,
    formatDuration,
    alertMessage,
    notifyMessage,
    welcomeBackMessage,
    afkNickname
};
