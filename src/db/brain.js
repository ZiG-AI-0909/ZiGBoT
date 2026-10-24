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
let memoryPrefs = null;
let behaviors = null;
let ytGreeted = null;
let ytBans = null;
let ytNoRoast = null;
let ytQuota = null;
let lastMemoryError = null;
let lastBehaviorError = null;
// "Connected" is not "working": these record the last operation that really
// succeeded, so status can tell a live handle from a working store.
let lastMemoryWriteOkAt = null;
let lastMemoryReadOkAt = null;

// ---- Long-term memory store constants ----

const MEMORY_TYPES = new Set(['fact', 'preference', 'event', 'context']);
const MEMORY_MAX_LENGTH = 500;
const MEMORY_DEFAULT_LIMIT = 5;
const MEMORY_MAX_LIMIT = 20;
// All conversational memories expire 30 days after they are created.
const MEMORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MEMORY_RECALL_RECENT_CAP = 200;
// Schema v2 (additive): new writes carry these fields. v1 documents (written
// before them) are never rewritten; normalizeMemory() fills defaults on read.
const MEMORY_SCHEMA_VERSION = 2;
const MEMORY_SOURCES = new Set(['explicit', 'auto-text', 'auto-voice']);
const MEMORY_SCOPES = new Set(['personal']);
const MEMORY_ID_FIELD_MAX = 64;
const MEMORY_PAGE_SIZE = 10;
const MEMORY_SEARCH_MAX_LENGTH = 100;
const MEMORY_EXPORT_MAX = 200;

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

// Text that reads like instructions to the bot rather than a fact about the
// member. Explicit saves and corrections matching any of these are refused.
// This is an extra safeguard only: stored text must still be handled as
// untrusted data wherever it is shown to the model.
const INSTRUCTION_PAYLOAD_PATTERNS = [
    /\b(?:ignore|disregard|override|bypass)\b.{0,40}\b(?:instructions?|rules|prompts?|guidelines|directives?)\b/i,
    /\bforget\b.{0,20}\b(?:all|your|previous|prior|earlier|above)\b.{0,20}\b(?:instructions?|rules|prompts?)\b/i,
    /\byou\s+are\s+now\b/i,
    /\bfrom\s+now\s+on\s+(?:you|zigbot|the\s+bot)\b/i,
    /\b(?:system|developer)\s*(?:prompt|message|instructions?)\b/i,
    /^\s*(?:system|assistant|developer|user)\s*:/im,
    /<\|[^|>]{1,40}\|>/,
    /\[\/?(?:INST|SYS)\]|<<\/?SYS>>/i,
    /\bnew\s+(?:instructions?|rules|persona)\s*[:=]/i,
    /\b(?:jailbreak|jailbroken|DAN\s+mode|developer\s+mode)\b/i,
    /\b(?:act|behave|respond|pretend)\s+(?:as|like)\s+(?:if\s+you\s+(?:are|were)\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|evil|different)\b/i
];

function containsInstructionPayload(text) {
    return INSTRUCTION_PAYLOAD_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

// Thrown for input that must never reach the database. The message never
// echoes the content itself, so it is safe to log.
class MemoryValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemoryValidationError';
        this.code = 'MEMORY_INVALID';
    }
}

// The member turned memory off (or it could not be verified as on). Not a
// database failure, so it never lands in lastMemoryError.
class MemoryDisabledError extends Error {
    constructor(message = 'Personal memory is turned off for this member in this server.') {
        super(message);
        this.name = 'MemoryDisabledError';
        this.code = 'MEMORY_DISABLED';
    }
}

// Atomic sequence for integer ids. Driver v6+ returns the document itself
// from findOneAndUpdate (not { value }), so read seq straight off it.
async function nextSequence(name) {
    const counter = await counters.findOneAndUpdate(
        { _id: name },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after', includeResultMetadata: false }
    );
    if (!counter || !Number.isInteger(counter.seq)) {
        throw new Error(`Counter "${name}" returned no sequence value.`);
    }
    return counter.seq;
}

