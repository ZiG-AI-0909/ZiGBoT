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

const PT_TIME_ZONE = 'America/Los_Angeles';
/** Usage fractions that trigger a one-line per-method log when crossed. */
const QUOTA_LOG_THRESHOLDS = [0.5, 0.75, 0.9];

let quotaUsed = 0;
let quotaDayKey = null;
let quotaBudget = 10_000;
let quotaExhaustedByGoogle = false;
let quotaMethods = {};
let quotaBrain = null;
let quotaNotice = () => {};
let quotaPersistenceNoticeSent = false;
let quotaExhaustionNoticeSent = false;
let quotaThresholdsLogged = new Set();
let ledgerLoad = null;
// Wall clock used for the PT day boundary. Overridable in tests only.
let quotaClock = () => new Date();

/** `now` expressed as Pacific wall-clock fields (local Date object). */
function pacificWallClock(now = quotaClock()) {
    return new Date(now.toLocaleString('en-US', { timeZone: PT_TIME_ZONE }));
}

function startPtDayKey(now = quotaClock()) {
    // Quota resets at midnight Pacific Time regardless of server timezone.
    const pt = pacificWallClock(now);
    return `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, '0')}-${String(pt.getDate()).padStart(2, '0')}`;
}

/**
 * The moment the daily quota window next resets: the following midnight in
 * Pacific Time, plus an optional margin and jitter so several restarts/deploys
 * do not all retry at the same instant.
 */
function nextQuotaResetAt(now = quotaClock(), { marginMs = 0, jitterMs = 0 } = {}) {
    const pt = pacificWallClock(now);
    const nextPtMidnight = new Date(pt);
    nextPtMidnight.setDate(nextPtMidnight.getDate() + 1);
    nextPtMidnight.setHours(0, 0, 0, 0);
    const offsetMs = pt.getTime() - now.getTime();
    const margin = Math.max(0, Number(marginMs) || 0);
    const jitter = Math.max(0, Number(jitterMs) || 0);
    return new Date(nextPtMidnight.getTime() - offsetMs + margin + jitter);
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
    quotaThresholdsLogged = new Set();
}

async function hydrateQuotaLedger(now = quotaClock()) {
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
    checkQuotaThresholds();
    return quotaUsed;
}

/** One-line per-method breakdown, e.g. `liveChatMessages.list: 12 calls/60 units`. */
function quotaMethodLine(methods = quotaMethods) {
    return Object.entries(methods)
        .map(([method, usage]) => `${method}: ${Number(usage.calls) || 0} calls/${Number(usage.units) || 0} units`)
        .join('; ') || 'no calls recorded';
}

/**
 * Log once per day when the ledger crosses 50%, 75% and 90% of the budget, so
 * the method responsible for heavy usage is visible before the quota dies.
 */
function checkQuotaThresholds() {
    if (quotaBudget <= 0) return;
    const crossed = [];
    for (const fraction of QUOTA_LOG_THRESHOLDS) {
        const label = `${Math.round(fraction * 100)}%`;
        if (quotaThresholdsLogged.has(label)) continue;
        if (quotaUsed >= quotaBudget * fraction) {
            quotaThresholdsLogged.add(label);
            crossed.push(label);
        }
    }
    if (!crossed.length) return;
    quotaNotice(`YouTube quota crossed ${crossed.join('/')} (${quotaUsed}/${quotaBudget} units): ${quotaMethodLine()}`);
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
    checkQuotaThresholds();
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
    quotaThresholdsLogged = new Set();
    ledgerLoad = null;
    quotaClock = () => new Date();
}

/** Test-only: control the wall clock used for the PT day boundary. */
function _setQuotaClock(clock) {
    quotaClock = typeof clock === 'function' ? clock : () => new Date();
}

/** Test-only: the PT day boundary the ledger is currently keyed to. */
function _quotaDayKey() {
    return quotaDayKey;
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
    quotaMethodLine,
    hydrateQuotaLedger,
    configureQuotaLedger,
    markQuotaExceeded,
    startPtDayKey,
    nextQuotaResetAt,
    getYoutubeClient,
    ytCall,
    _resetQuotaForTests,
    _setQuotaClock,
    _quotaDayKey,
    QUOTA_LOG_THRESHOLDS,
    PT_TIME_ZONE
};
