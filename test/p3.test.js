const test = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter } = require('../src/ai/rateLimiter');
const brain = require('../src/db/brain');
const { isAuthorizedActor, executeTool, destructiveActions } = require('../src/tools/router');
const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
const { buildDefinitions, interactionToIntent, slashActionByCommand } = require('../src/slash');

// ---------- Rate limiter ----------

test('rate limiter allows up to max then blocks within the window', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    const user = 'user-1';

    assert.equal(limiter.attempt(user, 0), true);
    assert.equal(limiter.attempt(user, 10), true);
    assert.equal(limiter.attempt(user, 20), true);
    assert.equal(limiter.attempt(user, 30), false); // over the 3-max

    // After the window slides past, the user gets quota back.
    assert.equal(limiter.attempt(user, 1500), true);
});

test('rate limiter tracks users independently', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    assert.equal(limiter.attempt('a', 0), true);
    assert.equal(limiter.attempt('a', 1), false);
    assert.equal(limiter.attempt('b', 2), true);
});

// ---------- Mongo warn store (brain.js, fake client — no live DB) ----------

// Minimal in-memory stand-in for the mongodb driver surface brain.js uses.
function fakeMongoClient() {
    const collections = new Map();
    const createdIndexes = [];

    function collection(name) {
        if (!collections.has(name)) {
            const docs = [];
            let seq = 0;
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
                    const doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    return doc ? { ...doc } : null;
                },
                async updateOne(filter, update) {
                    let doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    let upsertedId = null;
                    if (!doc) {
                        doc = { ...filter };
                        docs.push(doc);
                        upsertedId = doc._id ?? null;
                    }
                    if (update.$set) {
                        for (const [k, v] of Object.entries(update.$set)) doc[k] = v;
                    }
                    return { matchedCount: 1, upsertedId };
                },
                async countDocuments(filter) {
                    return docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v)).length;
                },
                find(filter) {
                    const matches = () => docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    let sortKeys = {};
                    return {
                        sort(spec) {
                            sortKeys = spec;
                            return this;
                        },
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
                            return rows;
                        }
                    };
                },
                async findOneAndUpdate(filter, update) {
                    let doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    if (!doc) {
                        doc = { ...filter };
                        docs.push(doc);
                    }
                    if (update.$inc) {
                        for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
                    }
                    seq = doc.seq;
                    return { value: { ...doc } };
                }
            };
            collections.set(name, store);
        }
        return collections.get(name);
    }

    return {
        createdIndexes,
        db() {
            return { collection };
        },
        async connect() {}
    };
}

test('brain warns store adds, counts, and lists per guild+user with increasing ids', async () => {
    const fake = fakeMongoClient();
    await brain.connectBrain('mongodb://fake', { client: fake });

    const first = await brain.addWarning('guild-1', 'user-1', 'spamming', 'mod-1');
    const second = await brain.addWarning('guild-1', 'user-1', 'ban evasion', 'mod-2');
    await brain.addWarning('guild-2', 'user-1', 'other guild', 'mod-1');

    assert.equal(first.id > 0, true);
    assert.notEqual(first.id, second.id);
    assert.equal(await brain.countWarnings('guild-1', 'user-1'), 2);
    assert.equal(await brain.countWarnings('guild-2', 'user-1'), 1);

    const list = await brain.listWarnings('guild-1', 'user-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].reason, 'spamming'); // ordered oldest first
    assert.equal(list[1].reason, 'ban evasion');

    // Index contract preserved from the SQLite idx_warnings_guild_user index.
    assert.deepEqual(fake.createdIndexes.find(({ name }) => name === 'users').spec, { userId: 1 });
    assert.deepEqual(
        fake.createdIndexes.find(({ name }) => name === 'warnings').spec,
        { guildId: 1, userId: 1, created_at: 1 }
    );
});

test('brain user profile defaults match the documented shape', async () => {
    await brain.connectBrain('mongodb://fake', { client: fakeMongoClient() });

    const fresh = await brain.getUser('user-9');
    assert.deepEqual(fresh, { userId: 'user-9', warnings: [], xp: 0, notes: {} });

    await brain.updateUser('user-9', { xp: 10 });
    const patched = await brain.getUser('user-9');
    assert.equal(patched.xp, 10);
});

test('brain functions fail loudly when not connected', async () => {
    // Fresh module instance so leftover state from the connected tests above
    // does not mask the unconnected guard.
    delete require.cache[require.resolve('../src/db/brain')];
    const fresh = require('../src/db/brain');
    await assert.rejects(() => fresh.getUser('user-1'), /not connected/);
    await assert.rejects(() => fresh.addWarning('g', 'u', 'r', 'm'), /not connected/);
});

// ---------- Per-guild owners / admin roles ----------

function fakeMessage(authorId, guildId, options = {}) {
    const roles = (options.roles || []).map((name) => ({ name }));
    return {
        author: { id: authorId },
        guild: { id: guildId, ownerId: options.guildOwnerId || 'real-guild-owner' },
        member: {
            roles: {
                // Mimic the discord.js Collection surface the router uses.
                cache: {
                    some: (predicate) => roles.some((role) => predicate(role)),
                    map: (fn) => roles.map((role) => fn(role))
                }
            }
        }
    };
}

const strictSettings = { serverOwnerId: 'owner-123' };

test('strict SERVER_OWNER_ID fallback still authorizes the single-server owner', () => {
    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(message, strictSettings).allowed, true);
});

