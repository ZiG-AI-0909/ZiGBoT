// Human-like reply delivery for ZiGBoT.
//
// This module only changes HOW replies are delivered (pacing, splitting,
// occasional skip/reaction) — never what they say or which actions trigger.
// All tunable values live as named constants below; no magic numbers in the
// logic so they are easy to adjust without hunting through code.

// --- Tunable constants -------------------------------------------------------

// Simulated typing speed, in words per minute. The delay before a reply is
// derived from this: words / WPM * 60_000 ms, clamped to the min/max below.
const TYPING_WPM_MIN = 40;
const TYPING_WPM_MAX = 60;

// Reply pacing clamps, in milliseconds. Short replies never feel sluggish
// (minimum) and very long replies never take absurdly long (maximum).
const TYPING_DELAY_MIN_MS = 800;
const TYPING_DELAY_MAX_MS = 4500;

// Discord's typing indicator lasts ~10s per sendTyping() call. When the
// computed delay exceeds this window, we re-send typing partway through so
// the indicator never dies before the message lands.
const TYPING_INDICATOR_WINDOW_MS = 9000;

// Base pause between messages of a split reply, plus a small random jitter
// added on top of it, in milliseconds. Kept short and human-feeling.
const MULTI_MESSAGE_BASE_GAP_MS = 1200;
const MULTI_MESSAGE_JITTER_MS = 600;

// Chance (0..1) that a fun-keyword-triggered reply is silently skipped
// entirely: no message, no reaction, no typing. Intentionally never applied
// to stress triggers — those always get a real supportive reply.
const FUN_REPLY_SKIP_CHANCE = 0.12;

// Chance (0..1) that a fun-keyword-triggered message gets an emoji reaction
// instead of a text reply. Stress triggers, mentions, and tool results are
// never eligible. Evaluated only when the skip chance did not fire.
const FUN_EMOJI_REACTION_CHANCE = 0.18;

// Curated emoji pool matching ZiGBoT's savage/witty persona; picked at random
// per reaction so it is not always the same one.
const FUN_EMOJI_POOL = ['😂', '💀', '👀', '🔥', '😭', '🤡', '🥶'];

// Chance (0..1) that an organic persona reply is split into 2-3 shorter
// messages sent with a human-like gap between them.
const MULTI_MESSAGE_SPLIT_CHANCE = 0.25;

// Replies shorter than this many words are never split.
const MULTI_MESSAGE_MIN_WORDS = 15;

// Maximum number of messages a split reply may produce.
const MULTI_MESSAGE_MAX_PARTS = 3;

// --------------------------------------------------------------------------------

const DEFAULT_RNG = () => Math.random();
const DEFAULT_SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORD_COUNT_REGEX = /\S+/g;

