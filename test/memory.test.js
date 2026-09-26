const test = require('node:test');
const assert = require('node:assert/strict');

// IMPORTANT: one shared brain module instance for the whole file. The tools
// router captures `require('../src/db/brain')` at load time, so tests must
// toggle the SAME module's state via _disconnectForTests() + connectBrain()
// rather than reloading the module (which would desync the router).
const brain = require('../src/db/brain');
const { executeTool, isAuthorizedActor } = require('../src/tools/router');
const {
    buildMemoryContextBlock,
    buildServerContextBlock,
    extractTopicKeyword,
    extractPassiveMemory,
    isMemoryQuestion,
    buildMemoryAnswer,
    shouldRemember
} = require('../src/ai/client');

// ---------- Fake Mongo client (same surface the p3 suite uses) ----------

// Filter matcher with the operator subset brain.js uses: plain equality,
// { $lt / $gte } range operators, and Mongo's "query null matches missing
// field" semantics (used by the keyword-permanence filter).
function matchesFilter(doc, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (expected !== null && typeof expected === 'object') {
            if (expected.$lt !== undefined && !(doc[key] < expected.$lt)) return false;
            if (expected.$lte !== undefined && !(doc[key] <= expected.$lte)) return false;
            if (expected.$gt !== undefined && !(doc[key] > expected.$gt)) return false;
            if (expected.$gte !== undefined && !(doc[key] >= expected.$gte)) return false;
            return true;
        }
        if (expected === null) return doc[key] === null || doc[key] === undefined;
        return doc[key] === expected;
    });
}

function fakeMongoClient() {
    const collections = new Map();
    const createdIndexes = [];

    function collection(name) {
        if (!collections.has(name)) {
            const docs = [];
            const store = {
                docs,
                async createIndex(spec) {
                    createdIndexes.push({ name, spec });
                    return `${name}_idx_${createdIndexes.length}`;
                },
                async insertOne(doc) {
                    docs.push({ ...doc });
                    return { insertedId: doc._id ?? null };
                },
                async findOne(filter) {
                    const doc = docs.find((d) => matchesFilter(d, filter));
                    return doc ? { ...doc } : null;
                },
                async updateOne(filter, update) {
                    let doc = docs.find((d) => matchesFilter(d, filter));
                    if (!doc) {
                        doc = { ...filter };
                        docs.push(doc);
                    }
                    if (update.$set) {
                        for (const [k, v] of Object.entries(update.$set)) doc[k] = v;
                    }
                    return { matchedCount: 1 };
                },
                async countDocuments(filter) {
                    return docs.filter((d) => matchesFilter(d, filter)).length;
                },
                async deleteOne(filter) {
                    const index = docs.findIndex((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    if (index >= 0) {
                        docs.splice(index, 1);
                        return { deletedCount: 1 };
                    }
                    return { deletedCount: 0 };
                },
                async deleteMany(filter) {
                    const keep = docs.filter((d) => !matchesFilter(d, filter));
                    const deleted = docs.length - keep.length;
                    docs.length = 0;
                    docs.push(...keep);
                    return { deletedCount: deleted };
                },
                find(filter) {
                    const matches = () => docs.filter((d) => matchesFilter(d, filter));
                    let sortKeys = {};
                    let limitCount = 0;
                    return {
                        sort(spec) { sortKeys = spec; return this; },
                        limit(n) { limitCount = n; return this; },
                        async toArray() {
                            const rows = matches().map((d) => ({ ...d }));
                            const entries = Object.entries(sortKeys);
                            if (entries.length > 0) {
                                rows.sort((a, b) => {
                                    for (const [key, dir] of entries) {
                                        if (a[key] !== b[key]) return (a[key] - b[key]) * dir;
                                    }
                                    return 0;
                                });
                            }
                            return limitCount > 0 ? rows.slice(0, limitCount) : rows;
                        }
                    };
                },
                async findOneAndUpdate(filter, update) {
                    let doc = docs.find((d) => matchesFilter(d, filter));
                    if (!doc) {
                        doc = { ...filter };
                        docs.push(doc);
                    }
                    if (update.$inc) {
                        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
                    }
                    return { value: { ...doc } };
                }
            };
            collections.set(name, store);
        }
        return collections.get(name);
    }

    return {
        createdIndexes,
        collections,
        db() { return { collection }; },
        async connect() {}
    };
}

// Connects the ONE shared brain module to a (fake) database.
async function connectTestBrain(client = fakeMongoClient()) {
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client });
    return client;
}