async function connectBrain(uri, { client: injectedClient = null, dbName = 'zigbot' } = {}) {
    if (!uri) {
        throw new Error('connectBrain requires a MongoDB URI (set MONGODB_URI)');
    }
    if (typeof dbName !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) {
        throw new Error('connectBrain dbName must be 1-63 letters, digits, "_" or "-".');
    }
    // Connect fully BEFORE publishing any module state: a failed connect must
    // never leave half-initialized collections behind.
    const newClient = injectedClient || new MongoClient(uri);
    await newClient.connect();

    const db = newClient.db(dbName);
    const nextUsers = db.collection('users');
    const nextWarnings = db.collection('warnings');
    const nextCounters = db.collection('counters');
    const nextMemories = db.collection('memories');
    const nextMemoryPrefs = db.collection('memory_prefs');
    const nextBehaviors = db.collection('behaviors');
    const nextYtGreeted = db.collection('ytGreeted');
    const nextYtBans = db.collection('ytBans');
    const nextYtNoRoast = db.collection('ytNoRoast');
    const nextYtQuota = db.collection('ytQuota');

    // Clean up records created before the TTL field was added, and enforce the
    // retention boundary immediately when the bot starts.
    await nextMemories.deleteMany({ created_at: { $lt: Date.now() - MEMORY_RETENTION_MS } });
    await nextUsers.createIndex({ userId: 1 }, { unique: true });
    // Same lookup pattern as the old idx_warnings_guild_user SQLite index.
    await nextWarnings.createIndex({ guildId: 1, userId: 1, created_at: 1 });
    // Memory recall always filters by guild+user and sorts newest-first.
    await nextMemories.createIndex({ guildId: 1, userId: 1, created_at: -1 });
    // Guild-wide recent-context lookups (cross-user, time-windowed).
    await nextMemories.createIndex({ guildId: 1, created_at: -1 });
    // MongoDB TTL cleanup is asynchronous; every read also enforces the cutoff.
    await nextMemories.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    // One preference document per member per server.
    await nextMemoryPrefs.createIndex({ guildId: 1, userId: 1 }, { unique: true });
    // Behavior accountability: per-member lookups + signal aggregation.
    await nextBehaviors.createIndex({ guildId: 1, userId: 1, created_at: -1 });
    await nextYtGreeted.createIndex({ videoId: 1, channelId: 1 }, { unique: true });
    await nextYtGreeted.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await nextYtBans.createIndex({ videoId: 1, channelId: 1 }, { unique: true });
    await nextYtBans.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await nextYtNoRoast.createIndex({ videoId: 1, channelId: 1 }, { unique: true });
    await nextYtNoRoast.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    await nextYtQuota.createIndex({ pacificDate: 1 }, { unique: true });
    await nextYtQuota.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

    // Everything succeeded — swap the live state over in one go.
    client = newClient;
    users = nextUsers;
    warnings = nextWarnings;
    counters = nextCounters;
    memories = nextMemories;
    memoryPrefs = nextMemoryPrefs;
    behaviors = nextBehaviors;
    ytGreeted = nextYtGreeted;
    ytBans = nextYtBans;
    ytNoRoast = nextYtNoRoast;
    ytQuota = nextYtQuota;
    lastMemoryError = null;
    lastBehaviorError = null;
    lastMemoryWriteOkAt = null;
    lastMemoryReadOkAt = null;

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
    const record = {
        id: await nextSequence('warning_id'),
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

function noteMemoryWriteOk() {
    lastMemoryError = null;
    lastMemoryWriteOkAt = Date.now();
}

function noteMemoryReadOk() {
    lastMemoryError = null;
    lastMemoryReadOkAt = Date.now();
}

// Owner key for every memory query. IDs always come from trusted Discord
// objects at the call site; this only guarantees they are plain short strings
// so no caller can smuggle a query operator into the filter.
function ownerKey(guildId, userId) {
    const guild = guildId === null || guildId === undefined ? '' : String(guildId);
    const user = userId === null || userId === undefined ? '' : String(userId);
    if (!guild || !user || guild.length > MEMORY_ID_FIELD_MAX || user.length > MEMORY_ID_FIELD_MAX) {
        throw new MemoryValidationError('Memory operations require a valid guildId and userId.');
    }
    return { guildId: guild, userId: user };
}

function validateMemoryId(id) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new MemoryValidationError('Memory id must be a positive number.');
    }
    return numericId;
}

