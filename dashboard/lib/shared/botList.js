/**
 * discordbotlist.com: the upvote link, the vote webhook check, and the
 * messages that thank voters and invite new servers to vote.
 *
 * The vote webhook sends our secret (DBL_WEBHOOK_SECRET, set on the bot's
 * edit page) as the plain Authorization header, with { id, username,
 * avatar, admin } as the body. CommonJS so the bot and the tests share it.
 */
const crypto = require('node:crypto');

const VOTE_URL = 'https://discordbotlist.com/bots/zigbot/upvote';
const SNOWFLAKE = /^\d{17,20}$/;

/** Constant-time compare of the Authorization header with our secret. */
function verifyVoteSecret(header, secret) {
    if (typeof secret !== 'string' || secret.length < 16 || typeof header !== 'string') return false;
    const a = crypto.createHash('sha256').update(header).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
}

/** A zb_votes row, or null when the body has no valid voter. */
function parseVote(body) {
    const id = String(body?.id ?? '');
    if (!SNOWFLAKE.test(id)) return null;
    const name = typeof body?.username === 'string' && body.username.trim() ? body.username.trim().slice(0, 100) : null;
    return { site: 'discordbotlist', user_discord_id: id, user_name: name };
}

// <…> around links stops Discord from adding a big preview card.
const VOTE_THANKS = `💜 Thanks for upvoting ZiGBoT! Every vote helps more servers find it. You can vote again in 12 hours: <${VOTE_URL}>`;

/** DM to whoever added ZiGBoT to a server (from the install webhook). */
function installThanks(guildName) {
    const where = guildName ? ` to **${String(guildName).slice(0, 100)}**` : '';
    return [
        `👋 Thanks for adding ZiGBoT${where}!`,
        'Run **/setup** in your server so I know the language and roles, then mention me and say hi.',
        `Enjoying it? An upvote helps a lot: <${VOTE_URL}> 💜`
    ].join('\n');
}

/** Last line of the welcome message posted in a new server. */
const VOTE_LINE = `💜 Enjoying ZiGBoT? Upvote it here: <${VOTE_URL}>`;

module.exports = { VOTE_URL, VOTE_THANKS, VOTE_LINE, verifyVoteSecret, parseVote, installThanks };
