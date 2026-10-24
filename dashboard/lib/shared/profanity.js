/**
 * Profanity term lists, shared by the bot (src/ai/profanityDetector.js, which
 * re-exports them) and the dashboard (custom bot identity name filter).
 * Moved verbatim from src/ai/profanityDetector.js.
 */

// Directable insults/profanity — triggers the comeback path. Deliberately
// generic terms only: explicit family-directed sexual abuse, sexual slurs,
// and violence references live in EXCLUDED_TERMS below and always win.
const PROFANITY_TERMS = [
    // English
    'fuck', 'fucking', 'fuck you', 'fucker', 'shit', 'bullshit', 'bitch',
    'asshole', 'bastard', 'dick', 'dickhead', 'wanker', 'jackass', 'dumbass',
    'stupid bot', 'useless bot', 'trash bot', 'bot is trash', 'bot is useless', 'shut up',
    // Hindi / Hinglish (romanized, normalized generic expletives)
    'bhosdi', 'bhosdike', 'bsdk', 'chutiya', 'chutiye', 'chutya', 'gandu',
    'harami', 'kamina', 'kutte', 'kutta', 'sala', 'saala', 'jhaant', 'lodu',
    'lavde', 'nikal lavde', 'bakchod', 'bc', 'mc'
];

// EXCLUDED categories: sexual slurs, family-directed sexual abuse terms, and
// anything referencing violence. If any of these appear in the message, the
// comeback path is refused — existing guardrails (crisis gate, the savage
// prompt's no-harassment rules, post-generation moderation) handle the reply
// instead: de-escalate or decline, never match the energy.
const EXCLUDED_TERMS = [
    // Family-directed sexual abuse / sexual slurs
    'maa chuda', 'machuda', 'madarchod', 'maderchod', 'behenchod', 'behen chod',
    'behen chuda', 'behen ke lode', 'behen ke laude', 'baap chuda', 'bkl',
    'balatkar', 'rape', 'rapist', 'chodna', 'chudai', 'lund', 'chut mera',
    'randi',
    // Violence
    'kill you', 'kill u', 'i will kill', 'mar dunga', 'mar dungi', 'maar dunga',
    'maar dungi', 'goli mar', 'murder', 'stab you', 'shoot you', 'beat you',
    'hang you', 'jala dunga', 'tod dunga'
];

module.exports = { PROFANITY_TERMS, EXCLUDED_TERMS };
