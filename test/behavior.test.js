const test = require('node:test');
const assert = require('node:assert/strict');

// One shared brain module instance — the router captures this same instance
// at require time, so tests toggle state via _disconnectForTests/connectBrain.
const brain = require('../src/db/brain');
const { executeTool, isAuthorizedActor, destructiveActions } = require('../src/tools/router');
const { detectBehaviorSignals, BehaviorTracker } = require('../src/ai/behaviorDetector');
const {
    buildReputationBlock,
    isReputationQuestion,
    buildReputationAnswer
} = require('../src/ai/client');

// ---------- Fake Mongo client (same surface the memory suite uses) ----------

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
                    const doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
                    return doc ? { ...doc } : null;
                },
                async updateOne(filter, update) {
                    let doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
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
                    return docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v)).length;
                },
                async deleteMany(filter) {
                    const keep = docs.filter((d) => !Object.entries(filter).every(([k, v]) => d[k] === v));
                    const deleted = docs.length - keep.length;
                    docs.length = 0;
                    docs.push(...keep);
                    return { deletedCount: deleted };
                },
                find(filter) {
                    const matches = () => docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
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
                    let doc = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
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

async function connectTestBrain(client = fakeMongoClient()) {
    brain._disconnectForTests();
    await brain.connectBrain('mongodb://fake', { client });
    return client;
}

// ---------- brain.js behavior store ----------

test('behaviors collection gets an index at connect time', async () => {
    const fake = await connectTestBrain();
    const index = fake.createdIndexes.find(({ name }) => name === 'behaviors');
    assert.ok(index, 'behaviors index missing');
    assert.deepEqual(index.spec, { guildId: 1, userId: 1, created_at: -1 });
});

test('recordBehavior stores known signals with kind attribution; unknown signals are rejected', async () => {
    await connectTestBrain();
    await brain.recordBehavior('g', 'u', 'helpful');
    await brain.recordBehavior('g', 'u', 'slurs');
    await brain.recordBehavior('g', 'u', 'warning', { source: 'warn_member', note: 'spamming' });

    await assert.rejects(() => brain.recordBehavior('g', 'u', 'made-up-signal'), /known signal/);
    await assert.rejects(() => brain.recordBehavior('g', '', 'helpful'), /requires guildId/);

    const summary = await brain.getBehaviorSummary('g', 'u');
    assert.equal(summary.totalEvents, 3);
    const signals = summary.recentEvents.map((event) => event.signal);
    assert.ok(signals.includes('helpful'));
    assert.ok(signals.includes('slurs'));
    assert.ok(signals.includes('warning'));
});

test('scoreEvents weights positives +1, negatives -2, and excludes events outside the window', async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const events = [
        { kind: 'positive', created_at: now - day },      // +1
        { kind: 'positive', created_at: now - 2 * day },  // +1
        { kind: 'positive', created_at: now - 2 * day },  // +1
        { kind: 'negative', created_at: now - day },      // -2
        { kind: 'positive', created_at: now - 40 * day }, // outside 30-day window
        { kind: 'negative', created_at: now - 31 * day }  // outside window
    ];
    const score = brain.scoreEvents(events, now);
    assert.equal(score.positive, 3, 'three positive events in window');
    assert.equal(score.negative, 1, 'one negative event in window');
    assert.equal(score.net, 1, 'net = 3*(+1) + 1*(-2)');
});

test('tierFromScore maps net scores to the documented standings', () => {
    assert.equal(brain.tierFromScore(-10), 'hostile');
    assert.equal(brain.tierFromScore(-6), 'hostile');
    assert.equal(brain.tierFromScore(-5), 'rocky');
    assert.equal(brain.tierFromScore(-2), 'rocky');
    assert.equal(brain.tierFromScore(0), 'neutral');
    assert.equal(brain.tierFromScore(1), 'neutral');
    assert.equal(brain.tierFromScore(2), 'respected');
    assert.equal(brain.tierFromScore(4), 'respected');
    assert.equal(brain.tierFromScore(5), 'valued');
    assert.equal(brain.tierFromScore(20), 'valued');
});

