/**
 * "Who made you?" answers. Short, casual, in the server's language and the
 * member's tone, with several variations so it does not repeat itself.
 * Every variation says only what is true everywhere: ZiG is the creator of
 * ZiGBoT (never "the owner of this server", which is only true in his own
 * server), a fun line about why, and his portfolio link. No Discord ids, no
 * tech stack, no job titles.
 *
 * Built-in tones get a fixed variation (no AI call). A server's custom
 * persona gets one AI reply in that persona, written from
 * creatorPersonaInstruction and checked with withPortfolioLink.
 */
const { languageMode } = require('../../dashboard/lib/shared/personas');

const CREATOR_PORTFOLIO_URL = 'https://aibhaveshportfolio.vercel.app/';
const U = CREATOR_PORTFOLIO_URL;

const CREATOR_REPLIES = Object.freeze({
    english: Object.freeze({
        neutral: Object.freeze([
            `ZiG made me 😎 Built me to keep this server fun and a little chaotic. Check his work: ${U}`,
            `That would be ZiG, the creator of ZiGBoT. He built me so Discord chats get answers and good vibes. His work: ${U}`,
            `ZiG built me! The plan: good answers, good jokes, zero dead chats. More of his stuff: ${U}`
        ]),
        gentle: Object.freeze([
            `ZiG made me ✨ He built me to bring a little comfort and a lot of good vibes to Discord. See his work here: ${U}`,
            `My creator is ZiG 🌸 He made me so every server has a friendly face around. Peek at his work: ${U}`,
            `ZiG built me with lots of care 💖 so no chat ever feels lonely. His portfolio: ${U}`
        ]),
        savage: Object.freeze([
            `ZiG made me, obviously. What, you thought I just spawned? 💀 ${U}`,
            `ZiG built me because this server's chat was drier than your jokes. You're welcome. 😏 ${U}`,
            `The legend ZiG made me. Go look at his work and be humbled: ${U} 🔥`
        ])
    }),
    hinglish: Object.freeze({
        neutral: Object.freeze([
            `Mera creator? ZiG bhai 👑 Usne mujhe banaya taaki server mein thoda masti aur thoda roast chalta rahe. Uska kaam dekh: ${U}`,
            `ZiG ne banaya hai mujhe 😎 taaki chat kabhi dead na ho. Uske projects yahan: ${U}`,
            `ZiGBoT ka creator ZiG hai. Mujhe isliye banaya ki jawab bhi mile aur vibe bhi bani rahe. Dekh: ${U}`
        ]),
        gentle: Object.freeze([
            `ZiG ne mujhe banaya ✨ taaki server mein sabko thoda sukoon aur good vibes milein. Uska kaam yahan dekho: ${U}`,
            `Mera creator ZiG hai 🌸 usne mujhe pyaar se banaya taaki chat mein koi akela feel na kare. Portfolio: ${U}`
        ]),
        savage: Object.freeze([
            `ZiG ne banaya, obviously. Tujhe kya laga, khud spawn hua? 💀 ${U}`,
            `ZiG bhai ne banaya, taaki is server ki dry chat mein thodi jaan aaye. Zarurat thi, maan le 😏 ${U}`,
            `Creator? ZiG. Abhi bhi impressed nahi hai toh ye dekh: ${U} 🔥`
        ])
    })
});

/** 'english' | 'hinglish'. Unset or mixed: Savage keeps its Hinglish style, the rest English. */
function creatorLanguage(tone, language) {
    return languageMode(language) || (tone === 'savage' ? 'hinglish' : 'english');
}

/** One fixed "who made you" reply for a built-in tone. */
function creatorAnswer({ tone = 'neutral', language = '', rng = Math.random } = {}) {
    const byTone = CREATOR_REPLIES[creatorLanguage(tone, language)];
    const pool = byTone[tone] || byTone.neutral;
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** Extra system text for a custom persona answering "who made you". */
function creatorPersonaInstruction(language = '') {
    const mode = languageMode(language);
    const lang = mode === 'hinglish' ? ' Reply in Hinglish.' : mode === 'english' ? ' Reply in English.' : '';
    return `\n\nTHIS TURN: the member is asking who made you. Answer in your persona, in 1 to 3 short, casual sentences: ZiG is the creator of ZiGBoT and made you; add one fun line about why (to keep Discord servers fun, helpful and a little chaotic); include this link exactly once: ${CREATOR_PORTFOLIO_URL}. Do not mention Discord ids, libraries, AI models, or job titles, and do not call ZiG the owner of this server.${lang}`;
}

/** The AI reply with the portfolio link guaranteed (appended if the model left it out). */
function withPortfolioLink(text) {
    const clean = String(text || '').trim();
    return clean.includes(CREATOR_PORTFOLIO_URL) ? clean : `${clean} ${CREATOR_PORTFOLIO_URL}`.trim();
}

module.exports = {
    CREATOR_PORTFOLIO_URL,
    CREATOR_REPLIES,
    creatorAnswer,
    creatorLanguage,
    creatorPersonaInstruction,
    withPortfolioLink
};
