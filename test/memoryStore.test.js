const test = require('node:test');
const assert = require('node:assert/strict');

// Phase 1 memory data layer: schema v2, owner-scoped CRUD, validation, and the
// MongoDB driver v7 findOneAndUpdate regression (returns the document itself,
// not { value }). The fake below follows driver v7 return shapes on purpose.
const brain = require('../src/db/brain');

function matches(doc, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
            if (expected.$lt !== undefined && !(doc[key] < expected.$lt)) return false;
            if (expected.$gte !== undefined && !(doc[key] >= expected.$gte)) return false;
            return Object.keys(expected).every((op) => op === '$lt' || op === '$gte');
        }
        return doc[key] === expected;
    });
}

function v7Client({ legacyFindOneAndUpdate = false } = {}) {
    const collections = new Map();
    const usedDbNames = [];
    function collection(name) {
        if (collections.has(name)) return collections.get(name);
        const docs = [];
        const store = {
            docs,
            async createIndex() { return 'idx'; },
            async insertOne(doc) { docs.push({ ...doc }); return { acknowledged: true }; },
            async findOne(filter) {
                const doc = docs.find((d) => matches(d, filter));
                return doc ? { ...doc } : null;
            },
            async updateOne(filter, update, options = {}) {
                let doc = docs.find((d) => matches(d, filter));
                if (!doc && options.upsert) { doc = { ...filter }; docs.push(doc); }
                if (doc && update.$set) Object.assign(doc, update.$set);
                return { matchedCount: doc ? 1 : 0 };
            },
            async countDocuments(filter) { return docs.filter((d) => matches(d, filter)).length; },
            async deleteOne(filter) {
                const index = docs.findIndex((d) => matches(d, filter));
                if (index < 0) return { deletedCount: 0 };
                docs.splice(index, 1);
                return { deletedCount: 1 };
            },
            async deleteMany(filter) {
                const keep = docs.filter((d) => !matches(d, filter));
                const deletedCount = docs.length - keep.length;
                docs.splice(0, docs.length, ...keep);
                return { deletedCount };
            },
            find(filter) {
                let sortSpec = {};
                let limitCount = 0;
                return {
                    sort(spec) { sortSpec = spec; return this; },
                    limit(n) { limitCount = n; return this; },
                    async toArray() {
                        const rows = docs.filter((d) => matches(d, filter)).map((d) => ({ ...d }));
                        rows.sort((a, b) => {
                            for (const [key, dir] of Object.entries(sortSpec)) {
                                if (a[key] !== b[key]) return (a[key] - b[key]) * dir;
                            }
                            return 0;
                        });
                        return limitCount > 0 ? rows.slice(0, limitCount) : rows;
                    }
                };
            },
            async findOneAndUpdate(filter, update, options = {}) {
                let doc = docs.find((d) => matches(d, filter));
                const before = doc ? { ...doc } : null;
                if (!doc && options.upsert) {
                    doc = Object.fromEntries(Object.entries(filter).filter(([, v]) => v === null || typeof v !== 'object'));
                    docs.push(doc);
                }
                if (doc && update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
                if (doc && update.$set) Object.assign(doc, update.$set);
                const value = doc && options.returnDocument === 'after' ? { ...doc } : before;
                // Driver v5 shape, only to prove the old destructuring is gone.
                if (legacyFindOneAndUpdate) return { value, ok: 1 };
                return options.includeResultMetadata ? { value, ok: 1 } : value;
            }
        };
        collections.set(name, store);
        return store;
    }
    return {
        collections,
        usedDbNames,
        collection,
        db(name) { usedDbNames.push(name); return { collection }; },
        async connect() {}
    };
}

async function connect(client = v7Client(), options = {}) {
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client, ...options });
    return client;
}

// ---------- Driver v7 regression: counters ----------

test('remember and addWarning work with driver v7 findOneAndUpdate (document, not { value })', async () => {
    const client = await connect();
    const first = await brain.remember('g1', 'u1', 'likes chess');
    const second = await brain.remember('g1', 'u1', 'lives in Pune');
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);

    const warning1 = await brain.addWarning('g1', 'u1', 'spam', 'mod-1');
    const warning2 = await brain.addWarning('g1', 'u1', 'flood', 'mod-1');
    assert.equal(warning1.id, 1);
    assert.equal(warning2.id, 2);
    assert.equal(await brain.countWarnings('g1', 'u1'), 2);
    assert.deepEqual((await brain.listWarnings('g1', 'u1')).map((w) => w.reason), ['spam', 'flood']);
    assert.equal(client.collections.get('counters').docs.find((c) => c._id === 'memory_id').seq, 2);
});

