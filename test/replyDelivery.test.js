const test = require('node:test');
const assert = require('node:assert/strict');

const {
    computeTypingDelay,
    canSplit,
    splitReply,
    shouldSkipReply,
    pickReactionEmoji,
    deliverAiReply,
    TYPING_DELAY_MIN_MS,
    TYPING_DELAY_MAX_MS,
    MULTI_MESSAGE_MIN_WORDS,
    MULTI_MESSAGE_SPLIT_CHANCE,
    FUN_REPLY_SKIP_CHANCE,
    FUN_EMOJI_REACTION_CHANCE,
    FUN_EMOJI_POOL
} = require('../src/reply/delivery');

// Deterministic rng: returns values from a fixed queue, then 0.999 forever
// (always-above-any-chance). Tests push exact values to script behavior.
function scriptedRng(values) {
    const queue = [...values];
    return () => (queue.length > 0 ? queue.shift() : 0.999);
}

// rng that always rolls below any chance -> chances always fire
const alwaysBelow = () => 0;
// rng that always rolls above every configured chance
const alwaysAbove = () => 0.999;

const LONG_REPLY = 'Bro really said that out loud. Whole server heard it. Absolutely zero shame detected. Not even a little bit. Wild behavior honestly.';

// ---------- typing delay pacing ----------

test('computeTypingDelay clamps short replies near the minimum delay', () => {
    // The clamp applies to the average; a single rng roll still varies the
    // exact value within the clamp band (fastest WPM -> lowest delay).
    const delay = computeTypingDelay('lol', alwaysAbove);
    assert.ok(delay >= TYPING_DELAY_MIN_MS, 'must not drop below the minimum');
    assert.ok(delay <= TYPING_DELAY_MAX_MS, 'must stay within the band');
    // Same reply at the slowest WPM must be slower than at the fastest.
    assert.ok(computeTypingDelay('lol', alwaysBelow) > delay);
});

test('computeTypingDelay clamps very long replies to the maximum delay', () => {
    const wall = Array.from({ length: 500 }, () => 'word').join(' ');
    const delay = computeTypingDelay(wall, alwaysBelow);
    assert.equal(delay, TYPING_DELAY_MAX_MS);
});

test('computeTypingDelay scales with length between the clamps', () => {
    // rng=0 -> 40 WPM (slowest), rng=0.999 -> ~60 WPM (fastest)
    const slow = computeTypingDelay('one two three', () => 0);
    const fast = computeTypingDelay('one two three', () => 0.999);
    assert.ok(slow >= TYPING_DELAY_MIN_MS && slow <= TYPING_DELAY_MAX_MS);
    assert.ok(fast >= TYPING_DELAY_MIN_MS && fast <= TYPING_DELAY_MAX_MS);
    assert.ok(fast < slow, 'faster WPM should yield a shorter delay');
});

// ---------- multi-message splitting ----------

test('short replies are never eligible for splitting', () => {
    assert.equal(canSplit('lol nice'), false);
    const short = 'bro is cooked';
    assert.deepEqual(splitReply(short, alwaysBelow), [short]);
    assert.ok(short.trim().split(/\s+/).length < MULTI_MESSAGE_MIN_WORDS);
});

test('tool results are never split even when long', () => {
    // The tool-result gate lives in deliverAiReply (which bypasses splitting
    // entirely); splitReply itself is a content-only helper.
    assert.equal(canSplit(LONG_REPLY, { isToolResult: true }), false);
});

test('deliverAiReply never splits tool results', async () => {
    const sent = [];
    const message = fakeMessage({ reply: (payload) => sent.push(payload) });
    const parts = await deliverAiReply(message, LONG_REPLY, { isToolResult: true, rng: alwaysAbove, sleep: instantSleep() });
    assert.equal(parts, 1);
    assert.deepEqual(sent, [LONG_REPLY]);
});