test('getBehaviorSummary computes standing from the real event record', async () => {
    await connectTestBrain();
    // Helpful member: 4 positives → net +4 → respected (valued needs +5).
    for (let i = 0; i < 4; i += 1) await brain.recordBehavior('g', 'good', 'helpful');
    const goodSummary = await brain.getBehaviorSummary('g', 'good');
    assert.equal(goodSummary.positive, 4);
    assert.equal(goodSummary.tier, 'respected');

    // Hostile member: 4 negative events = 4 * -2 = -8 → hostile.
    await brain.recordBehavior('g', 'bad', 'slurs');
    await brain.recordBehavior('g', 'bad', 'slurs');
    await brain.recordBehavior('g', 'bad', 'harassment');
    await brain.recordBehavior('g', 'bad', 'warning');
    const badSummary = await brain.getBehaviorSummary('g', 'bad');
    assert.equal(badSummary.negative, 4);
    assert.equal(badSummary.net, -8);
    assert.equal(badSummary.tier, 'hostile');

    // Clean slate: zero events.
    const fresh = await brain.getBehaviorSummary('g', 'nobody');
    assert.equal(fresh.totalEvents, 0);
    assert.equal(fresh.tier, 'neutral');
});

test('behavior functions fail loudly when not connected, availability is truthful', async () => {
    brain._disconnectForTests();
    assert.equal(brain.isBehaviorAvailable(), false);
    await assert.rejects(() => brain.recordBehavior('g', 'u', 'helpful'), /not connected/);
    await assert.rejects(() => brain.getBehaviorSummary('g', 'u'), /not connected/);
    await assert.rejects(() => brain.deleteBehaviors('g', 'u'), /not connected/);
    await connectTestBrain();
});

test('deleteBehaviors returns the real deleted count', async () => {
    await connectTestBrain();
    await brain.recordBehavior('g', 'u', 'kind');
    await brain.recordBehavior('g', 'u', 'helpful');
    assert.equal(await brain.deleteBehaviors('g', 'u'), 2);
    assert.equal(await brain.deleteBehaviors('g', 'u'), 0);
    assert.equal(await brain.countBehaviors('g', 'u'), 0);
});

// ---------- Signal detection (conservative by design) ----------

test('detectBehaviorSignals flags unambiguous negatives and positives', () => {
    const negative = detectBehaviorSignals('you are such an idiot, kys');
    assert.deepEqual(negative.negative.sort(), ['harassment', 'toxic']);

    const slurs = detectBehaviorSignals('that word is a slur: n1gger');
    assert.deepEqual(slurs.negative, ['slurs']);

    const positive = detectBehaviorSignals('thanks bro, here is how you fix it');
    assert.ok(positive.positive.includes('kind'));
    assert.ok(positive.positive.includes('helpful'));
});

test('detectBehaviorSignals stays conservative on ordinary banter', () => {
    // Normal roast-culture chat must NOT be punished.
    const normal = [
        'bro is cooked fr',
        'lol that roast was fire',
        'hey everyone, what is up',
        'I disagree with that take',
        'shut the door on your way out',   // literal door, not "shut up"
        'this game is trash canon event'   // "trash" describing a game
    ];
    for (const message of normal) {
        const { negative } = detectBehaviorSignals(message);
        assert.equal(negative.length, 0, `"${message}" must not count as negative`);
    }
});

test('BehaviorTracker flags structural spam only after repeated identical content', () => {
    const tracker = new BehaviorTracker({ windowMs: 1000, threshold: 3 });
    const now = Date.now();
    assert.equal(tracker.checkSpam('g', 'u', 'gm', now), false);
    assert.equal(tracker.checkSpam('g', 'u', 'gm', now + 100), false);
    assert.equal(tracker.checkSpam('g', 'u', 'GM', now + 200), true); // case-insensitive
    assert.equal(tracker.checkSpam('g', 'u', 'gm', now + 300), true);

    // Different content resets the count; a fresh window starts over.
    assert.equal(tracker.checkSpam('g', 'u', 'hello there', now + 400), false);
    assert.equal(tracker.checkSpam('g', 'u', 'gm', now + 1500), false, 'window expiry resets counting');
});

// ---------- Reputation grounding in the AI layer ----------

test('buildReputationBlock gives tier-appropriate directives or stays silent', () => {
    const summary = { positive: 6, negative: 0, net: 6, tier: 'valued', windowDays: 30, recentEvents: [{ signal: 'helpful', kind: 'positive', created_at: 1 }], totalEvents: 6 };
    const block = buildReputationBlock(summary);
    assert.match(block, /VALUED/);
    assert.match(block, /extra warmth/);
    assert.match(block, /helpful/);

    const hostile = buildReputationBlock({ ...summary, positive: 0, negative: 4, net: -8, tier: 'hostile', recentEvents: [] });
    assert.match(hostile, /HOSTILE/);
    assert.match(hostile, /never slurs/i, 'guardrails must survive cold treatment');

    assert.equal(buildReputationBlock(null), '', 'no summary = no reputation claims');
});

