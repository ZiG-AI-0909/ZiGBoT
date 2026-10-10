/**
 * Thin wrapper around googleapis.youtube() bound to the bot's OAuth client.
 * Provides:
 *   - lazy construction so tests can inject a mock
 *   - uniform API error classification (quotaExceeded vs auth vs transient)
 *   - a process-wide quota ledger with a configurable daily budget
 * Errors are classified, never swallowed silently: callers decide policy
 * (back off, disable, notify the owner), this module only categorizes.
 */
const { google } = require('googleapis');

// Error types this module tags onto `error.yt`
const KIND = {
    QUOTA: 'quota',            // daily quotaExceeded — stop calling until midnight PT
    AUTH: 'auth',              // invalid_grant / 401 / invalid credentials — re-run auth helper
    TRANSIENT: 'transient',    // 5xx / network / rate limit — retry with backoff
    PERMANENT: 'permanent',    // 4xx other — log + surface, likely a bug
    FORBIDDEN: 'forbidden'     // 403 not-quota related (live chat disabled, not a moderator, etc.)
};

function classifyYouTubeError(error) {
    const status = error?.code ?? error?.response?.status ?? null;
    const reason = error?.errors?.[0]?.reason
        || error?.response?.data?.error?.errors?.[0]?.reason
        || error?.response?.data?.error?.status
        || '';
    const message = error?.message || '';

    if (reason === 'quotaExceeded' || /quota/i.test(message)) return KIND.QUOTA;
    if (/invalid_grant|unauthorized|invalid credentials/i.test(message) || status === 401) return KIND.AUTH;
    if (status === 403) return reason === 'forbidden' ? KIND.FORBIDDEN : KIND.FORBIDDEN;
    if (status >= 500 || (!status && !reason)) return KIND.TRANSIENT;
    if (status >= 400) return KIND.PERMANENT;
    return KIND.TRANSIENT;
}

/** Attach a structured `.yt` classification to a thrown error (idempotent). */
function tagYtError(error) {
    if (!error) return error;
    if (!error.yt) error.yt = { kind: classifyYouTubeError(error) };
    return error;
}

// ---- Daily quota ledger (safety budget below the real 10,000) ----

let quotaUsed = 0;
let quotaDayKey = null;
let quotaBudget = 10_000;
let quotaExhaustedByGoogle = false;
let quotaMethods = {};
let quotaBrain = null;
let quotaNotice = () => {};
let quotaPersistenceNoticeSent = false;
let quotaExhaustionNoticeSent = false;
let ledgerLoad = null;