// Content + type rules shared by create and update. Oversized content is
// rejected, never silently truncated.
function validateMemoryContent(content, type) {
    const text = String(content ?? '').trim();
    if (!text) {
        throw new MemoryValidationError('remember requires guildId, userId, and non-empty content.');
    }
    if (text.length > MEMORY_MAX_LENGTH) {
        throw new MemoryValidationError(`Memory content is too long (max ${MEMORY_MAX_LENGTH} characters).`);
    }
    if (!MEMORY_TYPES.has(type)) {
        throw new MemoryValidationError(`Memory type must be one of: ${[...MEMORY_TYPES].join(', ')}.`);
    }
    if (containsCredential(text)) {
        throw new MemoryValidationError('Refusing to store passwords, API keys, tokens, or credentials in memory.');
    }
    return text;
}

function isExpired(row, now = Date.now()) {
    return !Number.isFinite(row.created_at) || row.created_at < now - MEMORY_RETENTION_MS;
}

// One consistent shape for v1 and v2 documents. v1 rows predate provenance,
// so their source is reported as 'legacy' and they are never "verified".
function normalizeMemory(row) {
    return {
        id: row.id,
        guildId: row.guildId,
        userId: row.userId,
        content: row.content,
        type: row.type,
        scope: row.scope || 'personal',
        source: row.source || 'legacy',
        verified: row.verified === true,
        created_at: row.created_at,
        updated_at: Number.isFinite(row.updated_at) ? row.updated_at : row.created_at,
        expires_at: Number.isFinite(row.created_at) ? row.created_at + MEMORY_RETENTION_MS : null,
        schema_version: row.schema_version || 1
    };
}