test('a counter result without seq fails loudly instead of storing an id-less record', async () => {
    const client = await connect(v7Client({ legacyFindOneAndUpdate: true }));
    await assert.rejects(() => brain.remember('g', 'u', 'should not store'), /returned no sequence value/);
    await assert.rejects(() => brain.addWarning('g', 'u', 'r', 'mod'), /returned no sequence value/);
    assert.equal(client.collections.get('memories').docs.length, 0);
    assert.equal(client.collections.get('warnings').docs.length, 0);
    assert.match(brain.getMemoryStatus().lastError, /no sequence value/);
});

// ---------- Schema v2 ----------

test('new memories carry the additive schema v2 fields', async () => {
    const client = await connect();
    const saved = await brain.remember('g', 'u', 'prefers short answers', 'preference', { source: 'explicit' });
    assert.equal(saved.duplicate, false);
    assert.equal(saved.verified, true, 'explicit saves are verified');
    assert.equal(saved.source, 'explicit');
    assert.equal(saved.scope, 'personal');
    assert.equal(saved.schema_version, 2);

    const [doc] = client.collections.get('memories').docs;
    assert.equal(doc.schema_version, 2);
    assert.equal(doc.scope, 'personal');
    assert.equal(doc.source, 'explicit');
    assert.equal(doc.verified, true);
    assert.equal(doc.updated_at, doc.created_at);
    assert.ok(doc.expires_at instanceof Date);
    // v1 fields are still written, so the existing recall/prompt paths are unchanged.
    for (const field of ['id', 'guildId', 'userId', 'content', 'type', 'author_name', 'keyword', 'created_at']) {
        assert.ok(field in doc, `missing ${field}`);
    }
});

test('automatic sources default to auto-text and are never verified; unknown sources are rejected', async () => {
    await connect();
    const auto = await brain.remember('g', 'u', 'my exam is on monday', 'event');
    assert.equal(auto.source, 'auto-text');
    assert.equal(auto.verified, false);
    const voice = await brain.remember('g', 'u', 'i love biryani', 'preference', { source: 'auto-voice' });
    assert.equal(voice.source, 'auto-voice');
    assert.equal(voice.verified, false);
    await assert.rejects(() => brain.remember('g', 'u', 'x is y', 'fact', { source: 'ai-tool' }), brain.MemoryValidationError);
    await assert.rejects(() => brain.remember('g', 'u', 'x is y', 'fact', { source: 'legacy' }), brain.MemoryValidationError);
});

// ---------- Validation ----------

test('oversized content is rejected (not truncated) and nothing is stored', async () => {
    const client = await connect();
    const tooLong = 'a'.repeat(brain.MEMORY_MAX_LENGTH + 1);
    await assert.rejects(() => brain.remember('g', 'u', tooLong), (error) => {
        assert.ok(error instanceof brain.MemoryValidationError);
        assert.equal(error.code, 'MEMORY_INVALID');
        assert.ok(!error.message.includes(tooLong), 'error must not echo the content');
        return true;
    });
    assert.equal(client.collections.get('memories').docs.length, 0);
    const exact = await brain.remember('g', 'u', 'b'.repeat(brain.MEMORY_MAX_LENGTH));
    assert.equal(exact.content.length, brain.MEMORY_MAX_LENGTH);
});

test('missing or oversized owner ids are rejected before touching the database', async () => {
    const client = await connect();
    await assert.rejects(() => brain.remember('', 'u', 'content'), brain.MemoryValidationError);
    await assert.rejects(() => brain.remember('g', null, 'content'), brain.MemoryValidationError);
    await assert.rejects(() => brain.remember('g', 'x'.repeat(65), 'content'), brain.MemoryValidationError);
    await assert.rejects(() => brain.getMemory('g', '', 1), brain.MemoryValidationError);
    await assert.rejects(() => brain.getMemory('g', 'u', 0), /positive number/);
    await assert.rejects(() => brain.updateMemory('g', 'u', 'abc', { content: 'x' }), /positive number/);
    assert.equal(client.collections.get('memories').docs.length, 0);
    assert.equal(brain.getMemoryStatus().lastError, null, 'validation errors are not database errors');
});

