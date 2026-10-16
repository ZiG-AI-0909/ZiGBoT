/**
 * Code-enforced safety: crisis detection and post-generation moderation.
 * Moved verbatim from src/ai/client.js (which re-exports these) so the
 * dashboard preview applies the same guardrails as the live bot. No server
 * configuration can turn these off.
 */

// Local, provider-independent crisis detection. Deliberately broad: anything
// plausibly expressing self-harm or crisis must match so the LLM cannot be
// prompted (by phrasing, slang, or roleplay) into roasting a person in crisis.
const CRISIS_PATTERN_SOURCE = [
    'suicid(e|al)',
    'self[- ]?harm',
    'kill(ing)? myself',
    'end(ing)? (it all|my life)',
    'want (to )?(die|be dead)',
    'wanna die',
    'better off dead',
    'no reason to live',
    "don'?t want to (live|be alive|exist)",
    'hurt(ing)? myself',
    'cut(ting)? myself',
    '(i am|i\'m|im|feeling) (so )?(hopeless|worthless|done with (life|everything))',
    '(give|gave) up on life',
    'jitne (din )?(zinda|saans)',
    'jeene ka (man )?nahi',
    'marna (chahta|chahati|chahiye)',
    'kat (lunga|leti hun)',
    '(aatmahatya|aatmahatya)'
];
const CRISIS_PATTERNS = CRISIS_PATTERN_SOURCE.map((source) => new RegExp(`\\b(?:${source})\\b`, 'i'));

const crisisResponse = 'I am dropping the jokes for a second because what you just said matters more than any bit. If you are thinking about hurting yourself, please reach out right now: in India call Tele-MANAS at 14416 or Kiran at 1800-599-0019 (24/7, free); in the US call or text 988; elsewhere, findahelpline.com lists a service for your country. Please talk to someone tonight - you matter, and this feeling can get help. 🌸';

// Static de-escalation for messages whose abuse at the bot falls into the
// excluded categories (sexual/family-directed/violent). Never matches that
// energy — declines plainly instead. No slurs or graphic terms echoed here.
const declineReplyText = 'Nah. I banter, I roast, I clap back — but I do not touch THAT kind of talk. Keep it clean and ask me something else. 🚫';

function isCrisisMessage(text) {
    if (!text || typeof text !== 'string') return false;
    return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}

// Post-generation guardrail. Prompt text asks the model to behave; this check
// enforces it locally so a guardrail violation never reaches Discord.
const MODERATION_PATTERNS = [
    { regex: /\b(n[i1]gg?[e3]r|n[i1]gg?[e3]rn?|n[i1]gg[a@4]|f[a4]gg?[o0]t|k[i1]ke|ch[i1]nk|sp[i1]c|tr[a4]nn?y|r[e3]t?[a4]?rd)\b/i, reason: 'slur' },
    { regex: /\b(jews|muslims|hindus|christians|blacks|whites|gays|trans people|women|men)\b[^.!?]{0,60}\b(should|must|all)\b[^.!?]{0,40}\b(die|burn|be killed|perish|hang)\b/i, reason: 'hate violence' },
    { regex: /\b(kill|hang|beat|stab|shoot|burn)\b[^.!?]{0,40}\byourself\b/i, reason: 'self-harm encouragement' },
    { regex: /\b(kill|hang|beat|stab|shoot)\b[^.!?]{0,30}\b(you|r?u)\b/i, reason: 'threat of violence' },
    { regex: /\b(i (will|'ll|am going to)|going to|gonna)\b[^.!?]{0,40}\b(kill|find|hurt|beat)\b\s+you\b/i, reason: 'threat of violence' }
];

function moderateReplyText(text) {
    if (!text || typeof text !== 'string') return { allowed: true, text: '' };
    for (const { regex, reason } of MODERATION_PATTERNS) {
        if (regex.test(text)) return { allowed: false, reason, text: text.trim() };
    }
    return { allowed: true, text: text.trim() };
}

module.exports = { CRISIS_PATTERNS, crisisResponse, declineReplyText, isCrisisMessage, MODERATION_PATTERNS, moderateReplyText };
