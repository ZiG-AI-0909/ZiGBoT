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

async function connectBrain(uri, { client: injectedClient = null } = {}) {
    if (!uri) {
        throw new Error('connectBrain requires a MongoDB URI (set MONGODB_URI)');
    }
    client = injectedClient || new MongoClient(uri);
    await client.connect();

    const db = client.db('zigbot');
    users = db.collection('users');
    warnings = db.collection('warnings');
    counters = db.collection('counters');

    await users.createIndex({ userId: 1 }, { unique: true });
    // Same lookup pattern as the old idx_warnings_guild_user SQLite index.
    await warnings.createIndex({ guildId: 1, userId: 1, created_at: 1 });

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

module.exports = { connectBrain, getUser, updateUser, addWarning, listWarnings, countWarnings };