test('strict owner check is unchanged for non-owners', () => {
    const message = fakeMessage('admin-9', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(message, strictSettings).allowed, false);
});

test('per-guild owner from GUILD_CONFIG is authorized in their own guild only', () => {
    const settings = {
        serverOwnerId: 'owner-123',
        guildOwnerIds: new Map([['guild-2', 'guild2-owner']]),
        guildAdminRoleNames: new Map()
    };

    assert.equal(isAuthorizedActor(fakeMessage('guild2-owner', 'guild-2'), settings).allowed, true);
    // Same person has no power in another guild.
    assert.equal(isAuthorizedActor(fakeMessage('guild2-owner', 'guild-1'), settings).allowed, false);
});

test('per-guild admin role grants access, wrong role does not', () => {
    const settings = {
        serverOwnerId: 'owner-123',
        guildOwnerIds: new Map(),
        guildAdminRoleNames: new Map([['guild-3', ['ZiG Admin', 'Mods']]])
    };

    assert.equal(
        isAuthorizedActor(fakeMessage('member-7', 'guild-3', { roles: ['zig admin', 'Member'] }), settings).allowed,
        true
    );
    assert.equal(
        isAuthorizedActor(fakeMessage('member-8', 'guild-3', { roles: ['Member'] }), settings).allowed,
        false
    );
    // Admin role only applies in the guild that configured it.
    assert.equal(
        isAuthorizedActor(fakeMessage('member-7', 'guild-9', { roles: ['zig admin'] }), settings).allowed,
        false
    );
});

// ---------- Warn routing ----------

test('warn_member is destructive and list_warnings is not admin-gated', () => {
    assert.equal(destructiveActions.has('warn_member'), true);
    assert.equal(destructiveActions.has('list_warnings'), false);
});

test('list_warnings works without owner auth and reports storage state', async () => {
    const message = fakeMessage('random-user', 'guild-1');
    message.guild.members = {
        cache: {
            get: () => null,
            find: () => ({ id: 'target-1', displayName: 'Target' })
        }
    };

    const result = await executeTool(message, strictSettings, { action: 'list_warnings', target: 'Target' }, { warnStore: null });
    assert.match(result, /storage is not configured|could not find/);
});

// ---------- Slash command conversion ----------

test('slash commands map to canonical router actions', () => {
    assert.equal(slashActionByCommand.get('play'), 'play');
    assert.equal(slashActionByCommand.get('kick'), 'kick_member');
    assert.equal(slashActionByCommand.get('ban'), 'ban_member');
    assert.equal(slashActionByCommand.get('help'), 'bot_help');
});

test('buildDefinitions returns plain JSON payloads ready for the Discord API', () => {
    // Regression guard: a stray inline .toJSON() once left a plain object in
    // the array, and the map then crashed the whole bot on startup.
    const definitions = buildDefinitions();
    assert.equal(definitions.length, 4);
    for (const definition of definitions) {
        assert.equal(typeof definition.toJSON, 'undefined');
        assert.equal(typeof definition.name, 'string');
        assert.equal(typeof definition.description, 'string');
    }
    assert.deepEqual(
        definitions.map(({ name }) => name),
        ['play', 'kick', 'ban', 'help']
    );
});

test('interactionToIntent converts options into validated intent fields', async () => {
    const kickIntent = await interactionToIntent({
        commandName: 'kick',
        options: { getString: () => { throw new Error('not used'); }, getUser: () => ({ id: 'user-5' }) }
    });
    assert.equal(kickIntent.action, 'kick_member');
    assert.equal(kickIntent.target, '<@user-5>');

    const playIntent = await interactionToIntent({
        commandName: 'play',
        options: { getString: () => '  https://audio.example/song.mp3  ', getUser: () => null }
    });
    assert.equal(playIntent.action, 'play');
    assert.equal(playIntent.target, 'https://audio.example/song.mp3');

    assert.equal(await interactionToIntent({ commandName: 'nope', options: {} }), null);
});

test('voice route still blocks destructive actions after P3 changes', () => {
    const intent = buildVoiceTranscriptRoute(
        { author: { id: 'owner-123' }, guild: { ownerId: 'owner-123' } },
        'kick him',
        strictSettings,
        'bot-id'
    );
    assert.equal(intent.action, 'chat');
    assert.ok(intent.voiceNotice);
});