test('validation failures are not recorded as database errors', async () => {
    await connect();
    await assert.rejects(() => brain.remember('g', 'u', 'password: hunter2'), /credentials/);
    await assert.rejects(() => brain.remember('g', 'u', 'ok', 'nope'), brain.MemoryValidationError);
    assert.equal(brain.getMemoryStatus().lastError, null);
});

// ---------- Duplicates ----------

test('saving the same live content twice is idempotent per member', async () => {
    const client = await connect();
    const first = await brain.remember('g', 'u', 'call me Ace', 'fact');
    const again = await brain.remember('g', 'u', '  call me Ace  ', 'fact');
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(await brain.countMemories('g', 'u'), 1);

    // Same text from a different member or guild is a separate memory.
    const other = await brain.remember('g', 'u2', 'call me Ace', 'fact');
    const otherGuild = await brain.remember('g2', 'u', 'call me Ace', 'fact');
    assert.notEqual(other.id, first.id);
    assert.notEqual(otherGuild.id, first.id);
    assert.equal(client.collections.get('memories').docs.length, 3);
});

test('an expired duplicate does not block a fresh save', async () => {
    const client = await connect();
    const old = await brain.remember('g', 'u', 'repeat me');
    // Age the record past retention directly in the backing store.
    client.collections.get('memories').docs[0].created_at = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const fresh = await brain.remember('g', 'u', 'repeat me');
    assert.equal(fresh.duplicate, false);
    assert.notEqual(fresh.id, old.id);
});

// ---------- Owner-scoped read ----------

test('getMemory returns only the owner\'s record; others, missing and expired are null', async () => {
    const client = await connect();
    const mine = await brain.remember('g1', 'u1', 'my private memory');
    const fetched = await brain.getMemory('g1', 'u1', mine.id);
    assert.equal(fetched.content, 'my private memory');
    assert.equal(fetched.userId, 'u1');

    assert.equal(await brain.getMemory('g1', 'u2', mine.id), null, 'another user cannot read it');
    assert.equal(await brain.getMemory('g2', 'u1', mine.id), null, 'another guild cannot read it');
    assert.equal(await brain.getMemory('g1', 'u1', 9999), null, 'missing id is null, not an error');
    // Operator-shaped ids are stringified, so they can never widen the filter.
    assert.equal(await brain.getMemory('g1', { $ne: null }, mine.id), null);

    client.collections.get('memories').docs[0].created_at = Date.now() - 31 * 24 * 60 * 60 * 1000;
    assert.equal(await brain.getMemory('g1', 'u1', mine.id), null, 'expired is treated as gone');
});

test('legacy v1 documents are read without being rewritten', async () => {
    const client = await connect();
    const legacy = { id: 77, guildId: 'g', userId: 'u', content: 'old style memory', type: 'fact', author_name: 'Old', keyword: null, created_at: Date.now() - 1000 };
    client.collections.get('memories').docs.push({ ...legacy });

    const read = await brain.getMemory('g', 'u', 77);
    assert.equal(read.schema_version, 1);
    assert.equal(read.source, 'legacy');
    assert.equal(read.verified, false);
    assert.equal(read.scope, 'personal');
    assert.equal(read.updated_at, legacy.created_at);
    assert.deepEqual(client.collections.get('memories').docs[0], legacy, 'reading must not modify the document');

    // The existing recall shape is unchanged for both v1 and v2 records.
    await brain.remember('g', 'u', 'new style memory');
    const recalled = await brain.recall('g', 'u', 10);
    assert.deepEqual(Object.keys(recalled[0]).sort(), ['content', 'created_at', 'id', 'type']);
    assert.deepEqual(recalled.map((m) => m.content), ['old style memory', 'new style memory']);
});

// ---------- Owner-scoped update ----------

test('updateMemory corrects the owner\'s memory atomically and preserves provenance', async () => {
    const client = await connect();
    const saved = await brain.remember('g', 'u', 'i live in Pune', 'fact');
    const storedBefore = { ...client.collections.get('memories').docs[0] };
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await brain.updateMemory('g', 'u', saved.id, { content: 'i live in Mumbai' });
    assert.equal(updated.content, 'i live in Mumbai');
    assert.equal(updated.type, 'fact');
    assert.equal(updated.created_at, storedBefore.created_at);
    assert.equal(updated.source, 'auto-text');
    assert.equal(updated.verified, false);
    assert.ok(updated.updated_at > storedBefore.updated_at);

    const retyped = await brain.updateMemory('g', 'u', saved.id, { type: 'preference' });
    assert.equal(retyped.type, 'preference');
    assert.equal(retyped.content, 'i live in Mumbai');
    assert.equal(client.collections.get('memories').docs.length, 1, 'no copy is created');
});