// A client whose `memories` collection connects fine but fails every data
// operation — simulating an outage AFTER a successful startup.
function brokenMemoryMongoClient() {
    const fake = fakeMongoClient();
    const memoriesStore = fake.collections.get('memories') || fake.db().collection('memories');
    const brokenMethods = ['insertOne', 'findOne', 'updateOne', 'countDocuments', 'deleteOne', 'deleteMany', 'findOneAndUpdate'];
    for (const method of brokenMethods) {
        memoriesStore[method] = async () => { throw new Error('connection refused by server'); };
    }
    memoriesStore.find = () => { throw new Error('connection refused by server'); };
    return fake;
}

// ---------- brain.js memory store ----------

test('memories collection gets a guild+user+created_at index at connect time', async () => {
    const fake = await connectTestBrain();
    assert.equal(brain.isMemoryAvailable(), true);
    const memoryIndex = fake.createdIndexes.find(({ name }) => name === 'memories');
    assert.ok(memoryIndex, 'memories index missing');
    assert.deepEqual(memoryIndex.spec, { guildId: 1, userId: 1, created_at: -1 });
});

test('remember stores content with guild, user, type, and created_at; recall returns oldest-first', async () => {
    await connectTestBrain();

    await brain.remember('guild-1', 'user-1', 'User loves chess', 'preference');
    await brain.remember('guild-1', 'user-1', 'User lives in Pune', 'fact');
    await brain.remember('guild-1', 'user-2', 'someone else memory');
    await brain.remember('guild-2', 'user-1', 'other guild memory');

    const recalled = await brain.recall('guild-1', 'user-1', 10);
    assert.equal(recalled.length, 2);
    assert.deepEqual(recalled.map((m) => m.content), ['User loves chess', 'User lives in Pune']);
    for (const memory of recalled) {
        assert.ok(memory.id > 0);
        assert.ok(['preference', 'fact'].includes(memory.type));
        assert.ok(Number.isFinite(memory.created_at));
    }

    assert.equal(await brain.countMemories('guild-1', 'user-1'), 2);
    assert.equal(await brain.countMemories('guild-1', 'user-2'), 1);
    assert.equal(await brain.countMemories('guild-2', 'user-1'), 1);
});

test('recall limit caps results to the newest memories', async () => {
    await connectTestBrain();
    for (let i = 1; i <= 7; i += 1) {
        await brain.remember('g', 'u', `memory number ${i}`);
    }
    const newest = await brain.recall('g', 'u', 3);
    assert.equal(newest.length, 3);
    assert.deepEqual(newest.map((m) => m.content), ['memory number 5', 'memory number 6', 'memory number 7']);
});

test('remember refuses credentials and never stores them', async () => {
    await connectTestBrain();
    const secrets = [
        'my api key is sk-abcdefghijklmnopqrstuvwx',
        'token: gh p_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
        'AWS key AKIAIOSFODNN7EXAMPLE',
        'password:hunter2secret',
        'here is my api_key=supersecretvalue123'
    ];
    for (const secret of secrets) {
        await assert.rejects(() => brain.remember('g', 'u', secret), /credentials/i);
    }
    assert.equal(await brain.countMemories('g', 'u'), 0, 'secrets must never be stored');
});

test('remember rejects empty content and unknown types fall back to fact', async () => {
    await connectTestBrain();
    await assert.rejects(() => brain.remember('g', 'u', '   '), /non-empty content/);
    const stored = await brain.remember('g', 'u', 'valid memory', 'not-a-type');
    assert.equal(stored.type, 'fact');
});