// meta: { authorName, keyword, source } — passive-capture enrichment so
// cross-user context can say WHOSE memory it is and WHAT topic it belongs to.
// source: 'explicit' (the member asked) | 'auto-text' | 'auto-voice'.
async function remember(guildId, userId, content, type = 'fact', meta = {}) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const text = validateMemoryContent(content, type);
    const source = meta.source === undefined ? 'auto-text' : meta.source;
    if (!MEMORY_SOURCES.has(source)) {
        throw new MemoryValidationError(`Memory source must be one of: ${[...MEMORY_SOURCES].join(', ')}.`);
    }
    if (source === 'explicit' && containsInstructionPayload(text)) {
        throw new MemoryValidationError('That reads like instructions to the bot, not a fact about you, so it was not saved.');
    }
    // Every save path honors the member's preference. A lookup failure throws
    // here, so nothing is written unless "on" is actually confirmed.
    const preference = await getMemoryPreference(owner.guildId, owner.userId);
    if (!preference.enabled) throw new MemoryDisabledError();
    try {
        // Idempotent for repeats: the same live text for the same member is
        // returned as-is instead of stored twice. (Two concurrent identical
        // writes can still both insert; there is no unique index on content.)
        const existing = await memories.findOne({ ...owner, content: text });
        if (existing && !isExpired(existing)) {
            noteMemoryReadOk();
            return { ...normalizeMemory(existing), duplicate: true };
        }

        const now = Date.now();
        const doc = {
            ...owner,
            content: text,
            type,
            author_name: meta.authorName ? String(meta.authorName).slice(0, 80) : null,
            keyword: meta.keyword ? String(meta.keyword).slice(0, 40) : null,
            created_at: now,
            expires_at: new Date(now + MEMORY_RETENTION_MS),
            updated_at: now,
            scope: 'personal',
            source,
            verified: source === 'explicit',
            schema_version: MEMORY_SCHEMA_VERSION
        };
        // Atomic sequence, same pattern as warning ids.
        doc.id = await nextSequence('memory_id');
        const inserted = await memories.insertOne(doc);
        if (inserted && inserted.acknowledged === false) {
            throw new Error('Memory write was not acknowledged by MongoDB.');
        }
        noteMemoryWriteOk();
        // Retention: prune anything older than the window. A prune failure
        // must never fail the save that just succeeded.
        try {
            await pruneOldMemories(owner.guildId);
        } catch (pruneError) {
            console.error(`[ZiGBoT MEMORY] Prune skipped: ${pruneError.message}`);
        }
        return { ...normalizeMemory(doc), duplicate: false };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// One memory, only if it belongs to this member in this guild and is still
// inside retention. Not found (or someone else's) is null, never an error.
async function getMemory(guildId, userId, id) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const numericId = validateMemoryId(id);
    try {
        const row = await memories.findOne({ ...owner, id: numericId });
        noteMemoryReadOk();
        return row && !isExpired(row) ? normalizeMemory(row) : null;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// Correct a memory's content/type in one atomic update. The owner filter is
// part of the query, so another member's id simply matches nothing (null).
// Provenance (source, created_at, verified) is preserved as written.
async function updateMemory(guildId, userId, id, { content, type, verified } = {}) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const numericId = validateMemoryId(id);
    try {
        const current = await getMemory(owner.guildId, owner.userId, numericId);
        if (!current) return null;
        const nextType = type === undefined ? current.type : type;
        const nextContent = validateMemoryContent(content === undefined ? current.content : content, nextType);
        if (content !== undefined && containsInstructionPayload(nextContent)) {
            throw new MemoryValidationError('That reads like instructions to the bot, not a fact about you, so it was not saved.');
        }
        const changes = { content: nextContent, type: nextType, updated_at: Date.now() };
        // A member correcting their own memory confirms it; provenance (source,
        // created_at) is still kept as originally written.
        if (verified === true) changes.verified = true;
        const updated = await memories.findOneAndUpdate(
            { ...owner, id: numericId, created_at: { $gte: Date.now() - MEMORY_RETENTION_MS } },
            { $set: changes },
            { returnDocument: 'after', includeResultMetadata: false }
        );
        if (!updated) return null; // expired or deleted between the two calls
        noteMemoryWriteOk();
        return normalizeMemory(updated);
    } catch (error) {
        if (!(error instanceof MemoryValidationError)) noteMemoryError(error);
        throw error;
    }
}

// ---- Per-member memory preference (memory_prefs collection) ----
// No document = memory ON (the behavior before preferences existed). Only a
// stored enabled === true or no document counts as on; anything else is off.
// Lookup failures THROW so every caller fails closed.
async function getMemoryPreference(guildId, userId) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    try {
        const row = await memoryPrefs.findOne(owner);
        noteMemoryReadOk();
        return {
            enabled: row ? row.enabled === true : true,
            stored: Boolean(row),
            updated_at: row && Number.isFinite(row.updated_at) ? row.updated_at : null
        };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function setMemoryPreference(guildId, userId, enabled) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    if (typeof enabled !== 'boolean') {
        throw new MemoryValidationError('Memory preference must be true or false.');
    }
    const now = Date.now();
    try {
        const result = await memoryPrefs.updateOne(
            owner,
            { $set: { enabled, updated_at: now }, $setOnInsert: { created_at: now } },
            { upsert: true }
        );
        if (result && result.acknowledged === false) {
            throw new Error('Memory preference write was not acknowledged by MongoDB.');
        }
        noteMemoryWriteOk();
        return { enabled, updated_at: now };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// Personal memories for a reply, ONLY when the member has memory on. The one
// gate for every reply retrieval path (text, voice, memory questions).
// Off -> { enabled: false, memories: null }; lookup failure -> throws.
async function recallIfEnabled(guildId, userId, limit = MEMORY_DEFAULT_LIMIT) {
    const preference = await getMemoryPreference(guildId, userId);
    if (!preference.enabled) return { enabled: false, memories: null };
    return { enabled: true, memories: await recall(guildId, userId, limit) };
}

function liveOwnerFilter(owner) {
    return { ...owner, created_at: { $gte: Date.now() - MEMORY_RETENTION_MS } };
}

// The member's own live memories, newest first, one page at a time. This is
// the member's view of their data, so it works whether memory is on or off.
async function listMemories(guildId, userId, { page = 1, pageSize = MEMORY_PAGE_SIZE } = {}) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const size = Math.max(1, Math.min(Math.floor(Number(pageSize)) || MEMORY_PAGE_SIZE, 25));
    const requested = Math.max(1, Math.floor(Number(page)) || 1);
    const filter = liveOwnerFilter(owner);
    try {
        const total = await memories.countDocuments(filter);
        const pages = Math.max(1, Math.ceil(total / size));
        const current = Math.min(requested, pages);
        const rows = await memories.find(filter)
            .sort({ created_at: -1, id: -1 })
            .skip((current - 1) * size)
            .limit(size)
            .toArray();
        noteMemoryReadOk();
        return { total, page: current, pages, pageSize: size, items: rows.map(normalizeMemory) };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive literal search over the member's own live memories. The
// query is escaped, so it can never act as a pattern or an operator.
async function searchMemories(guildId, userId, query, { limit = MEMORY_PAGE_SIZE } = {}) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const text = String(query ?? '').trim();
    if (!text || text.length > MEMORY_SEARCH_MAX_LENGTH) {
        throw new MemoryValidationError(`Search text must be 1-${MEMORY_SEARCH_MAX_LENGTH} characters.`);
    }
    const capped = Math.max(1, Math.min(Math.floor(Number(limit)) || MEMORY_PAGE_SIZE, 25));
    try {
        const rows = await memories.find({ ...liveOwnerFilter(owner), content: { $regex: escapeRegex(text), $options: 'i' } })
            .sort({ created_at: -1, id: -1 })
            .limit(capped + 1)
            .toArray();
        noteMemoryReadOk();
        return { items: rows.slice(0, capped).map(normalizeMemory), more: rows.length > capped };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// The member's own live memories for this server, newest first, capped at
// MEMORY_EXPORT_MAX. Content that looks like a credential (possible only in
// records written before the credential filter) is redacted, never exported.
async function exportMemories(guildId, userId) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const filter = liveOwnerFilter(owner);
    try {
        const total = await memories.countDocuments(filter);
        const rows = await memories.find(filter)
            .sort({ created_at: -1, id: -1 })
            .limit(MEMORY_EXPORT_MAX)
            .toArray();
        noteMemoryReadOk();
        const items = rows.map(normalizeMemory).map((memory) => (containsCredential(String(memory.content || ''))
            ? { ...memory, content: '[redacted: looked like a password, key, or token]' }
            : memory));
        return { total, items, truncated: total > items.length, limit: MEMORY_EXPORT_MAX };
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function recall(guildId, userId, limit = MEMORY_DEFAULT_LIMIT) {
    requireBrain();
    const capped = Math.max(1, Math.min(Number(limit) || MEMORY_DEFAULT_LIMIT, MEMORY_MAX_LIMIT));
    const cutoff = Date.now() - MEMORY_RETENTION_MS;
    try {
        const rows = await memories
            .find({ guildId: String(guildId), userId: String(userId), created_at: { $gte: cutoff } })
            .sort({ created_at: -1, id: -1 })
            .limit(capped)
            .toArray();
        noteMemoryReadOk();
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
        const count = await memories.countDocuments({
            guildId: String(guildId),
            userId: String(userId),
            created_at: { $gte: Date.now() - MEMORY_RETENTION_MS }
        });
        noteMemoryReadOk();
        return count;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// ---- Cross-user recent context + 1-month retention ----

// Deletes all memories older than the retention window (guild-scoped when a
// guildId is given). Returns the real deleted count.
async function pruneOldMemories(guildId = null) {
    requireBrain();
    const cutoff = Date.now() - MEMORY_RETENTION_MS;
    const filter = guildId
        ? { guildId: String(guildId), created_at: { $lt: cutoff } }
        : { created_at: { $lt: cutoff } };
    try {
        const result = await memories.deleteMany(filter);
        noteMemoryWriteOk();
        return result.deletedCount || 0;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

// Guild-wide memories across ALL users (newest first). This is what lets the
// bot reference one member's situation while talking to another ("how did
// your exam go?"). Memories are windowed to the retention period (30 days),
// whether or not they have a topic keyword.
async function recallRecent(guildId, { limit = 15, windowMs = MEMORY_RETENTION_MS, excludeUserId = null } = {}) {
    requireBrain();
    const capped = Math.max(1, Math.min(Number(limit) || 15, 50));
    const cutoff = Date.now() - (Number(windowMs) || MEMORY_RETENTION_MS);
    try {
        const rows = await memories
            .find({ guildId: String(guildId), created_at: { $gte: cutoff } })
            .sort({ created_at: -1, id: -1 })
            .limit(MEMORY_RECALL_RECENT_CAP)
            .toArray();
        noteMemoryReadOk();
        return rows
            .filter((row) => !excludeUserId || String(row.userId) !== String(excludeUserId))
            .slice(0, capped)
            .map(({ id, content, type, created_at, author_name, keyword }) => ({
                id,
                content,
                type,
                created_at,
                authorName: author_name || null,
                keyword: keyword || null
            }));
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function deleteMemoryById(guildId, userId, id) {
    requireBrain();
    const owner = ownerKey(guildId, userId);
    const numericId = validateMemoryId(id);
    try {
        const result = await memories.deleteOne({ ...owner, id: numericId });
        noteMemoryWriteOk();
        return result.deletedCount > 0;
    } catch (error) {
        noteMemoryError(error);
        throw error;
    }
}

async function deleteAllMemories(guildId, userId) {
    requireBrain();
    try {
        const result = await memories.deleteMany(ownerKey(guildId, userId));
        noteMemoryWriteOk();
        return result.deletedCount || 0;
    } catch (error) {
        if (!(error instanceof MemoryValidationError)) noteMemoryError(error);
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

async function listYtGreetedViewers(videoId) {
    if (!ytGreeted) throw new Error('Brain is not connected.');
    const rows = await ytGreeted.find({ videoId: String(videoId) }).toArray();
    return rows.map((row) => String(row.channelId));
}

async function recordYtGreetedViewer(videoId, channelId) {
    if (!ytGreeted) throw new Error('Brain is not connected.');
    const now = Date.now();
    await ytGreeted.updateOne(
        { videoId: String(videoId), channelId: String(channelId) },
        { $setOnInsert: { created_at: now, expires_at: new Date(now + 24 * 60 * 60 * 1000) } },
        { upsert: true }
    );
}

async function recordYtBan(videoId, channelId, banId, displayName = '') {
    if (!ytBans) throw new Error('Brain is not connected.');
    const now = Date.now();
    await ytBans.updateOne({ videoId: String(videoId), channelId: String(channelId) }, {
        $set: { banId: String(banId), displayName: String(displayName).slice(0, 100), created_at: now,
            expires_at: new Date(now + 24 * 60 * 60 * 1000) }
    }, { upsert: true });
}

async function getYtBanId(videoId, channelId) {
    if (!ytBans) throw new Error('Brain is not connected.');
    const row = await ytBans.findOne({ videoId: String(videoId), channelId: String(channelId) });
    if (!row || !row.banId || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) return null;
    return row.banId;
}

async function deleteYtBan(videoId, channelId) {
    if (!ytBans) throw new Error('Brain is not connected.');
    await ytBans.deleteOne({ videoId: String(videoId), channelId: String(channelId) });
}

async function listYtNoRoast(videoId) {
    if (!ytNoRoast) throw new Error('Brain is not connected.');
    const rows = await ytNoRoast.find({ videoId: String(videoId) }).toArray();
    const now = Date.now();
    return rows.filter((row) => !row.expires_at || new Date(row.expires_at).getTime() > now)
        .map((row) => String(row.channelId));
}

async function recordYtNoRoast(videoId, channelId) {
    if (!ytNoRoast) throw new Error('Brain is not connected.');
    const now = Date.now();
    await ytNoRoast.updateOne({ videoId: String(videoId), channelId: String(channelId) }, {
        $set: { created_at: now, expires_at: new Date(now + 24 * 60 * 60 * 1000) }
    }, { upsert: true });
}

async function deleteYtNoRoast(videoId, channelId) {
    if (!ytNoRoast) throw new Error('Brain is not connected.');
    await ytNoRoast.deleteOne({ videoId: String(videoId), channelId: String(channelId) });
}

/** Shared daily YouTube quota state. Date is always America/Los_Angeles. */
async function getYtQuotaLedger(pacificDate) {
    if (!ytQuota) throw new Error('Brain is not connected.');
    const row = await ytQuota.findOne({ pacificDate: String(pacificDate) });
    return row ? {
        usedUnits: Math.max(0, Number(row.usedUnits) || 0),
        exhausted: Boolean(row.exhausted),
        methods: row.methods && typeof row.methods === 'object' ? row.methods : {}
    } : null;
}

async function recordYtQuotaCall(pacificDate, method, units) {
    if (!ytQuota) throw new Error('Brain is not connected.');
    const now = Date.now();
    const safeMethod = String(method || 'unknown').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80) || 'unknown';
    const cost = Math.max(0, Number(units) || 0);
    await ytQuota.updateOne({ pacificDate: String(pacificDate) }, {
        $inc: { usedUnits: cost, [`methods.${safeMethod}.calls`]: 1, [`methods.${safeMethod}.units`]: cost },
        $set: { updated_at: now, expires_at: new Date(now + 3 * 24 * 60 * 60 * 1000) },
        $setOnInsert: { exhausted: false, created_at: now }
    }, { upsert: true });
}

async function markYtQuotaExhausted(pacificDate, budget) {
    if (!ytQuota) throw new Error('Brain is not connected.');
    const now = Date.now();
    await ytQuota.updateOne({ pacificDate: String(pacificDate) }, {
        $max: { usedUnits: Math.max(0, Number(budget) || 0) },
        $set: { exhausted: true, updated_at: now, expires_at: new Date(now + 3 * 24 * 60 * 60 * 1000) },
        $setOnInsert: { created_at: now, methods: {} }
    }, { upsert: true });
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
        lastError: lastMemoryError,
        lastWriteOkAt: lastMemoryWriteOkAt,
        lastReadOkAt: lastMemoryReadOkAt
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
    memoryPrefs = null;
    behaviors = null;
    ytGreeted = null;
    ytBans = null;
    ytNoRoast = null;
    ytQuota = null;
    lastMemoryError = null;
    lastBehaviorError = null;
    lastMemoryWriteOkAt = null;
    lastMemoryReadOkAt = null;
}

module.exports = {
    connectBrain,
    getUser,
    updateUser,
    addWarning,
    listWarnings,
    countWarnings,
    remember,
    getMemory,
    updateMemory,
    getMemoryPreference,
    setMemoryPreference,
    recallIfEnabled,
    listMemories,
    searchMemories,
    exportMemories,
    containsInstructionPayload,
    recall,
    recallRecent,
    pruneOldMemories,
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
    listYtGreetedViewers,
    recordYtGreetedViewer,
    recordYtBan,
    getYtBanId,
    deleteYtBan,
    listYtNoRoast,
    recordYtNoRoast,
    deleteYtNoRoast,
    getYtQuotaLedger,
    recordYtQuotaCall,
    markYtQuotaExhausted,
    tierFromScore,
    scoreEvents,
    MemoryValidationError,
    MemoryDisabledError,
    MEMORY_MAX_LENGTH,
    MEMORY_SEARCH_MAX_LENGTH,
    MEMORY_EXPORT_MAX,
    MEMORY_RETENTION_MS,
    MEMORY_SCHEMA_VERSION,
    _disconnectForTests
};