test('updateMemory cannot touch another member\'s or another guild\'s memory', async () => {
    const client = await connect();
    const victim = await brain.remember('g1', 'victim', 'victim memory');
    const snapshot = JSON.stringify(client.collections.get('memories').docs);

    assert.equal(await brain.updateMemory('g1', 'attacker', victim.id, { content: 'hacked' }), null);
    assert.equal(await brain.updateMemory('g2', 'victim', victim.id, { content: 'hacked' }), null);
    assert.equal(await brain.updateMemory('g1', 'victim', 424242, { content: 'hacked' }), null);
    assert.equal(JSON.stringify(client.collections.get('memories').docs), snapshot);
});

test('updateMemory rejects invalid input and leaves the record unchanged', async () => {
    const client = await connect();
    const saved = await brain.remember('g', 'u', 'valid memory');
    const snapshot = JSON.stringify(client.collections.get('memories').docs);
    await assert.rejects(() => brain.updateMemory('g', 'u', saved.id, { content: '   ' }), brain.MemoryValidationError);
    await assert.rejects(() => brain.updateMemory('g', 'u', saved.id, { content: 'x'.repeat(501) }), brain.MemoryValidationError);
    await assert.rejects(() => brain.updateMemory('g', 'u', saved.id, { content: 'my token: abc123' }), /credentials/);
    await assert.rejects(() => brain.updateMemory('g', 'u', saved.id, { type: 'secret' }), brain.MemoryValidationError);
    assert.equal(JSON.stringify(client.collections.get('memories').docs), snapshot);
});

test('updateMemory on an expired record returns null and writes nothing', async () => {
    const client = await connect();
    const saved = await brain.remember('g', 'u', 'stale memory');
    client.collections.get('memories').docs[0].created_at = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const snapshot = JSON.stringify(client.collections.get('memories').docs);
    assert.equal(await brain.updateMemory('g', 'u', saved.id, { content: 'new' }), null);
    assert.equal(JSON.stringify(client.collections.get('memories').docs), snapshot);
});

// ---------- Owner-scoped delete ----------

test('deletes are owner- and guild-scoped', async () => {
    await connect();
    const saved = await brain.remember('g1', 'u1', 'delete scope test');
    assert.equal(await brain.deleteMemoryById('g2', 'u1', saved.id), false);
    assert.equal(await brain.deleteMemoryById('g1', 'u2', saved.id), false);
    assert.equal(await brain.deleteAllMemories('g2', 'u1'), 0);
    assert.equal(await brain.deleteAllMemories('g1', 'u2'), 0);
    assert.ok(await brain.getMemory('g1', 'u1', saved.id));
    assert.equal(await brain.deleteMemoryById('g1', 'u1', saved.id), true);
    assert.equal(await brain.getMemory('g1', 'u1', saved.id), null);
    await assert.rejects(() => brain.deleteAllMemories('', 'u1'), brain.MemoryValidationError);
});

// ---------- Failure vs. empty, and honest status ----------

test('database failures throw and are recorded; they are never reported as "not found"', async () => {
    const client = v7Client();
    await connect(client);
    const saved = await brain.remember('g', 'u', 'exists before outage');
    const memories = client.collections.get('memories');
    for (const method of ['findOne', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'insertOne']) {
        memories[method] = async () => { throw new Error('server selection timed out'); };
    }
    await assert.rejects(() => brain.getMemory('g', 'u', saved.id), /timed out/);
    await assert.rejects(() => brain.updateMemory('g', 'u', saved.id, { content: 'x' }), /timed out/);
    await assert.rejects(() => brain.deleteMemoryById('g', 'u', saved.id), /timed out/);
    await assert.rejects(() => brain.remember('g', 'u', 'new during outage'), /timed out/);
    assert.match(brain.getMemoryStatus().lastError, /timed out/);
});

test('status separates "connected" from a real successful write and read', async () => {
    await connect();
    let status = brain.getMemoryStatus();
    assert.equal(status.connected, true);
    assert.equal(status.lastWriteOkAt, null, 'connecting is not a successful write');
    assert.equal(status.lastReadOkAt, null, 'connecting is not a successful read');

    await brain.remember('g', 'u', 'status probe');
    status = brain.getMemoryStatus();
    assert.ok(Number.isFinite(status.lastWriteOkAt));

    await brain.recall('g', 'u');
    status = brain.getMemoryStatus();
    assert.ok(Number.isFinite(status.lastReadOkAt));

    brain._disconnectForTests();
    status = brain.getMemoryStatus();
    assert.equal(status.lastWriteOkAt, null);
    assert.equal(status.lastReadOkAt, null);
});

