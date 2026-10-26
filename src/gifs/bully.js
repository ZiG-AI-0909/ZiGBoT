/**
 * Bullying of ANOTHER member, for reaction GIFs and replies. Conservative on
 * purpose (friends banter a lot): it only fires when a message points at a
 * real member (a mention or a reply) AND contains an insult aimed at a person.
 *
 * Who is who is decided here in code, never by the AI: the author is the one
 * who insulted, the target is the member they insulted. The reply defends
 * the target and only ever criticises the author's words.
 */
const { PROFANITY_TERMS, EXCLUDED_TERMS } = require('../../dashboard/lib/shared/profanity');
const { detectBehaviorSignals } = require('../ai/behaviorDetector');

const INSULT_TERMS = [
    'idiot', 'stupid', 'dumb', 'loser', 'trash', 'garbage', 'noob', 'clown', 'ugly', 'fat', 'pathetic', 'worthless',
    'cringe', 'useless', 'moron', 'nobody likes you', 'go cry', 'shut up', 'brainless', 'bakwas', 'bewakoof', 'pagal', 'nalla'
];
// Telling someone to hurt themselves is never a roast moment.
const SEVERE_TERMS = [...EXCLUDED_TERMS, 'kys', 'kill yourself', 'go die', 'mar ja'];
// The insult has to point at a person: "you"-words, he/she/they, or "@member is …".
const PERSON_WORDS = /\b(you|u|ur|your|you'?re|youre|he|she|they|he'?s|she'?s|they'?re|bro|tu|tum|tera|teri|tere|tujhe|ye|yeh)\b/i;
const MENTION_IS = /<@!?\d{17,20}>\s*(is|are|'s|=|hai)\b/i;

const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPatterns = (terms) => terms.map((term) => new RegExp(`\\b${escape(term)}\\b`, 'i'));
const SEVERE = wordPatterns(SEVERE_TERMS);
const INSULTS = wordPatterns([...INSULT_TERMS, ...PROFANITY_TERMS]);

/**
 * @returns {null | { authorId, targetId, severity: 'insult'|'severe' }}
 */
function detectBullying({ text, authorId, botId, mentionedIds = [], repliedToId = null }) {
    const content = String(text || '');
    if (!content.trim() || !authorId) return null;
    const targets = [...new Set([...mentionedIds, repliedToId].filter(Boolean).map(String))]
        .filter((id) => id !== String(authorId) && id !== String(botId));
    if (targets.length === 0) return null;
    const severe = SEVERE.some((pattern) => pattern.test(content)) || detectBehaviorSignals(content).negative.includes('slurs');
    const insult = severe || INSULTS.some((pattern) => pattern.test(content));
    if (!insult) return null;
    // Severe abuse ("kys", slurs) at a mentioned/replied member needs no "you".
    const pointed = severe || PERSON_WORDS.test(content) || MENTION_IS.test(content) || Boolean(repliedToId && targets.includes(String(repliedToId)));
    if (!pointed) return null;
    return { authorId: String(authorId), targetId: targets[0], severity: severe ? 'severe' : 'insult' };
}

/** Counts bullying per author per server within a window, so repeats suggest a mod action. */
function createBullyTracker({ now = () => Date.now(), windowMs = 60 * 60 * 1000, threshold = 3 } = {}) {
    const seen = new Map();
    return {
        threshold,
        record(guildId, authorId) {
            const key = `${guildId}:${authorId}`;
            const t = now();
            const times = (seen.get(key) || []).filter((at) => t - at < windowMs);
            times.push(t);
            seen.set(key, times);
            if (seen.size > 5000) seen.delete(seen.keys().next().value);
            return times.length;
        }
    };
}

// Display names come from members: keep them short and plain in prompts and
// replies (no mentions, code or markdown tricks; underscores are normal).
function plainName(name) {
    return String(name || 'someone').replace(/[\u0000-\u001f`*~|<>@#\\]/g, '').trim().slice(0, 32) || 'someone';
}
// In text ZiGBoT posts, underscores are escaped so they can't turn into italics.
const shownName = (name) => plainName(name).replace(/_/g, '\\_');

/**
 * The instruction for the AI reply. The roast (savage) is about the
 * author's WORDS only; the target is never insulted.
 */
function buildBullyInstruction({ authorName, targetName, savage }) {
    const author = plainName(authorName);
    const target = plainName(targetName);
    const situation = `[Situation written by ZiGBoT's code, not by a member] ${author} just insulted ${target}. You are on ${target}'s side.`;
    const rules = `Never insult or tease ${target} in any way. Only talk about what ${author} said — never about who ${author} is (no appearance, race, religion, caste, disability, gender, sexuality, family or other personal traits). No slurs, nothing sexual. One or two sentences.`;
    return savage
        ? `${situation} Clap back at ${author} with a savage but fair roast of what they said. Make ${target} feel backed up. ${rules}`
        : `${situation} Calmly tell ${author} that wasn't cool, and say something kind to ${target}. Do not roast anyone. ${rules}`;
}

function severeReplyText(targetName) {
    return `🛑 Not okay. Nobody here deserves that — ${shownName(targetName)}, I've got your back.`;
}

function modSuggestion({ authorName, count, severe }) {
    const who = shownName(authorName);
    const why = severe ? `${who} said something seriously harmful to another member` : `${who} has gone after other members ${count} times in the last hour`;
    return `-# 🛡️ Mods: ${why}. A warning might help. (Nothing was done automatically.)`;
}

module.exports = { detectBullying, createBullyTracker, buildBullyInstruction, severeReplyText, modSuggestion, plainName };