test('deleteMemoryById deletes only the matching memory and reports truthfully', async () => {
    await connectTestBrain();
    const first = await brain.remember('g', 'u', 'memory one');
    await brain.remember('g', 'u', 'memory two');

    assert.equal(await brain.deleteMemoryById('g', 'u', first.id), true);
    assert.equal(await brain.deleteMemoryById('g', 'u', first.id), false, 'second delete must report false');
    assert.equal(await brain.deleteMemoryById('g', 'u2', first.id), false, 'other user cannot match');

    const remaining = await brain.recall('g', 'u', 10);
    assert.deepEqual(remaining.map((m) => m.content), ['memory two']);
    await assert.rejects(() => brain.deleteMemoryById('g', 'u', 'not-a-number'), /positive number/);
});

test('deleteAllMemories returns the real deleted count', async () => {
    await connectTestBrain();
    await brain.remember('g', 'u', 'one');
    await brain.remember('g', 'u', 'two');
    assert.equal(await brain.deleteAllMemories('g', 'u'), 2);
    assert.equal(await brain.deleteAllMemories('g', 'u'), 0, 'zero deletes report zero');
    assert.equal(await brain.countMemories('g', 'u'), 0);
});

test('memory functions fail loudly when brain is not connected', async () => {
    brain._disconnectForTests();
    await assert.rejects(() => brain.remember('g', 'u', 'content'), /not connected/);
    await assert.rejects(() => brain.recall('g', 'u'), /not connected/);
    await assert.rejects(() => brain.countMemories('g', 'u'), /not connected/);
    await assert.rejects(() => brain.deleteAllMemories('g', 'u'), /not connected/);
    // Capability truth-telling works even unconnected.
    assert.equal(brain.isMemoryAvailable(), false);
    assert.deepEqual(brain.getMemoryCapabilities(), {
        persistentMemory: false,
        memoryDatabase: null,
        conversationMemory: true,
        memoryRetrieval: false,
        memoryWrite: false
    });
    await connectTestBrain(); // restore for later tests
});

test('memory write failure is recorded in status instead of being faked as success', async () => {
    await connectTestBrain(brokenMemoryMongoClient());
    await assert.rejects(() => brain.remember('g', 'u', 'should fail'), /connection refused/);
    const status = brain.getMemoryStatus();
    assert.equal(status.connected, true, 'client exists even while operations fail');
    assert.equal(status.persistentMemory, true, 'collection handle exists');
    assert.ok(status.lastError, 'lastError must be recorded');
    assert.match(status.lastError, /connection refused/);
    // Reads through the broken collection must ALSO fail loudly, not fake a zero.
    await assert.rejects(() => brain.countMemories('g', 'u'), /connection refused/);
    await connectTestBrain(); // restore for later tests
});

test('memory persists across a simulated restart (new brain state, same database)', async () => {
    // Two "processes" over ONE backing store: the fake client stands in for
    // MongoDB Atlas, which outlives any bot restart.
    const sharedDb = fakeMongoClient();
    const firstRun = await connectTestBrain(sharedDb);
    await brain.remember('guild-9', 'user-9', 'written before the restart');

    // "Restart": disconnect + reconnect the module to the SAME database.
    brain._disconnectForTests();
    assert.equal(firstRun, sharedDb);
    await brain.connectBrain('mongodb://fake', { client: sharedDb });
    const recalled = await brain.recall('guild-9', 'user-9', 10);
    assert.equal(recalled.length, 1, 'memories written before the restart must still be there');
    assert.equal(recalled[0].content, 'written before the restart');
});

// ---------- Runtime capability truthfulness ----------