// ---------- Existing data is untouched ----------

test('memory CRUD never touches users, warnings, or behavior records', async () => {
    const client = v7Client();
    const user = { userId: 'u', warnings: [], xp: 42, notes: { mod: 'keep me' } };
    const warning = { id: 5, guildId: 'g', userId: 'u', reason: 'old warning', issued_by: 'm', created_at: 1 };
    const behavior = { guildId: 'g', userId: 'u', signal: 'kind', kind: 'positive', source: 'x', note: null, created_at: Date.now() };
    client.collection('users').docs.push({ ...user });
    client.collection('warnings').docs.push({ ...warning });
    client.collection('behaviors').docs.push({ ...behavior });
    await connect(client);

    const saved = await brain.remember('g', 'u', 'crud isolation check');
    await brain.getMemory('g', 'u', saved.id);
    await brain.updateMemory('g', 'u', saved.id, { content: 'crud isolation check v2' });
    await brain.deleteMemoryById('g', 'u', saved.id);
    await brain.remember('g', 'u', 'another one');
    await brain.deleteAllMemories('g', 'u');

    assert.deepEqual(client.collections.get('users').docs, [user]);
    assert.deepEqual(client.collections.get('warnings').docs, [warning]);
    assert.deepEqual(client.collections.get('behaviors').docs, [behavior]);
});

// ---------- Database name and logging ----------

test('connectBrain uses "zigbot" by default and an explicit dbName when given', async () => {
    const defaultClient = await connect();
    assert.deepEqual(defaultClient.usedDbNames, ['zigbot']);
    const testClient = await connect(v7Client(), { dbName: 'zigbot_test_abc123' });
    assert.deepEqual(testClient.usedDbNames, ['zigbot_test_abc123']);
    brain._disconnectForTests();
    await assert.rejects(() => brain.connectBrain('mongodb://fake', { client: v7Client(), dbName: 'bad name!' }), /dbName/);
    await assert.rejects(() => brain.connectBrain('mongodb://fake', { client: v7Client(), dbName: '' }), /dbName/);
});

test('memory content never appears in logs, including on failures', async () => {
    const secretText = 'my very private memory text 9f3a';
    const logged = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const level of Object.keys(originals)) console[level] = (...args) => logged.push(args.join(' '));
    try {
        const client = v7Client();
        await connect(client);
        const saved = await brain.remember('g', 'u', secretText);
        await brain.updateMemory('g', 'u', saved.id, { content: `${secretText} edited` });
        // Prune failure path logs; it must not include content.
        client.collections.get('memories').deleteMany = async () => { throw new Error('prune failed'); };
        await brain.remember('g', 'u', `${secretText} again`);
        await assert.rejects(() => brain.remember('g', 'u', `${secretText} password: hunter2`));
    } finally {
        Object.assign(console, originals);
    }
    assert.ok(logged.every((line) => !line.includes('9f3a')), 'memory text leaked into logs');
});

// ---------- MEMORY_AUTO_CAPTURE ----------

test('MEMORY_AUTO_CAPTURE defaults to off and only "true" turns it on', () => {
    const { loadSettings } = require('../src/config/settings');
    const saved = { token: process.env.DISCORD_TOKEN, key: process.env.NVIDIA_API_KEY, capture: process.env.MEMORY_AUTO_CAPTURE };
    process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'mock-token';
    process.env.NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || 'mock-key';
    try {
        delete process.env.MEMORY_AUTO_CAPTURE;
        assert.equal(loadSettings().memoryAutoCapture, false);
        for (const value of ['', 'false', '1', 'yes', 'TRUE ']) {
            process.env.MEMORY_AUTO_CAPTURE = value;
            assert.equal(loadSettings().memoryAutoCapture, false, `"${value}" must not enable capture`);
        }
        process.env.MEMORY_AUTO_CAPTURE = 'true';
        assert.equal(loadSettings().memoryAutoCapture, true);
    } finally {
        for (const [name, value] of [['DISCORD_TOKEN', saved.token], ['NVIDIA_API_KEY', saved.key], ['MEMORY_AUTO_CAPTURE', saved.capture]]) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});