test('reputation questions are detected precisely', () => {
    assert.equal(isReputationQuestion("what's my reputation?"), true);
    assert.equal(isReputationQuestion('how do you treat me?'), true);
    assert.equal(isReputationQuestion('do you track my behavior?'), true);
    assert.equal(isReputationQuestion('do I have a record?'), true);
    assert.equal(isReputationQuestion('what is the weather?'), false);
    assert.equal(isReputationQuestion('treat me to a joke'), false);
});

test('buildReputationAnswer reflects the real record and never invents events', () => {
    // Unavailable system: honest, no fake judgment.
    assert.match(buildReputationAnswer({ available: false }), /temporarily unavailable/i);

    // Lookup failure: no invented standing.
    assert.match(buildReputationAnswer({ available: true, summary: null }), /lookup failed|won't pretend/i);

    // Clean slate: confirms tracking exists AND zero events.
    const clean = buildReputationAnswer({
        available: true,
        summary: { positive: 0, negative: 0, net: 0, tier: 'neutral', windowDays: 30, recentEvents: [], totalEvents: 0 }
    });
    assert.match(clean, /clean slate/i);
    assert.match(clean, /Zero events/i);

    // Real record: numbers and tier must come from the summary only.
    const rocky = buildReputationAnswer({
        available: true,
        summary: { positive: 1, negative: 2, net: -3, tier: 'rocky', windowDays: 30, recentEvents: [{ signal: 'toxic', kind: 'negative', created_at: 1 }], totalEvents: 3 }
    });
    assert.match(rocky, /Positive signals: 1/);
    assert.match(rocky, /Negative signals: 2/);
    assert.match(rocky, /ROCKY/);
    assert.match(rocky, /toxic/);
    assert.doesNotMatch(rocky, /slurs/, 'signals not in the record must not appear');
});

// ---------- Router integration ----------

function fakeMessage(authorId, guildId, options = {}) {
    const roles = (options.roles || []).map((name) => ({ name }));
    const resolvedMember = { id: options.resolveAs || 'victim-9', displayName: options.resolveAs ? options.resolveAs : 'victim' };
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
                    get: (id) => (id === authorId ? resolvedMember : null),
                    find: () => (options.resolveMember ? resolvedMember : null)
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

test('behavior_status is admin-gated and reports the real record', async () => {
    await connectTestBrain();
    await brain.recordBehavior('guild-1', 'owner-123', 'helpful');
    await brain.recordBehavior('guild-1', 'owner-123', 'kind');
    await brain.recordBehavior('guild-1', 'owner-123', 'toxic');

    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123', resolveAs: 'owner-123' });
    const result = await executeTool(message, ownerSettings, { action: 'behavior_status' });
    assert.match(result, /Behavior record for owner-123/);
    assert.match(result, /Positive signals: \*\*2\*\*/);
    assert.match(result, /Negative signals: \*\*1\*\*/);
    assert.match(result, /standing: \*\*NEUTRAL\*\*/); // net = 2 positives (+1) - 1 negative (-2) = 0

    const memberMessage = fakeMessage('random-user', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(memberMessage, ownerSettings).allowed, false);
    const denied = await executeTool(memberMessage, ownerSettings, { action: 'behavior_status' });
    assert.match(denied, /Only the server owner/);
});

test('behavior_status reports unavailability honestly instead of inventing a record', async () => {
    brain._disconnectForTests();
    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123' });
    const result = await executeTool(message, ownerSettings, { action: 'behavior_status' });
    assert.match(result, /temporarily unavailable/i);
    assert.match(result, /will not invent/i);
    await connectTestBrain();
});

test('warn_member records a negative accountability signal automatically', async () => {
    await connectTestBrain();
    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123', resolveMember: true });
    const result = await executeTool(
        message,
        ownerSettings,
        { action: 'warn_member', target: 'victim', reason: 'spamming chat' },
        { warnStore: brain }
    );
    assert.match(result, /Warned victim/);

    const summary = await brain.getBehaviorSummary('guild-1', 'victim-9');
    assert.equal(summary.totalEvents, 1);
    assert.equal(summary.recentEvents[0].signal, 'warning');
    assert.equal(summary.recentEvents[0].source, 'warn_member');
    assert.equal(summary.negative, 1, 'one warning event on record');
    assert.equal(summary.net, -2, 'a warning must weigh -2 against standing');
});

test('warn_member remains destructive (confirmation flow unchanged)', () => {
    assert.equal(destructiveActions.has('warn_member'), true);
});

test('bot_help lists the behavior accountability command', async () => {
    await connectTestBrain();
    const message = fakeMessage('user-1', 'guild-1');
    const result = await executeTool(message, ownerSettings, { action: 'bot_help' });
    assert.match(result, /behavior record and standing/);
});
