// Detects profanity/abuse directed AT ZiGBoT, so the bot can fire back a
// savage comeback instead of a soft reply. Pattern/keyword level by design:
// the goal is detecting THAT someone swore at the bot, not cataloging every
// possible slur. No actual slurs, sexual terms, or violent phrases are
// hardcoded here — common casual profanity only.

// --- Tunable constants -------------------------------------------------------

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

// The message must additionally look like it targets the bot: a second-person
// marker or an explicit bot reference. This keeps casual profanity elsewhere
// in a sentence ("this shit is funny @bot") and insults aimed at OTHER users
// ("roast him, he's a chutiya") from triggering the comeback path.
const TARGETING_PATTERN = /\b(you|your|you'?re|u|ur|tu|tere|teri|tera|tujhe|tujh|tum|tumhara|bot|zigbot)\b/i;

const ESCAPE_REGEX = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PROFANITY_PATTERNS = PROFANITY_TERMS.map(
    (term) => new RegExp(`\\b${ESCAPE_REGEX(term)}\\b`, 'i')
);
const EXCLUDED_PATTERNS = EXCLUDED_TERMS.map(
    (term) => new RegExp(`\\b${ESCAPE_REGEX(term)}\\b`, 'i')
);

function matchTerm(text, patterns) {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return match[0];
    }
    return null;
}

/**
 * Detects profanity/abuse directed at the bot. The caller gates on the
 * message already targeting the bot (mention / reply to the bot).
 *
 * Returns one of:
 *   { matched: true,  category: 'excluded',  term }  -> guardrail path (no roast)
 *   { matched: true,  category: 'profanity', term }  -> savage comeback path
 *   { matched: false }
 */
function detectProfanityAtBot(text) {
    if (!text || typeof text !== 'string') {
        return { matched: false, category: null, term: null };
    }

    const clean = text.trim();

    // Excluded categories always win, regardless of targeting phrasing.
    const excludedTerm = matchTerm(clean, EXCLUDED_PATTERNS);
    if (excludedTerm) {
        return { matched: true, category: 'excluded', term: excludedTerm };
    }

    const profanityTerm = matchTerm(clean, PROFANITY_PATTERNS);
    if (profanityTerm && TARGETING_PATTERN.test(clean)) {
        return { matched: true, category: 'profanity', term: profanityTerm };
    }

    return { matched: false, category: null, term: null };
}

module.exports = {
    detectProfanityAtBot,
    PROFANITY_TERMS,
    EXCLUDED_TERMS
};