function startPtDayKey(now = new Date()) {
    // Quota resets at midnight Pacific Time regardless of server timezone.
    const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, '0')}-${String(pt.getDate()).padStart(2, '0')}`;
}

function setQuotaBudget(units) {
    quotaBudget = Math.max(0, Number(units) || 0);
}

function resetForDay(key) {
    quotaDayKey = key;
    quotaUsed = 0;
    quotaExhaustedByGoogle = false;
    quotaMethods = {};
    quotaExhaustionNoticeSent = false;
}

async function hydrateQuotaLedger(now = new Date()) {
    const key = startPtDayKey(now);
    if (key === quotaDayKey && !ledgerLoad) return;
    if (key !== quotaDayKey) resetForDay(key);
    if (!quotaBrain?.getYtQuotaLedger) return;
    if (!ledgerLoad) {
        ledgerLoad = Promise.resolve(quotaBrain.getYtQuotaLedger(key)).then((row) => {
            if (quotaDayKey !== key || !row) return;
            quotaUsed = Math.max(quotaUsed, Number(row.usedUnits) || 0);
            quotaExhaustedByGoogle = quotaExhaustedByGoogle || Boolean(row.exhausted);
            quotaMethods = row.methods && typeof row.methods === 'object' ? row.methods : quotaMethods;
        }).catch((error) => {
            if (!quotaPersistenceNoticeSent) {
                quotaPersistenceNoticeSent = true;
                quotaNotice(`quota ledger persistence unavailable; using in-memory accounting (${error?.message || 'MongoDB unavailable'}).`);
            }
        }).finally(() => { ledgerLoad = null; });
    }
    await ledgerLoad;
}

function configureQuotaLedger({ brain = null, onNotice = () => {} } = {}) {
    quotaBrain = brain;
    quotaNotice = typeof onNotice === 'function' ? onNotice : () => {};
    quotaPersistenceNoticeSent = false;
    quotaDayKey = null;
}

function recordQuota(units, method = 'unknown') {
    const key = startPtDayKey();
    if (key !== quotaDayKey) {
        resetForDay(key);
    }
    const cost = Math.max(0, Number(units) || 0);
    const methodKey = String(method || 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80) || 'unknown';
    quotaUsed += cost;
    const current = quotaMethods[methodKey] || { calls: 0, units: 0 };
    quotaMethods[methodKey] = { calls: current.calls + 1, units: current.units + cost };
    return quotaUsed;
}

function quotaRemaining() {
    const key = startPtDayKey();
    if (key !== quotaDayKey) return quotaBudget;
    if (quotaExhaustedByGoogle) return 0;
    return Math.max(0, quotaBudget - quotaUsed);
}

function quotaUsedToday() {
    const key = startPtDayKey();
    if (key !== quotaDayKey) return 0;
    return quotaUsed;
}

function quotaExhausted() {
    return quotaExhaustedByGoogle || quotaRemaining() <= 0;
}

function quotaMethodUsage() {
    return Object.fromEntries(Object.entries(quotaMethods).map(([method, usage]) => [method, {
        calls: Number(usage.calls) || 0, units: Number(usage.units) || 0
    }]));
}

async function persistQuotaCall(key, method, cost) {
    if (!quotaBrain?.recordYtQuotaCall) return;
    try { await quotaBrain.recordYtQuotaCall(key, method, cost); }
    catch (error) {
        if (!quotaPersistenceNoticeSent) {
            quotaPersistenceNoticeSent = true;
            quotaNotice(`quota ledger persistence unavailable; using in-memory accounting (${error?.message || 'MongoDB unavailable'}).`);
        }
    }
}

async function markQuotaExceeded() {
    const key = startPtDayKey();
    if (key !== quotaDayKey) resetForDay(key);
    quotaExhaustedByGoogle = true;
    quotaUsed = Math.max(quotaUsed, quotaBudget);
    if (!quotaExhaustionNoticeSent) {
        quotaExhaustionNoticeSent = true;
        quotaNotice('Google reported quotaExceeded; all YouTube calls are paused until midnight Pacific.');
    }
    if (!quotaBrain?.markYtQuotaExhausted) return;
    try { await quotaBrain.markYtQuotaExhausted(key, quotaBudget); }
    catch (error) {
        if (!quotaPersistenceNoticeSent) {
            quotaPersistenceNoticeSent = true;
            quotaNotice(`quota exhaustion could not be persisted; using in-memory accounting (${error?.message || 'MongoDB unavailable'}).`);
        }
    }
}

function _resetQuotaForTests() {
    quotaUsed = 0;
    quotaDayKey = null;
    quotaExhaustedByGoogle = false;
    quotaMethods = {};
    quotaBrain = null;
    quotaNotice = () => {};
    quotaPersistenceNoticeSent = false;
    quotaExhaustionNoticeSent = false;
    ledgerLoad = null;
}

// ---- Client factory ----

/**
 * Build (or return the cached) youtube client.
 * opts.youtube: pre-built youtube instance for tests (mock injection).
 * opts.clientId/Secret/RefreshToken: credentials (never logged).
 */
let cachedYouTube = null;
let cachedCredentialsKey = '';

function getYoutubeClient({ youtube = null, clientId = '', clientSecret = '', refreshToken = '' } = {}) {
    if (youtube) return youtube;
    const key = [clientId, clientSecret, refreshToken].join('|');
    if (cachedYouTube && key === cachedCredentialsKey) return cachedYouTube;

    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    cachedYouTube = google.youtube({ version: 'v3', auth: oauth2 });
    cachedCredentialsKey = key;
    return cachedYouTube;
}

/**
 * Run a YouTube call with uniform quota accounting + error tagging.
 * costUnits: quota units this call is expected to consume.
 * Returns the response, or throws (tagged) on failure.
 */
async function ytCall(youtube, resourceMethod, params, { costUnits = 1, budget = 10_000, method = 'unknown' } = {}) {
    await hydrateQuotaLedger();
    const callCost = Math.max(1, Number(costUnits) || 1);
    const remaining = quotaRemaining();
    if (remaining < callCost) {
        const error = new Error(`YouTube quota budget insufficient for this ${callCost}-unit call (${quotaUsedToday()}/${budget} units used today, ${remaining} remaining). Pausing calls that exceed the remaining PT-day budget.`);
        error.yt = { kind: KIND.QUOTA, budgetExhausted: true };
        throw error;
    }
    try {
        const key = startPtDayKey();
        recordQuota(callCost, method);
        await persistQuotaCall(key, method, callCost);
        const response = await resourceMethod(params);
        return response;
    } catch (error) {
        const tagged = tagYtError(error);
        if (tagged?.yt?.kind === KIND.QUOTA) await markQuotaExceeded();
        throw tagged;
    }
}

module.exports = {
    KIND,
    classifyYouTubeError,
    tagYtError,
    setQuotaBudget,
    recordQuota,
    quotaRemaining,
    quotaUsedToday,
    quotaExhausted,
    quotaMethodUsage,
    hydrateQuotaLedger,
    configureQuotaLedger,
    markQuotaExceeded,
    startPtDayKey,
    getYoutubeClient,
    ytCall,
    _resetQuotaForTests
};