test('capabilities reflect real runtime state (connected vs unconnected)', async () => {
    await connectTestBrain();
    const caps = brain.getMemoryCapabilities();
    assert.equal(caps.persistentMemory, true);
    assert.equal(caps.memoryDatabase, 'MongoDB');
    assert.equal(caps.memoryRetrieval, true);
    assert.equal(caps.memoryWrite, true);

    const status = brain.getMemoryStatus();
    assert.equal(status.connected, true);
    assert.equal(status.collection, 'memories');
    assert.equal(status.lastError, null);
});

// ---------- Memory questions: never fake, never deny ----------

test('memory questions are detected, imperative save requests are not', () => {
    const questions = [
        'What do you remember?',
        'show me your memory',
        'What is stored in your memory?',
        'Do you have persistent memory?',
        'how does your memory work?',
        'what do you know about me?',
        'do you remember me?'
    ];
    for (const question of questions) {
        assert.equal(isMemoryQuestion(question), true, `"${question}" should be a memory question`);
    }
    // Imperative save requests must NOT be hijacked by the Q&A path.
    const imperatives = [
        'remember that my birthday is June 5',
        'yaad rakh mujhe',
        "don't forget I hate pineapple"
    ];
    for (const imperative of imperatives) {
        assert.equal(isMemoryQuestion(imperative), false, `"${imperative}" is a save request, not a question`);
    }
});

test('buildMemoryAnswer never claims memories that do not exist', () => {
    const caps = { persistentMemory: true, memoryDatabase: 'MongoDB', conversationMemory: true, memoryRetrieval: true, memoryWrite: true };

    // Empty memory: must admit nothing is stored, while confirming memory exists.
    const empty = buildMemoryAnswer({ capabilities: caps, memories: [] });
    assert.match(empty, /nothing stored|no.*memor|don't remember/i);
    assert.match(empty, /MongoDB|persistent/i);

    // Non-empty: must list exactly the real memories and nothing else.
    const full = buildMemoryAnswer({
        capabilities: caps,
        memories: [
            { id: 1, content: 'user loves chess', type: 'preference', created_at: 1 },
            { id: 2, content: 'user lives in Pune', type: 'fact', created_at: 2 }
        ]
    });
    assert.match(full, /user loves chess/);
    assert.match(full, /user lives in Pune/);
    assert.doesNotMatch(full, /birthday|favorite food|pet/, 'no invented memories allowed');
});

test('buildMemoryAnswer denies persistent memory only when it is actually unavailable', () => {
    const down = buildMemoryAnswer({ capabilities: { persistentMemory: false, memoryDatabase: null } });
    assert.match(down, /temporarily unavailable/i);

    // With memory UP and lookup failing, the bot must admit uncertainty, not invent.
    const failed = buildMemoryAnswer({
        capabilities: { persistentMemory: true },
        memories: null,
        lastError: 'connection timeout'
    });
    assert.match(failed, /lookup failed|won't pretend/i);
});

test('memory context block grounds the AI in real state', () => {
    const capsUp = { persistentMemory: true, memoryDatabase: 'MongoDB', conversationMemory: true, memoryRetrieval: true, memoryWrite: true };

    const up = buildMemoryContextBlock({ capabilities: capsUp, memories: [{ id: 1, content: 'likes chess', type: 'preference' }] });
    assert.match(up, /DO have persistent long-term memory/);
    assert.match(up, /likes chess/);
    assert.match(up, /NEVER claim "I stored that"/);

    const empty = buildMemoryContextBlock({ capabilities: capsUp, memories: [] });
    assert.match(empty, /none stored for this user yet/);

    const down = buildMemoryContextBlock({ capabilities: { persistentMemory: false } });
    assert.match(down, /TEMPORARILY UNAVAILABLE/);
    assert.match(down, /NEVER claim to remember/);

    const failedRecall = buildMemoryContextBlock({ capabilities: capsUp, memories: null, retrievalFailed: true });
    assert.match(failedRecall, /retrieval FAILED/i);
});

// ---------- Selective saves ----------

test('shouldRemember saves durable facts and preferences, skips chat noise', () => {
    const saves = [
        ['my favorite game is chess', 'preference'],
        ['I love late night coding sessions', 'preference'],
        ['my name is Ravi', 'fact'],
        ['remember that my exam is on Friday', 'fact'],
        ["don't forget I have a meeting at 6", 'fact'],
        ['i live in Pune btw', 'fact'],
        ['mujhe pasand hai chai', 'preference']
    ];
    for (const [message, expectedType] of saves) {
        const result = shouldRemember(message);
        assert.equal(result.should, true, `"${message}" should be remembered`);
        assert.equal(result.type, expectedType);
    }

    const skips = [
        'hey',
        'lol',
        'what time is the meeting?',   // question, transient
        'i am bored today',            // transient state
        'play https://example.com/x.mp3',
        'kick him',
        'help'
    ];
    for (const message of skips) {
        assert.equal(shouldRemember(message).should, false, `"${message}" must NOT be remembered`);
    }
});

// ---------- Cross-user recent context + 1-month retention ----------

test('remember accepts keyword/author metadata and stores it', async () => {
    await connectTestBrain();
    const stored = await brain.remember('guild-1', 'user-1', 'my exam is happening', 'event', {
        authorName: 'Rohit',
        keyword: 'exam'
    });
    assert.ok(stored.id > 0);

    const recent = await brain.recallRecent('guild-1', { limit: 10 });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].authorName, 'Rohit');
    assert.equal(recent[0].keyword, 'exam');
    assert.equal(recent[0].content, 'my exam is happening');
});

