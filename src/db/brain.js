/**
 * MongoDB persistence (native mongodb driver), single schema home for ZiGBoT.
 * Replaces better-sqlite3, whose native binary crashed on Render's Node ABI
 * and whose on-disk file was wiped on every free-tier restart anyway.
 *
 * Data shape mirrors the old SQLite schema:
 *   users    collection -> { userId (unique), warnings: [], xp: 0, notes: {} }
 *   warnings collection -> { id, guildId, userId, reason, issued_by, created_at }
 * The rest of the codebase must not talk to Mongo outside this module.
 */
const { MongoClient } = require('mongodb');

let client = null;
let users = null;
let warnings = null;
let counters = null;
let memories = null;
let behaviors = null;
let lastMemoryError = null;
let lastBehaviorError = null;

// ---- Long-term memory store constants ----

const MEMORY_TYPES = new Set(['fact', 'preference', 'event', 'context']);
const MEMORY_MAX_LENGTH = 500;
const MEMORY_DEFAULT_LIMIT = 5;
const MEMORY_MAX_LIMIT = 20;

// ---- Behavior accountability (who did what, and how the bot treats them) ----
// Sliding-window reputation: positive signals +1, negative -2, only events
// newer than 30 days count. Tiers are COMPUTED from the net score, never
// stored — a member's standing always reflects recent, real behavior.
const BEHAVIOR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const POSITIVE_SCORE = 1;
const NEGATIVE_SCORE = -2;
const BEHAVIOR_TYPES = new Set(['positive', 'negative']);
const BEHAVIOR_SIGNALS = {
    POSITIVE: { HELPFUL: 'helpful', SUPPORTIVE: 'supportive', KIND: 'kind', DEESCALATION: 'deescalation' },
    NEGATIVE: { TOXIC: 'toxic', SLURS: 'slurs', HARASSMENT: 'harassment', SPAM: 'spam', WARNING: 'warning' }
};
const BEHAVIOR_SIGNAL_SET = new Set([
    'helpful', 'supportive', 'kind', 'deescalation',
    'toxic', 'slurs', 'harassment', 'spam', 'warning'
]);

// Values that must never enter the memory collection. Checked before any
// write; a match means the write is refused outright (never silently stored).
const CREDENTIAL_VALUE_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}\b/,                                        // OpenAI-style API keys
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,                                   // GitHub tokens
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                                 // Slack tokens
    /\bAKIA[0-9A-Z]{16}\b/,                                             // AWS access key ids
    /\bAIza[0-9A-Za-z_-]{30,}\b/,                                       // Google API keys
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ // JWTs
];
// Label-style secrets: "password: hunter2", "api_key=abc123", "the token is xyz".
// (Note: \\s*[=:] catches label:value and label=value; the second alternative
// catches the prose "X is Y" form.)
const CREDENTIAL_LABEL_PATTERN = /\b(?:api[-_ ]?keys?|tokens?|secrets?|passw(?:or)?ds?|passwd|credentials?)\s*[=:]\s*\S+|\b(?:password|passwd|secret|token|api[-_ ]?keys?|credentials?)\s+is\s+\S+/i;

function containsCredential(text) {
    return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(text))
        || CREDENTIAL_LABEL_PATTERN.test(text);
}

async function connectBrain(uri, { client: injectedClient = null } = {}) {
    if (!uri) {
        throw new Error('connectBrain requires a MongoDB URI (set MONGODB_URI)');
    }
    // Connect fully BEFORE publishing any module state: a failed connect must
    // never leave half-initialized collections behind.
    const newClient = injectedClient || new MongoClient(uri);
    await newClient.connect();

    const db = newClient.db('zigbot');
    const nextUsers = db.collection('users');
    const nextWarnings = db.collection('warnings');
    const nextCounters = db.collection('counters');
    const nextMemories = db.collection('memories');
    const nextBehaviors = db.collection('behaviors');

    await nextUsers.createIndex({ userId: 1 }, { unique: true });
    // Same lookup pattern as the old idx_warnings_guild_user SQLite index.
    await nextWarnings.createIndex({ guildId: 1, userId: 1, created_at: 1 });
    // Memory recall always filters by guild+user and sorts newest-first.
    await nextMemories.createIndex({ guildId: 1, userId: 1, created_at: -1 });
    // Behavior accountability: per-member lookups + signal aggregation.
    await nextBehaviors.createIndex({ guildId: 1, userId: 1, created_at: -1 });

    // Everything succeeded — swap the live state over in one go.
    client = newClient;
    users = nextUsers;
    warnings = nextWarnings;
    counters = nextCounters;
    memories = nextMemories;
    behaviors = nextBehaviors;
    lastMemoryError = null;
    lastBehaviorError = null;

    return users;
}

