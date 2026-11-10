/**
 * Server count for ZiGBoT's discordbotlist.com page (DBL_TOKEN, from the
 * bot's edit page -> API token). Posted at startup and every hour; without
 * a token nothing is sent. The token is only ever sent to discordbotlist.com.
 */
const API = 'https://discordbotlist.com/api/v1';
const INTERVAL_MS = 60 * 60 * 1000;

function createStatsPoster({ token, botId, fetchImpl = globalThis.fetch, logger = console } = {}) {
    // The docs only say "Authorization: <token>"; some tokens want a "Bot "
    // prefix. Try plain first and remember whichever one Discordbotlist accepts.
    let scheme = '';
    async function post(stats) {
        if (!token || !/^\d{17,20}$/.test(String(botId || ''))) return false;
        const send = (prefix) => fetchImpl(`${API}/bots/${botId}/stats`, {
            method: 'POST',
            headers: { Authorization: `${prefix}${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(stats)
        });
        let response = await send(scheme);
        if (response.status === 401 && scheme === '') {
            response = await send('Bot ');
            if (response.ok) scheme = 'Bot ';
        }
        if (!response.ok) {
            logger.error?.(`[ZiGBoT DBL] Stats post failed: ${response.status}`);
            return false;
        }
        return true;
    }
    return { post };
}

/** Post now and every hour. Returns the timer (unref'd), or null when off. */
function startStatsPosting(client, { token, ...options } = {}) {
    if (!token) return null;
    const poster = createStatsPoster({ token, botId: client.user?.id, ...options });
    const run = () => poster.post({ guilds: client.guilds.cache.size })
        .catch((error) => console.error(`[ZiGBoT DBL] Stats post failed: ${error.message}`));
    void run();
    return setInterval(run, INTERVAL_MS).unref();
}

module.exports = { createStatsPoster, startStatsPosting };