test('recallRecent returns memories from ALL users guild-wide, newest first', async () => {
    await connectTestBrain();
    await brain.remember('guild-1', 'user-1', 'user-1 old memory');
    await brain.remember('guild-1', 'user-2', 'user-2 exam stress', 'event', { authorName: 'Anna', keyword: 'exam' });
    await brain.remember('guild-1', 'user-3', 'user-3 gym day', 'event', { authorName: 'Sam', keyword: 'gym' });
    await brain.remember('guild-2', 'user-1', 'other guild stays out');

    const recent = await brain.recallRecent('guild-1', { limit: 10 });
    assert.equal(recent.length, 3);
    assert.deepEqual(
        recent.map((m) => m.content),
        ['user-3 gym day', 'user-2 exam stress', 'user-1 old memory'],
        'must be newest-first across ALL members'
    );
});

test('recallRecent excludes a user and windows normal conversation memories', async () => {
    await connectTestBrain();
    await brain.remember('g', 'user-1', 'mine');
    await brain.remember('g', 'user-2', 'theirs');

    const excluded = await brain.recallRecent('g', { limit: 10, excludeUserId: 'user-1' });
    assert.deepEqual(excluded.map((m) => m.content), ['theirs']);

    // A cutoff far in the future expires untagged conversation memories,
    // while keyword-tagged anchors are PERMANENT and still come through.
    const windowed = await brain.recallRecent('g', { limit: 10, windowMs: -1_000_000 });
    assert.deepEqual(windowed.map((m) => m.content), [], 'untagged memories must be window-gated');
});

test('keyword-tagged memories are PERMANENT: never pruned, never window-gated', async () => {
    const fake = await connectTestBrain();
    const store = fake.collections.get('memories');
    const monthAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

    // A keyword anchor from 40 days ago and a normal memory from 40 days ago.
    store.docs.push({
        id: 901, guildId: 'g', userId: 'u1', content: 'rohit exam anchor',
        type: 'event', keyword: 'exam', created_at: monthAgo
    });
    store.docs.push({
        id: 902, guildId: 'g', userId: 'u2', content: 'stale chatter',
        type: 'fact', keyword: null, created_at: monthAgo
    });

    // Prune: only the untagged old memory dies.
    const deleted = await brain.pruneOldMemories('g');
    assert.equal(deleted, 1, 'keyword anchors must survive the prune');

    // Recall: only the anchor qualifies despite being outside the window.
    const recent = await brain.recallRecent('g', { limit: 10 });
    assert.deepEqual(recent.map((m) => m.content), ['rohit exam anchor']);

    // And the anchor remains recallable for its OWN user too.
    const own = await brain.recall('g', 'u1', 10);
    assert.deepEqual(own.map((m) => m.content), ['rohit exam anchor']);
});

