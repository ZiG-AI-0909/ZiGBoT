const test = require('node:test');
const assert = require('node:assert/strict');
const brain = require('../src/db/brain');

function fakeMongoClient(collections) {
    function collection(name) {
        if (!collections.has(name)) collections.set(name, []);
        const docs = collections.get(name);
        const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => {
            if (value && typeof value === 'object' && '$lte' in value) return doc[key] <= value.$lte;
            return doc[key] === value;
        });
        return {
            async createIndex() {},
            async deleteMany(filter) {
                const keep = docs.filter((doc) => !matches(doc, filter));
                const deletedCount = docs.length - keep.length;
                docs.splice(0, docs.length, ...keep);
                return { deletedCount };
            },
            async insertOne(doc) {
                docs.push({ ...doc });
                return { insertedId: doc.id ?? null };
            },
            async findOne(filter) {
                const doc = docs.find((entry) => matches(entry, filter));
                return doc ? { ...doc } : null;
            },
            async updateOne(filter, update, { upsert = false } = {}) {
                let doc = docs.find((entry) => matches(entry, filter));
                if (!doc && upsert) {
                    doc = { ...filter };
                    docs.push(doc);
                }
                if (doc && update.$set) Object.assign(doc, update.$set);
                if (doc && update.$setOnInsert) {
                    for (const [key, value] of Object.entries(update.$setOnInsert)) {
                        if (doc[key] === undefined) doc[key] = value;
                    }
                }
                return { matchedCount: doc ? 1 : 0 };
            },
            async findOneAndUpdate(filter, update) {
                let doc = docs.find((entry) => matches(entry, filter));
                if (!doc) {
                    doc = { ...filter };
                    docs.push(doc);
                }
                for (const [key, value] of Object.entries(update.$inc || {})) {
                    doc[key] = (Number(doc[key]) || 0) + value;
                }
                if (update.$set) Object.assign(doc, update.$set);
                return { ...doc };
            },
            async deleteOne(filter) {
                const index = docs.findIndex((entry) => matches(entry, filter));
                if (index < 0) return { deletedCount: 0 };
                docs.splice(index, 1);
                return { deletedCount: 1 };
            },
            find(filter) {
                let sortSpec = {};
                let limit = Infinity;
                return {
                    sort(spec) { sortSpec = spec; return this; },
                    limit(value) { limit = value; return this; },
                    async toArray() {
                        const rows = docs.filter((entry) => matches(entry, filter)).map((entry) => ({ ...entry }));
                        const keys = Object.entries(sortSpec);
                        rows.sort((a, b) => {
                            for (const [key, direction] of keys) {
                                if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction;
                            }
                            return 0;
                        });
                        return rows.slice(0, limit);
                    }
                };
            }
        };
    }

    return {
        async connect() {},
        db() { return { collection }; }
    };
}

test('moderation cases and temporary punishments survive a brain reconnect and stay guild-scoped', async () => {
    const collections = new Map();
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client: fakeMongoClient(collections) });
    const record = await brain.createModerationCase('guild-1', {
        action: 'ban_member',
        target: 'Member',
        targetId: 'user-1',
        actorId: 'mod-1',
        reason: 'repeat violations'
    });
    const expiresAt = Date.now() + 60_000;
    await brain.addTemporaryPunishment({
        guildId: 'guild-1',
        userId: 'user-1',
        type: 'ban',
        expiresAt,
        actorId: 'mod-1',
        reason: 'temporary'
    });
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client: fakeMongoClient(collections) });

    assert.equal((await brain.getModerationCase('guild-1', record.id)).targetId, 'user-1');
    assert.equal(await brain.getModerationCase('guild-2', record.id), null);
    assert.equal((await brain.listDueTemporaryPunishments(expiresAt + 1)).length, 1);
    assert.equal((await brain.listDueTemporaryPunishments(expiresAt - 1)).length, 0);
    brain._disconnectForTests();
});

test('appeals are limited to the punished member and cannot cross guild boundaries', async () => {
    const collections = new Map();
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client: fakeMongoClient(collections) });
    const entry = await brain.createModerationCase('guild-a', {
        action: 'timeout_member',
        target: 'Member',
        targetId: 'member-a',
        actorId: 'moderator-a'
    });
    const appeal = await brain.createModerationAppeal('guild-a', entry.id, 'member-a', 'Please review this');
    assert.equal(appeal.status, 'pending');
    await assert.rejects(
        () => brain.createModerationAppeal('guild-a', entry.id, 'other-member', 'Not my case'),
        /cannot be appealed/
    );
    assert.equal(await brain.getModerationCase('guild-b', entry.id), null);
    brain._disconnectForTests();
});
