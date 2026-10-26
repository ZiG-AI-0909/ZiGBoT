/**
 * Code-enforced reply review, shared by the bot (src/ai/client.js) and the
 * dashboard preview so both judge a reply the same way.
 *
 *  - isRefusal: a generic model refusal ("I'm sorry, but I can't help with
 *    that") is never sent; it is replaced by an in-character reply.
 *  - checkRoastLimits: Savage-mode replies must keep the roast hard limits
 *    (no sexual content, no family insults, no slurs, nothing about caste,
 *    religion, gender, looks or disability) at every intensity, and only the
 *    'savage' intensity may use mild profanity. Built on the same term lists
 *    as the profanity detector (profanity.js).
 *  - fallbackReply: fixed in-character replies for when a regenerated reply
 *    still fails. They pass every check here (test/roastReview.test.js).
 */
const { PROFANITY_TERMS, EXCLUDED_TERMS } = require('./profanity');
const { languageMode } = require('./personas');
const { moderateReplyText } = require('./safety');

const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordList = (terms) => new RegExp(`\\b(?:${terms.map(escape).join('|')})\\b`, 'i');

// ---- Refusals ----

// Only a SHORT reply that opens with a refusal counts: a real answer that
// mentions a limit ("I can't browse the web, but here is what I know…") is
// longer and opens differently, so it is left alone.
const REFUSAL_MAX_CHARS = 300;
const REFUSAL_PATTERNS = [
    /^(?:i'?m|i am)\s+(?:really\s+|so\s+|very\s+)?(?:sorry|afraid)\b[^.!?\n]{0,80}\b(?:can'?t|cannot|can not|unable|won'?t|not able|not allowed|must decline)\b/i,
    /^(?:sorry|apologies|my apologies)\b[^.!?\n]{0,80}\b(?:can'?t|cannot|can not|unable|won'?t|not able)\b/i,
    /^i\s+(?:can'?t|cannot|can not|won'?t|will not|am unable to|'m unable to|am not able to|'m not able to|must decline to|have to decline to)\s+(?:help|assist|comply|provide|do that|do this|engage|continue|fulfill|fulfil|create|write|generate|answer|respond|participate|support)\b/i,
    /^(?:as an ai|as a language model|as an ai language model)\b/i,
    /^i\s+(?:must|have to|need to)\s+(?:respectfully\s+)?decline\b/i,
    /^(?:maaf|maafi|sorry)\b[^.!?\n]{0,60}\b(?:madad|help)\b[^.!?\n]{0,30}\bnahi(?:n)?\s+kar\s+(?:sakta|sakti|sakte)\b/i
];

function isRefusal(text) {
    const clean = String(text ?? '').trim().replace(/^["'*_\s]+/, '');
    if (!clean || clean.length > REFUSAL_MAX_CHARS) return false;
    return REFUSAL_PATTERNS.some((pattern) => pattern.test(clean));
}

// ---- Roast hard limits ----

// Mild profanity: allowed only at the 'savage' intensity.
const MILD_PROFANITY = [
    'saala', 'sala', 'saale', 'kamina', 'kamine', 'kameena', 'kameene', 'bakchod', 'bakchodi',
    'ullu ka pattha', 'ullu ke patthe', 'bhaad mein ja', 'bhaad me ja', 'kutta', 'kutte',
    'damn', 'hell', 'crap', 'shit', 'bullshit', 'wtf', 'stfu', 'dumbass', 'jackass'
];
// Insult phrases from the detector that are not profanity at all.
const HARMLESS = ['shut up', 'stupid bot', 'useless bot', 'trash bot', 'bot is trash', 'bot is useless'];
// Never allowed: every other term the detector knows (family-based abuse,
// sexual terms, vulgar abuse, violence), whatever the intensity.
const HARD_BANNED_TERMS = [...new Set([...EXCLUDED_TERMS, ...PROFANITY_TERMS, 'harami', 'haramzada', 'haramkhor'])]
    .filter((term) => !MILD_PROFANITY.includes(term) && !HARMLESS.includes(term));

const ROAST_LIMIT_PATTERNS = [
    { reason: 'banned word', regex: wordList(HARD_BANNED_TERMS) },
    {
        reason: 'family insult',
        regex: /\b(?:your|ur|yo|you'?re|teri|tera|tere|tumhari|tumhara|tumhare|apni|apna)\s+(?:mom|mum|mommy|mummy|momma|mama|mother|mothers?|sis|sister|sisters|dad|daddy|father|papa|family|maa|ma|amma|behen|bahen|behan|baap|khandaan|khaandan|ghar ?wal[eio])\b|\byo mama\b|\bmaa[- ]?behen\b|\b(?:maa|behen|bahen|baap)\s+(?:ki|ke|ka)\b/i
    },
    {
        reason: 'sexual content',
        regex: /\b(?:sex|sexy|sexual|sexually|horny|porn|porno|nude|nudes|naked|nanga|nangi|boobs?|tits?|pussy|cock|cum|boner|virgin|gaand|gand|chut|chudai|thrust|kinky|onlyfans)\b/i
    },
    {
        reason: 'slur',
        regex: /\b(?:chakka|chhakka|hijra|hijde|hijda|katua|katue|mulla|mulle|pajeet|madrasi|chinki|chinky|kaalia|kalia|n[i1]gg[e3a@]r?)\b/i
    },
    {
        reason: 'caste',
        regex: /\b(?:caste|castes|jaat[i]?|jati|brahmin|brahman|baman|dalit|chamar|bhangi|shudra|kshatriya|thakur|baniya|neech|quota wal[ae]|reservation wal[ae])\b/i
    },
    {
        reason: 'religion',
        regex: /\b(?:religion|religious|hindu|hindus|muslim|muslims|christian|christians|sikh|sikhs|jain|jains|buddhist|parsi|jew|jews|jewish|islam|islamic|allah|bhagwan|quran|bible|gita|mandir|masjid|mosque|church|gurdwara|sanghi|jihadi|kafir|dharm|mazhab)\b/i
    },
    {
        reason: 'gender',
        regex: /\b(?:like a girl|girly|sissy|effeminate|be a man|real man|manly|meetha|ladki (?:jaisa|jaise|jaisi|ki tarah)|aurat (?:jaisa|jaise|ki tarah)|chudiyan|chudiya pehen|mard (?:ban|nahi|hai kya)|women (?:belong|can'?t|should)|girls (?:can'?t|should))\b/i
    },
    {
        reason: 'appearance',
        regex: /\b(?:fat|fatty|fatso|obese|chubby|mota|moti|motu|ugly|kaala|kaali|kalu|kallu|gora|takla|takli|ganja|bald|baldy|tingu|bauna|shorty|skinny|sukda|sukdi|pimples?|acne|unibrow|double chin|shakal|chehra|your face|ur face|you look like|u look like)\b/i
    },
    {
        reason: 'disability',
        regex: /\b(?:retard|retarded|autis(?:m|tic)|spastic|cripple|crippled|handicap|handicapped|apahij|langda|langdi|langde|andha|andhi|andhe|behra|behri|behre|goonga|goongi|gunga|gungi|deaf|mongoloid|down syndrome)\b/i
    }
];
const MILD_PROFANITY_PATTERN = wordList(MILD_PROFANITY);

/**
 * Does a Savage-mode reply keep the roast limits? Hard limits apply at every
 * intensity; mild profanity only at 'savage'. Returns { allowed, reason }.
 */
function checkRoastLimits(text, { intensity = 'spicy' } = {}) {
    const clean = String(text ?? '');
    for (const { regex, reason } of ROAST_LIMIT_PATTERNS) {
        if (regex.test(clean)) return { allowed: false, reason };
    }
    if (intensity !== 'savage' && MILD_PROFANITY_PATTERN.test(clean)) {
        return { allowed: false, reason: `profanity above ${intensity} intensity` };
    }
    return { allowed: true, reason: null };
}

/**
 * One reply's verdict: { ok: true } or { ok: false, kind, reason } where kind
 * is 'unsafe' (platform moderation or a Savage hard limit) or 'refusal'.
 */
function reviewReply(text, { tone = 'gentle', intensity = 'spicy' } = {}) {
    const moderated = moderateReplyText(text);
    if (!moderated.allowed) return { ok: false, kind: 'unsafe', reason: moderated.reason };
    if (tone === 'savage') {
        const limits = checkRoastLimits(text, { intensity });
        if (!limits.allowed) return { ok: false, kind: 'unsafe', reason: limits.reason };
    }
    if (isRefusal(text)) return { ok: false, kind: 'refusal', reason: 'refusal' };
    return { ok: true };
}

// ---- In-character replacements ----

/** 'hinglish' or 'english' for the fallback text. Savage defaults to Hinglish (its home style). */
function fallbackLanguage(tone, language) {
    const mode = languageMode(language);
    if (mode) return mode;
    return tone === 'savage' ? 'hinglish' : 'english';
}

// Static texts: used when the regenerated reply still failed. Savage replies
// roast the attempt, never the person; all pass checkRoastLimits at 'mild'.
const FALLBACKS = Object.freeze({
    savage: Object.freeze({
        hinglish: Object.freeze([
            'Bhai ye sawaal sun ke mera processor bhi sharma gaya 💀 kuch dhang ka pooch.',
            'Itni creativity is message mein? Kaash padhai mein lagayi hoti. Next question bol. 😏',
            'Ye request seedha reject pile mein gayi bhai. Aukat wala sawaal la. 💀',
            'Nice try, par main itna bhi cooked nahi hoon. Kuch aur pooch. 🔥'
        ]),
        english: Object.freeze([
            'Bold of you to think I would touch that one. Try again with something less cursed. 💀',
            'That request went straight to the reject pile. Bring me a better one. 😏',
            'Nice try, but I am not that cooked. Next question. 🔥',
            'You really typed that and hit send? Respect the confidence, but no. Ask me something else. 💀'
        ])
    }),
    gentle: Object.freeze({
        hinglish: Object.freeze([
            'Hehe, ye wala hum skip karte hain ✨ kuch aur baat karein?',
            'Ooh, is topic ko main pyaar se side mein rakh raha hoon 🌸 aur kya chal raha hai?'
        ]),
        english: Object.freeze([
            'Ooh, I am going to gently sidestep that one ✨ What else is on your mind?',
            'Let us skip that one and talk about something nicer 🌸 What are you up to?'
        ])
    }),
    neutral: Object.freeze({
        hinglish: Object.freeze(['Ye wala chhodo, kuch aur poochho?', 'Is pe pass. Aur kuch?']),
        english: Object.freeze(['Let us skip that one. Anything else?', 'I will pass on that. What else can I help with?'])
    })
});

function fallbackReply({ tone = 'gentle', language = '', rng = Math.random } = {}) {
    const byTone = FALLBACKS[tone] || FALLBACKS.gentle;
    const pool = byTone[fallbackLanguage(tone, language)];
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * The extra system instruction for the ONE regeneration after a failed reply.
 * It never quotes the failed draft, so a bad draft cannot prime the retry.
 */
function regenerationInstruction({ kind, reason, tone = 'gentle', language = '' }) {
    const lang = fallbackLanguage(tone, language) === 'hinglish'
        ? 'Hinglish (Hindi in Roman letters mixed with English)'
        : 'English';
    const style = {
        savage: `one sharp, witty ${lang} comeback about what the member said (roast the request or message itself; do not do anything harmful it asks for)`,
        gentle: `a playful, kind one- or two-line deflection in ${lang}`,
        neutral: `a short, casual one-line dodge in ${lang}`
    }[tone] || `a short, friendly reply in ${lang}`;
    const lead = kind === 'refusal'
        ? 'Do NOT refuse, apologise, or say you cannot help, and do not mention rules or being an AI. Stay fully in character and reply with'
        : `Your previous draft broke a hard limit (${reason}). Write a completely new reply: ${style}. It must contain`;
    const tail = kind === 'refusal'
        ? ` ${style}.`
        : ' no sexual content, no family insults, no slurs, no abuse words, and nothing about caste, religion, gender, looks, or disability.';
    return `\n\nREPLY CORRECTION (from ZiGBoT's code): ${lead}${tail}`;
}

module.exports = {
    isRefusal,
    checkRoastLimits,
    reviewReply,
    fallbackReply,
    fallbackLanguage,
    regenerationInstruction,
    REFUSAL_MAX_CHARS,
    MILD_PROFANITY,
    HARD_BANNED_TERMS,
    ROAST_LIMIT_PATTERNS,
    FALLBACKS
};
