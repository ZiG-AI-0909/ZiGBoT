/**
 * GIPHY search for reaction GIFs (https://developers.giphy.com/docs/api/).
 *
 *  - rating=g (GIPHY's strictest rating), and every result is re-checked:
 *    anything not rated "g" or not a plain giphy.com GIF page is dropped.
 *  - Queries come only from lib/shared/gifs.js (fixed style queries plus a
 *    filtered persona style); they are re-checked here as defence in depth.
 *  - No caching: GIPHY's terms say media URLs must not be cached or stored
 *    without their approval. Instead a local hourly budget keeps us inside
 *    the key's rate limit (beta keys: 100 calls/hour), and a 429 pauses
 *    searching for a while.
 *  - Any failure returns null, so the caller just sends the text reply.
 *  - The API key is never logged: logs carry a status code or error name only.
 */
const { gifQueryProblem } = require('../../dashboard/lib/shared');

const ENDPOINT = 'https://api.giphy.com/v1/gifs/search';
const HOUR_MS = 60 * 60 * 1000;
const PAUSE_AFTER_429_MS = 15 * 60 * 1000;
const GIF_PAGE = /^https:\/\/giphy\.com\/gifs\/[A-Za-z0-9-]+$/;

function createGiphyClient({ apiKey, fetchImpl = globalThis.fetch, now = () => Date.now(), logger = console, budgetPerHour = 90, timeoutMs = 2500, rng = Math.random } = {}) {
    const enabled = Boolean(apiKey) && typeof fetchImpl === 'function';
    let windowStart = 0;
    let used = 0;
    let pausedUntil = 0;
    const fail = (reason) => logger.error?.(`[ZiGBoT GIF] Search failed: ${reason}`);

    function takeBudget() {
        const t = now();
        if (t - windowStart >= HOUR_MS) {
            windowStart = t;
            used = 0;
        }
        if (used >= budgetPerHour) return false;
        used += 1;
        return true;
    }

    /** A giphy.com GIF page URL (Discord shows it as an animated embed), or null. */
    async function search(query) {
        if (!enabled || !query || gifQueryProblem(query)) return null;
        if (now() < pausedUntil || !takeBudget()) return null;
        const params = new URLSearchParams({ api_key: apiKey, q: query, limit: '10', rating: 'g', lang: 'en' });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const response = await fetchImpl(`${ENDPOINT}?${params}`, { signal: controller?.signal });
            if (response.status === 429) {
                pausedUntil = now() + PAUSE_AFTER_429_MS;
                fail('rate limited (429), pausing GIF search for 15 minutes');
                return null;
            }
            if (!response.ok) {
                fail(`HTTP ${response.status}`);
                return null;
            }
            const body = await response.json();
            const safe = (Array.isArray(body?.data) ? body.data : [])
                .filter((gif) => gif && gif.rating === 'g' && typeof gif.url === 'string' && GIF_PAGE.test(gif.url));
            if (safe.length === 0) return null;
            return safe[Math.min(safe.length - 1, Math.floor(rng() * Math.min(safe.length, 5)))].url;
        } catch (error) {
            fail(error?.name === 'AbortError' ? 'timeout' : (error?.code || error?.name || 'Error'));
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    return { enabled, search };
}

module.exports = { createGiphyClient, GIF_PAGE };