function countWords(text) {
    const matches = text.match(WORD_COUNT_REGEX);
    return matches ? matches.length : 0;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// Words per minute picks a random speed within [TYPING_WPM_MIN, TYPING_WPM_MAX]
// each time, so the same reply length does not always take the same time.
function pickWpm(rng) {
    return TYPING_WPM_MIN + rng() * (TYPING_WPM_MAX - TYPING_WPM_MIN);
}

// Delay for a reply of the given length, in milliseconds. Roughly simulates
// typing at TYPING_WPM_MIN-TYPING_WPM_MAX, clamped to a sensible min/max so
// short replies are not sluggish and long ones are not absurd.
function computeTypingDelay(text, rng = DEFAULT_RNG) {
    const words = countWords(text);
    const wpm = pickWpm(rng);
    const rawMs = (words / wpm) * 60_000;
    return Math.round(clamp(rawMs, TYPING_DELAY_MIN_MS, TYPING_DELAY_MAX_MS));
}

// True when a reply of this shape is eligible for the multi-message split:
// long enough, plain text, and not a tool/admin result. Short replies and
// structured results (get_server_info, moderation confirmations) never split.
function canSplit(text, options = {}) {
    if (!text) return false;
    if (options.isToolResult) return false;
    if (countWords(text) < MULTI_MESSAGE_MIN_WORDS) return false;
    return true;
}

// Split a persona reply into 2-3 natural-feeling parts on sentence/thought
// boundaries. Keeps it simple: break at sentence enders, then at clause
// separators, never mid-word. Returns [text] unchanged when no clean split
// is possible.
function splitReply(text, rng = DEFAULT_RNG) {
    const clean = text.trim();
    if (!canSplit(clean)) return [clean];

    // Break points, longest punctuation first.
    const sentences = clean
        .split(/(?<=[.!?…])\s+/)
        .map((part) => part.trim())
        .filter(Boolean);

    if (sentences.length < 2) {
        // No sentence boundary: try a clause break (comma / ellipsis).
        const clauseIndex = clean.search(/,\s+/);
        if (clauseIndex === -1 || clauseIndex < 10) return [clean];
        const head = clean.slice(0, clauseIndex + 1).trim();
        const tail = clean.slice(clauseIndex + 1).trim();
        if (!head || !tail) return [clean];
        return rng() < 0.5 ? [head, tail] : [head, `${tail}`];
    }

    if (sentences.length === 2) {
        return rng() < 0.5
            ? sentences
            : [sentences.join(' ')];
    }

    // 3+ sentences: merge sentences into at most MULTI_MESSAGE_MAX_PARTS parts.
    const parts = [];
    let index = 0;
    while (index < sentences.length) {
        const remaining = sentences.length - index;
        const slotsLeft = MULTI_MESSAGE_MAX_PARTS - parts.length;
        // Not enough slots left for one sentence each: merge proportionally.
        const take = remaining > slotsLeft
            ? Math.ceil(remaining / slotsLeft)
            : (remaining > 2 && slotsLeft > 1 && rng() < 0.5 ? 2 : 1);
        parts.push(sentences.slice(index, index + take).join(' '));
        index += take;
    }
    return parts;
}

// True when this keyword-triggered reply should be dropped entirely.
// Applies ONLY to fun-keyword triggers — stress never skips.
function shouldSkipReply({ isKeywordTriggered = false, triggerType = null, rng = DEFAULT_RNG } = {}) {
    if (!isKeywordTriggered || triggerType !== 'fun') return false;
    return rng() < FUN_REPLY_SKIP_CHANCE;
}

// Pick a reaction emoji for a fun-triggered message, or null when this reply
// should be a normal text reply. Never applies to stress triggers.
function pickReactionEmoji({ isKeywordTriggered = false, triggerType = null, rng = DEFAULT_RNG } = {}) {
    if (!isKeywordTriggered || triggerType !== 'fun') return null;
    if (rng() >= FUN_EMOJI_REACTION_CHANCE) return null;
    const index = Math.floor(rng() * FUN_EMOJI_POOL.length);
    return FUN_EMOJI_POOL[index];
}

// Deliver an AI persona reply with human pacing: typing indicator for a
// length-based delay (re-sent if it outlives Discord's ~10s indicator
// window), then optionally split into 2-3 messages with short gaps between
// them. Returns the number of messages sent. `deps` lets tests inject a
// fake rng/sleep so runs are deterministic.
async function deliverAiReply(message, replyText, {
    isToolResult = false,
    rng = DEFAULT_RNG,
    sleep = DEFAULT_SLEEP,
    log = () => {}
} = {}) {
    // Roll the split chance first so the rng call order stays deterministic
    // for tests: split decision -> (split tie-breaks) -> typing delay.
    const shouldAttemptSplit = !isToolResult && rng() < MULTI_MESSAGE_SPLIT_CHANCE;
    const parts = shouldAttemptSplit
        ? splitReply(replyText, rng)
        : [replyText];

    const shouldSplit = parts.length > 1;
    const firstChunk = shouldSplit ? parts[0] : replyText;

    // Keep typing alive for the full computed delay of the first chunk;
    // re-send the indicator if the delay outlives Discord's window.
    let remaining = computeTypingDelay(firstChunk, rng);
    const typing = message.channel.sendTyping();
    while (remaining > 0) {
        const wait = Math.min(remaining, TYPING_INDICATOR_WINDOW_MS);
        await sleep(wait);
        remaining -= wait;
        if (remaining > 0) {
            await message.channel.sendTyping().catch(() => {});
        }
    }
    await typing.catch(() => {});

    // Send each part, pausing between them with a human-like gap. The
    // typing indicator reappears during each gap so the channel still shows
    // the bot as typing while the next part is being "written".
    for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) {
            await message.channel.sendTyping().catch(() => {});
            await sleep(MULTI_MESSAGE_BASE_GAP_MS + rng() * MULTI_MESSAGE_JITTER_MS);
        }
        await message.reply(parts[i]);
        log(`delivered part ${i + 1}/${parts.length}`);
    }

    return parts.length;
}

module.exports = {
    // constants (exported for tests and future tuning visibility)
    TYPING_WPM_MIN,
    TYPING_WPM_MAX,
    TYPING_DELAY_MIN_MS,
    TYPING_DELAY_MAX_MS,
    TYPING_INDICATOR_WINDOW_MS,
    MULTI_MESSAGE_BASE_GAP_MS,
    MULTI_MESSAGE_JITTER_MS,
    FUN_REPLY_SKIP_CHANCE,
    FUN_EMOJI_REACTION_CHANCE,
    FUN_EMOJI_POOL,
    MULTI_MESSAGE_SPLIT_CHANCE,
    MULTI_MESSAGE_MIN_WORDS,
    MULTI_MESSAGE_MAX_PARTS,
    // functions
    computeTypingDelay,
    canSplit,
    splitReply,
    shouldSkipReply,
    pickReactionEmoji,
    deliverAiReply
};