test('pruneOldMemories deletes only untagged entries older than 30 days', async () => {
    const fake = await connectTestBrain();
    await brain.remember('g', 'u', 'fresh memory');
    // Backdate one doc past the window directly in the fake store.
    const store = fake.collections.get('memories');
    store.docs.push({
        id: 999, guildId: 'g', userId: 'u', content: 'ancient memory',
        type: 'fact', keyword: null, created_at: Date.now() - 31 * 24 * 60 * 60 * 1000
    });

    const deleted = await brain.pruneOldMemories('g');
    assert.equal(deleted, 1);
    const remaining = await brain.recall('g', 'u', 10);
    assert.deepEqual(remaining.map((m) => m.content), ['fresh memory']);
    assert.equal(await brain.pruneOldMemories('g'), 0, 'second prune deletes nothing');
});

// ---------- Passive capture + topic keywords ----------

test('extractTopicKeyword tags exams, jobs, gym, health and more', () => {
    const cases = [
        ['my exam is happening tomorrow', 'exam'],
        ['semester test ka time aa gaya', 'exam'],
        ['I have an interview on monday', 'job'],
        ['boss gave a deadline today', 'work'],
        ['leg day at the gym', 'gym'],
        ['down with fever since morning', 'health'],
        ['results came out and I passed', 'exam-result']
    ];
    for (const [text, keyword] of cases) {
        assert.equal(extractTopicKeyword(text), keyword, `"${text}" -> ${keyword}`);
    }
    assert.equal(extractTopicKeyword('just vibing'), null);
});

test('extractPassiveMemory captures durable events and skips chat noise', () => {
    const captures = [
        ['my exam is happening next week', 'event', 'exam'],
        ['remember that I have a game night on saturday', 'fact', 'game'],
        ['mera interview kal hai wish me luck', 'event', 'job']
    ];
    for (const [text, type, keyword] of captures) {
        const result = extractPassiveMemory(text);
        assert.ok(result, `"${text}" should be captured passively`);
        assert.equal(result.type, type);
        assert.equal(result.keyword, keyword);
    }

    const skips = [
        'lol',
        'hey bro what is up',
        'anyone here?',
        'i am bored',
        'play https://example.com/song.mp3',
        'kick him'
    ];
    for (const text of skips) {
        assert.equal(extractPassiveMemory(text), null, `"${text}" must NOT be captured`);
    }
});

test('passive capture refuses crisis content so it is never persisted', () => {
    assert.equal(extractPassiveMemory('my exam is happening and I want to die'), null);
});

test('buildServerContextBlock lists who + topic + content for the AI', () => {
    const block = buildServerContextBlock({
        recentMemories: [
            { authorName: 'Rohit', keyword: 'exam', content: 'my exam is happening', type: 'event' },
            { authorName: null, keyword: null, content: 'anonymous note', type: 'fact' }
        ]
    });
    assert.match(block, /SERVER HAPPENINGS/);
    assert.match(block, /Rohit \[topic: exam\]: my exam is happening/);
    assert.match(block, /someone: anonymous note/);

    // Empty/missing recent memories -> empty block (no noise in the prompt).
    assert.equal(buildServerContextBlock({ recentMemories: [] }), '');
    assert.equal(buildServerContextBlock({}), '');
});

// ---------- Owner-only diagnostics via the router ----------

function fakeMessage(authorId, guildId, options = {}) {
    const roles = (options.roles || []).map((name) => ({ name }));
    return {
        author: { id: authorId },
        guild: {
            id: guildId,
            ownerId: options.guildOwnerId || 'real-guild-owner',
            memberCount: 10,
            channels: { cache: { size: 5 } },
            members: {
                me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } },
                cache: {
                    get: () => null,
                    find: () => (options.resolveMember ? { id: 'victim-9', displayName: 'victim' } : null)
                }
            }
        },
        member: {
            id: authorId,
            roles: {
                cache: {
                    some: (predicate) => roles.some((role) => predicate(role)),
                    map: (fn) => roles.map((role) => fn(role))
                }
            }
        }
    };
}