function requireBrain() {
    if (!users) {
        throw new Error('Brain is not connected. Call connectBrain() first.');
    }
}

async function getUser(userId) {
    requireBrain();
    const found = await users.findOne({ userId });
    return found || { userId, warnings: [], xp: 0, notes: {} };
}

async function updateUser(userId, patch) {
    requireBrain();
    await users.updateOne({ userId }, { $set: patch }, { upsert: true });
}

// ---- Warning store (async replacements for the old sync WarnStore API) ----

async function addWarning(guildId, userId, reason, issuedBy) {
    requireBrain();
    // Atomic sequence, mirrors the old SQLite AUTOINCREMENT ids.
    const { value } = await counters.findOneAndUpdate(
        { _id: 'warning_id' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    const record = {
        id: value.seq,
        guildId,
        userId,
        reason: reason || 'No reason provided',
        issued_by: issuedBy,
        created_at: Date.now()
    };
    await warnings.insertOne(record);
    return { id: record.id, reason: record.reason, issuedBy: record.issued_by };
}

async function listWarnings(guildId, userId) {
    requireBrain();
    return warnings.find({ guildId, userId }).sort({ created_at: 1, id: 1 }).toArray();
}

async function countWarnings(guildId, userId) {
    requireBrain();
    return warnings.countDocuments({ guildId, userId });
}

// ---- Long-term memory store (persistent conversational memory) ----
// Unlike ConversationMemory in ai/memory.js (8 msgs / 15 min, in-process),
// these records survive restarts because MongoDB Atlas is the source of truth.
// Every failure is recorded in lastMemoryError so the bot can report its real
// state instead of claiming a save or recall that never happened.

function noteMemoryError(error) {
    lastMemoryError = error?.message || String(error);
}

async function remember(guildId, userId, content, type = 'fact') {
    requireBrain();
    const raw = String(content || '').trim();
    if (!guildId || !userId || !raw) {
        throw new Error('remember requires guildId, userId, and non-empty content.');
    }
    if (containsCredential(raw)) {
        throw new Error('Refusing to store passwords, API keys, tokens, or credentials in memory.');
    }
    const doc = {
        guildId: String(guildId),
        userId: String(userId),
        content: raw.slice(0, MEMORY_MAX_LENGTH),
        type: MEMORY_TYPES.has(type) ? type : 'fact',
        created_at: Date.now()
    };
    try {
        // Atomic sequence, same pattern as warning ids.
        const { value } = await counters.findOneAndUpdate(
            { _id: 'memory_id' },
            { $inc: { seq: 1 } },
            { upsert: true, returnDocument: 'after' }
        );
        doc.id = value.seq;
        await memories.insertOne(doc);
        lastMemoryError = null;
        return { id: doc.id, content: doc.content, type: doc.type, created_at: doc.created_at };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function recall(guildId, userId, limit = MEMORY_DEFAULT_LIMIT) {
    requireBrain();
    const capped = Math.max(1, Math.min(Number(limit) || MEMORY_DEFAULT_LIMIT, MEMORY_MAX_LIMIT));
    try {
        const rows = await memories
            .find({ guildId: String(guildId), userId: String(userId) })
            .sort({ created_at: -1, id: -1 })
            .limit(capped)
            .toArray();
        lastMemoryError = null;
        // Returned oldest-first so the AI reads them like a timeline.
        return rows.reverse().map(({ id, content, type, created_at }) => ({ id, content, type, created_at }));
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function countMemories(guildId, userId) {
    requireBrain();
    try {
        const count = await memories.countDocuments({ guildId: String(guildId), userId: String(userId) });
        lastMemoryError = null;
        return count;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function deleteMemoryById(guildId, userId, id) {
    requireBrain();
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new Error('Memory id must be a positive number.');
    }
    try {
        const result = await memories.deleteOne({ guildId: String(guildId), userId: String(userId), id: numericId });
        lastMemoryError = null;
        return result.deletedCount > 0;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function deleteAllMemories(guildId, userId) {
    requireBrain();
    try {
        const result = await memories.deleteMany({ guildId: String(guildId), userId: String(userId) });
        lastMemoryError = null;
        return result.deletedCount || 0;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// ---- Behavior accountability API ----
// Records real behavior events and computes a sliding-window reputation from
// them. Tiers are DERIVED, never stored, so standing always matches the
// recent record. Every failure lands in lastBehaviorError for honest status.

function noteBehaviorError(error) {
    lastBehaviorError = error?.message || String(error);
}

async function recordBehavior(guildId, userId, signal, { source = 'system', note = null } = {}) {
    requireBrain();
    if (!guildId || !userId || !BEHAVIOR_SIGNAL_SET.has(signal)) {
        throw new Error(`recordBehavior requires guildId, userId, and a known signal (${[...BEHAVIOR_SIGNAL_SET].join(', ')}).`);
    }
    const positive = ['helpful', 'supportive', 'kind', 'deescalation'].includes(signal);
    try {
        const doc = {
            guildId: String(guildId),
            userId: String(userId),
            signal,
            kind: positive ? 'positive' : 'negative',
            source,
            note: note ? String(note).slice(0, 200) : null,
            created_at: Date.now()
        };
        await behaviors.insertOne(doc);
        lastBehaviorError = null;
        return { signal: doc.signal, kind: doc.kind, created_at: doc.created_at };
    } catch (error) {
        noteBehaviorError(error);
        throw error;
    }
}

// Sliding-window reputation: positive signals count +1 each, negative -2 each
// (net). positive/negative in the result are raw EVENT COUNTS (what the UI
// shows); only `net` carries the weighting.
function scoreEvents(events, now = Date.now()) {
    let positive = 0;
    let negative = 0;
    for (const event of events) {
        if (now - event.created_at > BEHAVIOR_WINDOW_MS) continue;
        if (event.kind === 'positive') positive += 1;
        else negative += 1;
    }
    return { positive, negative, net: positive * POSITIVE_SCORE + negative * NEGATIVE_SCORE };
}

function tierFromScore(net) {
    if (net <= -6) return 'hostile';
    if (net <= -1) return 'rocky';
    if (net >= 5) return 'valued';
    if (net >= 2) return 'respected';
    return 'neutral';
}

async function getBehaviorSummary(guildId, userId) {
    requireBrain();
    try {
        const events = await behaviors
            .find({ guildId: String(guildId), userId: String(userId) })
            .sort({ created_at: -1 })
            .limit(200)
            .toArray();
        lastBehaviorError = null;
        const { positive, negative, net } = scoreEvents(events);
        const summary = {
            positive,
            negative,
            net,
            tier: tierFromScore(net),
            windowDays: BEHAVIOR_WINDOW_MS / (24 * 60 * 60 * 1000),
            recentEvents: events.slice(0, 5).map(({ signal, kind, created_at, source }) => ({ signal, kind, created_at, source })),
            totalEvents: events.length
        };
        return summary;
    } catch (error) {
        noteBehaviorError(error);
        throw error;
    }
}

async function countBehaviors(guildId, userId) {
    requireBrain();
    try {
        const count = await behaviors.countDocuments({ guildId: String(guildId), userId: String(userId) });
        lastBehaviorError = null;
        return count;
    } catch (error) {
        noteBehaviorError(error);
        throw error;
    }
}

async function deleteBehaviors(guildId, userId) {
    requireBrain();
    try {
        const result = await behaviors.deleteMany({ guildId: String(guildId), userId: String(userId) });
        lastBehaviorError = null;
        return result.deletedCount || 0;
    } catch (error) {
        noteBehaviorError(error);
        throw error;
    }
}

function isBehaviorAvailable() {
    return Boolean(behaviors);
}

// ---- Truthful runtime capability reporting ----
// The AI prompt and diagnostic commands must derive their memory claims from
// these values, never from hard-coded assumptions.

function isMemoryAvailable() {
    return Boolean(memories);
}

function getMemoryCapabilities() {
    const available = Boolean(memories);
    return {
        persistentMemory: available,
        memoryDatabase: available ? 'MongoDB' : null,
        conversationMemory: true, // in-process sliding window, always wired
        memoryRetrieval: available,
        memoryWrite: available
    };
}

function getMemoryStatus() {
    return {
        ...getMemoryCapabilities(),
        connected: Boolean(client),
        collection: 'memories',
        lastError: lastMemoryError
    };
}

// Test-only hook: revert to the never-connected state so suites can assert
// the loud-failure guards and truthful capability reporting without spawning
// a new process or mutating require.cache.
function _disconnectForTests() {
    client = null;
    users = null;
    warnings = null;
    counters = null;
    memories = null;
    behaviors = null;
    lastMemoryError = null;
    lastBehaviorError = null;
}

module.exports = {
    connectBrain,
    getUser,
    updateUser,
    addWarning,
    listWarnings,
    countWarnings,
    remember,
    recall,
    countMemories,
    deleteMemoryById,
    deleteAllMemories,
    isMemoryAvailable,
    getMemoryCapabilities,
    getMemoryStatus,
    recordBehavior,
    getBehaviorSummary,
    countBehaviors,
    deleteBehaviors,
    isBehaviorAvailable,
    tierFromScore,
    scoreEvents,
    _disconnectForTests
};