test('splitReply caps output at 3 parts for many-sentence replies', () => {
    const tenSentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i + 1} ends here.`).join(' ');
    for (const roll of [0, 0.2, 0.4, 0.6, 0.8]) {
        const parts = splitReply(tenSentences, () => roll);
        assert.ok(parts.length >= 1 && parts.length <= 3, `expected <=3 parts for rng=${roll}, got ${parts.length}`);
        assert.equal(parts.join(' '), tenSentences);
    }
});

test('splitReply preserves all words across parts', () => {
    const parts = splitReply(LONG_REPLY, () => 0);
    assert.equal(parts.join(' '), LONG_REPLY);
    assert.ok(parts.length >= 1 && parts.length <= 3);
});

test('deliverAiReply splits multi-sentence replies with gaps and typing between parts', async () => {
    const sent = [];
    const typingCalls = [];
    const message = fakeMessage({
        reply: (payload) => sent.push(payload),
        typing: typingCalls
    });
    const sleeps = [];
    // rng: 0 -> split chance fires; 0 -> two-sentence tie-break keeps both parts
    const parts = await deliverAiReply(message, 'First sentence lands here with plenty of words in it. Second sentence follows now with more words as well.', {
        rng: scriptedRng([0, 0]),
        sleep: (ms) => sleeps.push(ms)
    });

    assert.equal(parts, 2);
    assert.deepEqual(sent, [
        'First sentence lands here with plenty of words in it.',
        'Second sentence follows now with more words as well.'
    ]);
    // typing fired for the first delay, then again between parts
    assert.ok(typingCalls.length >= 2);
    // a human-like gap (>0) happened between parts
    assert.ok(sleeps.some((ms) => ms > 0));
});

// ---------- skip chance (fun-only) ----------

test('reply skip chance fires only on fun keyword triggers', () => {
    assert.equal(shouldSkipReply({ isKeywordTriggered: true, triggerType: 'fun', rng: alwaysBelow }), true);
});

test('reply skip chance never fires for stress triggers, mentions, or non-keyword messages', () => {
    for (const rng of [alwaysBelow, alwaysAbove]) {
        assert.equal(shouldSkipReply({ isKeywordTriggered: true, triggerType: 'stress', rng }), false);
        assert.equal(shouldSkipReply({ isKeywordTriggered: false, triggerType: 'fun', rng }), false);
        assert.equal(shouldSkipReply({ isKeywordTriggered: false, triggerType: null, rng }), false);
        assert.equal(shouldSkipReply({ rng }), false);
    }
});

test('reply skip chance respects its tunable threshold', () => {
    // rng roll exactly below the chance -> skip; at/above -> reply
    assert.equal(shouldSkipReply({ isKeywordTriggered: true, triggerType: 'fun', rng: () => FUN_REPLY_SKIP_CHANCE - 0.001 }), true);
    assert.equal(shouldSkipReply({ isKeywordTriggered: true, triggerType: 'fun', rng: () => FUN_REPLY_SKIP_CHANCE }), false);
});

// ---------- emoji reaction chance ----------

test('emoji reaction chance fires only on fun keyword triggers', () => {
    const emoji = pickReactionEmoji({ isKeywordTriggered: true, triggerType: 'fun', rng: alwaysBelow });
    assert.ok(FUN_EMOJI_POOL.includes(emoji));
});

test('emoji reaction never applies to stress triggers', () => {
    for (const rng of [alwaysBelow, alwaysAbove]) {
        assert.equal(pickReactionEmoji({ isKeywordTriggered: true, triggerType: 'stress', rng }), null);
    }
});

test('emoji reaction never applies to non-keyword messages', () => {
    assert.equal(pickReactionEmoji({ isKeywordTriggered: false, triggerType: 'fun', rng: alwaysBelow }), null);
    assert.equal(pickReactionEmoji({ rng: alwaysBelow }), null);
});

test('emoji reaction respects its tunable threshold', () => {
    assert.ok(pickReactionEmoji({ isKeywordTriggered: true, triggerType: 'fun', rng: () => FUN_EMOJI_REACTION_CHANCE - 0.001 }));
    assert.equal(pickReactionEmoji({ isKeywordTriggered: true, triggerType: 'fun', rng: () => FUN_EMOJI_REACTION_CHANCE }), null);
});

test('emoji reaction picks from the curated pool', () => {
    const pool = new Set();
    for (let i = 0; i < 200; i += 1) {
        const emoji = pickReactionEmoji({ isKeywordTriggered: true, triggerType: 'fun', rng: Math.random });
        if (emoji) pool.add(emoji);
    }
    for (const emoji of pool) assert.ok(FUN_EMOJI_POOL.includes(emoji));
});

// ---------- delivery helpers ----------

function instantSleep() {
    const sleeps = [];
    const sleep = (ms) => sleeps.push(ms);
    sleep.recorded = sleeps;
    return sleep;
}

function fakeMessage({ reply, typing } = {}) {
    const typingCalls = typing || [];
    return {
        channel: {
            sendTyping: async () => {
                typingCalls.push(1);
            }
        },
        reply: reply || (() => {})
    };
}
