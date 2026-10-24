const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

// Real-MongoDB integration tests for the Phase 1 memory data layer.
// Runs ONLY when MONGODB_TEST_URI points at a disposable test deployment.
// Every run uses its own random zigbot_test_* database and drops only that
// database afterwards — production's `zigbot` database is never opened.
// The URI is never printed.
const brain = require('../src/db/brain');

const TEST_URI = process.env.MONGODB_TEST_URI || '';
const skipReason = !TEST_URI
    ? 'MONGODB_TEST_URI is not set (integration tests need a disposable MongoDB)'
    : TEST_URI === process.env.MONGODB_URI
        ? 'MONGODB_TEST_URI equals MONGODB_URI; refusing to run against the production connection'
        : false;

const DB_NAME = `zigbot_test_${crypto.randomBytes(6).toString('hex')}`;
const CLIENT_OPTIONS = { serverSelectionTimeoutMS: 10_000 };
const openClients = [];

function newClient() {
    const client = new MongoClient(TEST_URI, CLIENT_OPTIONS);
    openClients.push(client);
    return client;
}

async function connectFresh() {
    brain._disconnectForTests();
    const client = newClient();
    await brain.connectBrain(TEST_URI, { client, dbName: DB_NAME });
    return client;
}

test('memory data layer against a real MongoDB test database', { skip: skipReason }, async (t) => {
    assert.match(DB_NAME, /^zigbot_test_[0-9a-f]{12}$/);
    assert.notEqual(DB_NAME, 'zigbot');

    t.after(async () => {
        brain._disconnectForTests();
        const cleaner = newClient();
        try {
            await cleaner.connect();
            // Only ever drop the database this run created.
            if (DB_NAME.startsWith('zigbot_test_')) await cleaner.db(DB_NAME).dropDatabase();
        } finally {
            await Promise.all(openClients.map((client) => client.close().catch(() => {})));
        }
    });

    const firstClient = await connectFresh();

    await t.test('real driver counters: remember and addWarning get sequential ids', async () => {
        const a = await brain.remember('g1', 'u1', 'integration memory one', 'fact', { source: 'explicit' });
        const b = await brain.remember('g1', 'u1', 'integration memory two', 'preference');
        assert.equal(b.id, a.id + 1);
        const w1 = await brain.addWarning('g1', 'u1', 'integration warning', 'mod');
        const w2 = await brain.addWarning('g1', 'u1', 'integration warning 2', 'mod');
        assert.equal(w2.id, w1.id + 1);
        assert.equal(await brain.countWarnings('g1', 'u1'), 2);
    });

    await t.test('schema v2 fields are persisted', async () => {
        const raw = await firstClient.db(DB_NAME).collection('memories').findOne({ content: 'integration memory one' });
        assert.equal(raw.schema_version, 2);
        assert.equal(raw.source, 'explicit');
        assert.equal(raw.verified, true);
        assert.equal(raw.scope, 'personal');
        assert.ok(raw.expires_at instanceof Date);
    });

    await t.test('duplicate, update, and owner scoping on the real server', async () => {
        const original = await brain.remember('g1', 'u1', 'integration dedupe check');
        const again = await brain.remember('g1', 'u1', 'integration dedupe check');
        assert.equal(again.duplicate, true);
        assert.equal(again.id, original.id);

        const updated = await brain.updateMemory('g1', 'u1', original.id, { content: 'integration dedupe check (corrected)' });
        assert.equal(updated.content, 'integration dedupe check (corrected)');
        assert.equal(updated.created_at, original.created_at);

        assert.equal(await brain.getMemory('g1', 'u2', original.id), null);
        assert.equal(await brain.getMemory('g2', 'u1', original.id), null);
        assert.equal(await brain.updateMemory('g1', 'u2', original.id, { content: 'hijack' }), null);
        assert.equal(await brain.deleteMemoryById('g2', 'u1', original.id), false);
        assert.equal((await brain.getMemory('g1', 'u1', original.id)).content, 'integration dedupe check (corrected)');
    });

    await t.test('memories survive a fresh client connection (simulated restart)', async () => {
        const before = await brain.recall('g1', 'u1', 20);
        assert.ok(before.length >= 3);
        brain._disconnectForTests();
        await firstClient.close();

        await connectFresh();
        const after = await brain.recall('g1', 'u1', 20);
        assert.deepEqual(after.map((m) => m.id), before.map((m) => m.id));
        assert.deepEqual(after.map((m) => m.content), before.map((m) => m.content));
        assert.equal(await brain.countWarnings('g1', 'u1'), 2);
    });

    await t.test('memory preferences persist, are unique per member+server, and gate saves', async () => {
        await brain.setMemoryPreference('g1', 'pref-user', false);
        await brain.setMemoryPreference('g1', 'pref-user', false);
        const prefs = await openClients.at(-1).db(DB_NAME).collection('memory_prefs').find({ userId: 'pref-user' }).toArray();
        assert.equal(prefs.length, 1, 'upsert must not create duplicates');
        await assert.rejects(() => brain.remember('g1', 'pref-user', 'blocked while off'), brain.MemoryDisabledError);
        assert.deepEqual(await brain.recallIfEnabled('g1', 'pref-user'), { enabled: false, memories: null });
        await brain.setMemoryPreference('g1', 'pref-user', true);
        assert.equal((await brain.recallIfEnabled('g1', 'pref-user')).enabled, true);
    });

    await t.test('search runs as a literal, case-insensitive query on the real server', async () => {
        await brain.remember('g1', 'search-user', 'I enjoy C++ (and Rust)', 'preference', { source: 'explicit' });
        const literal = await brain.searchMemories('g1', 'search-user', 'c++ (AND');
        assert.equal(literal.items.length, 1);
        const wildcard = await brain.searchMemories('g1', 'search-user', '.*');
        assert.equal(wildcard.items.length, 0);
    });

    await t.test('deletes are real and counted truthfully', async () => {
        const target = await brain.remember('g1', 'u1', 'integration delete me');
        assert.equal(await brain.deleteMemoryById('g1', 'u1', target.id), true);
        assert.equal(await brain.getMemory('g1', 'u1', target.id), null);
        const remaining = await brain.countMemories('g1', 'u1');
        assert.equal(await brain.deleteAllMemories('g1', 'u1'), remaining);
        assert.equal(await brain.countMemories('g1', 'u1'), 0);
    });
});
