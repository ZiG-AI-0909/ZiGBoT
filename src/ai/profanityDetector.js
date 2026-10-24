// Detects profanity/abuse directed AT ZiGBoT, so the bot can fire back a
// savage comeback instead of a soft reply. Pattern/keyword level by design:
// the goal is detecting THAT someone swore at the bot, not cataloging every
// possible slur. No actual slurs, sexual terms, or violent phrases are
// hardcoded here — common casual profanity only.

// --- Tunable constants -------------------------------------------------------

// PROFANITY_TERMS (comeback path) and EXCLUDED_TERMS (sexual abuse/slurs and
// violence, always win) live in dashboard/lib/shared/profanity.js so the
// dashboard's bot-identity name filter uses the same lists.
const { PROFANITY_TERMS, EXCLUDED_TERMS } = require('../../dashboard/lib/shared/profanity');

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