const ownerSettings = { serverOwnerId: 'owner-123' };

test('memory_status is admin-gated and reports live state for the owner', async () => {
    await connectTestBrain();
    await brain.remember('guild-1', 'owner-123', 'owner secret memory');
    await brain.remember('guild-1', 'owner-123', 'owner secret memory two');

    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123' });
    const result = await executeTool(message, ownerSettings, { action: 'memory_status' });
    assert.match(result, /MongoDB connected: ✅/);
    assert.match(result, /Memory collection available: ✅/);
    assert.match(result, /Stored memories for you: \*\*2\*\*/);
    assert.match(result, /Last memory error: none/);
});

test('memory_status is denied for normal members', async () => {
    await connectTestBrain();
    const message = fakeMessage('random-user', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(message, ownerSettings).allowed, false);
    const result = await executeTool(message, ownerSettings, { action: 'memory_status' });
    assert.match(result, /Only the server owner|❌/);
});

test('memory_status reports the truth when memory is down', async () => {
    brain._disconnectForTests();
    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123' });
    const result = await executeTool(message, ownerSettings, { action: 'memory_status' });
    assert.match(result, /Memory collection available: ❌/);
    assert.match(result, /Persistent memory enabled: ❌/);
    assert.match(result, /Memory writes after replies: ❌/);
    await connectTestBrain(); // restore
});

test('forget_memory deletes own memories without auth and reports zero honestly', async () => {
    await connectTestBrain();
    await brain.remember('guild-1', 'user-1', 'please forget me');
    await brain.remember('guild-1', 'user-2', 'not mine');

    const message = fakeMessage('user-1', 'guild-1');
    const result = await executeTool(message, ownerSettings, { action: 'forget_memory' });
    assert.match(result, /Deleted \*\*1\*\*/);
    assert.equal(await brain.countMemories('guild-1', 'user-1'), 0);
    assert.equal(await brain.countMemories('guild-1', 'user-2'), 1, 'other users are untouched');

    const again = await executeTool(message, ownerSettings, { action: 'forget_memory' });
    assert.match(again, /no stored memories.*nothing was deleted/i);
});

test('forget_memory targeting another user requires authorization', async () => {
    await connectTestBrain();
    await brain.remember('guild-1', 'victim-9', 'victim private memory');

    // Member must resolve so the AUTH gate (not member lookup) is what denies.
    const nobody = fakeMessage('user-1', 'guild-1', { resolveMember: true });
    const denied = await executeTool(nobody, ownerSettings, { action: 'forget_memory', target: 'victim' });
    assert.match(denied, /Only the server owner/);
    assert.equal(await brain.countMemories('guild-1', 'victim-9'), 1, 'denied delete must not touch data');

    const owner = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123', resolveMember: true });
    const allowed = await executeTool(owner, ownerSettings, { action: 'forget_memory', target: 'victim' });
    assert.match(allowed, /Deleted \*\*1\*\*/);
    assert.equal(await brain.countMemories('guild-1', 'victim-9'), 0);
});

test('forget_memory never claims deletion when memory is unavailable', async () => {
    brain._disconnectForTests();
    const message = fakeMessage('user-1', 'guild-1');
    const result = await executeTool(message, ownerSettings, { action: 'forget_memory' });
    assert.match(result, /unavailable.*nothing was deleted/i);
    await connectTestBrain(); // restore
});

test('bot_help lists the new memory actions', async () => {
    await connectTestBrain();
    const message = fakeMessage('user-1', 'guild-1');
    const result = await executeTool(message, ownerSettings, { action: 'bot_help' });
    assert.match(result, /memory diagnostics|Delete stored memories/);
});
