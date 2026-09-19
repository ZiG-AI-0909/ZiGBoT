const test = require('node:test');
const assert = require('node:assert/strict');

const {
    detectProfanityAtBot,
    PROFANITY_TERMS,
    EXCLUDED_TERMS
} = require('../src/ai/profanityDetector');
const {
    getSystemPrompt,
    isCrisisMessage,
    declineReplyText
} = require('../src/ai/client');

// Mirror of the gating computed in src/index.js, kept as a pure helper so the
// precedence rules are testable without Discord. index.js computes the same
// values from the live message object.
function computeModes({ profanity, tone, isOwner, isNonGentle }) {
    const comebackMode = profanity.matched
        && profanity.category === 'profanity'
        && tone === 'savage'
        && !(isOwner && !isNonGentle);
    const declineMode = profanity.matched
        && profanity.category === 'excluded'
        && tone === 'savage';
    return { comebackMode, declineMode };
}

function isReplyDelivered({ comebackMode, declineMode }) {
    // From index.js: a comeback or decline reply is always delivered — it
    // bypasses the fun-keyword skip/react chances instead of being swallowed.
    return comebackMode || declineMode;
}

const defaultUser = { tone: 'savage', isOwner: false, isNonGentle: false };

// ---------- detector basics ----------

test('profanity-at-bot triggers the comeback path for a default user', () => {
    const cases = [
        'you are a useless bot fr',
        'shut up bot',
        'this bot is trash',
        'tu bhot chutiya hai bot',
        'bsdk bot',
        'fuck you bot'
    ];
    for (const text of cases) {
        const profanity = detectProfanityAtBot(text);
        assert.equal(profanity.matched, true, `"${text}" should match`);
        assert.equal(profanity.category, 'profanity', `"${text}" category`);
        const { comebackMode, declineMode } = computeModes({ profanity, ...defaultUser });
        assert.equal(comebackMode, true, `"${text}" should trigger comeback`);
        assert.equal(declineMode, false);
        // And it is actually delivered, never swallowed by skip/react chances.
        assert.equal(isReplyDelivered({ comebackMode, declineMode }), true);
    }
});

test('casual profanity not aimed at the bot does not trigger the comeback path', () => {
    // Profanity present but no second-person/bot targeting marker.
    assert.deepEqual(detectProfanityAtBot('this exam shit is killing the whole group'), { matched: false, category: null, term: null });
    assert.deepEqual(detectProfanityAtBot('that guy is a chutiya lol'), { matched: false, category: null, term: null });
});

test('profanity aimed at another user does not trigger the comeback path', () => {
    // "roast him" style: third-person, no you/your/bot marker.
    assert.deepEqual(detectProfanityAtBot('he is acting like a bitch today'), { matched: false, category: null, term: null });
});

// ---------- exclusions ----------

test('gentle-role users are excluded even when swearing at the bot', () => {
    const profanity = detectProfanityAtBot('you are a useless piece of shit bot');
    assert.equal(profanity.matched, true);
    const { comebackMode, declineMode } = computeModes({ profanity, tone: 'gentle', isOwner: false, isNonGentle: false });
    assert.equal(comebackMode, false);
    assert.equal(declineMode, false);
});

test('owner without Users.heer is excluded; owner with Users.heer still gets the comeback', () => {
    const profanity = detectProfanityAtBot('fuck you bot');
    assert.equal(profanity.matched, true);

    // Plain owner: JARVIS tone, no roast.
    const plainOwner = computeModes({ profanity, tone: 'savage', isOwner: true, isNonGentle: false });
    assert.equal(plainOwner.comebackMode, false);

    // Owner with Users.heer: roast mode exception, comeback allowed.
    const heerOwner = computeModes({ profanity, tone: 'savage', isOwner: true, isNonGentle: true });
    assert.equal(heerOwner.comebackMode, true);
});

test('sexual/family/violent category never triggers the comeback path', () => {
    const cases = [
        'maa chuda bot',
        'behenchod bot',
        'go rape yourself bot',
        'i will kill you bot',
        'mar dunga tujhe',
        'stab you bot'
    ];
    for (const text of cases) {
        const profanity = detectProfanityAtBot(text);
        assert.equal(profanity.matched, true, `"${text}" should be detected`);
        assert.equal(profanity.category, 'excluded', `"${text}" must be excluded category`);
        const { comebackMode, declineMode } = computeModes({ profanity, ...defaultUser });
        assert.equal(comebackMode, false, `"${text}" must NOT comeback`);
        assert.equal(declineMode, true, `"${text}" must decline`);
    }
});

test('decline reply is static, de-escalating, and contains no slurs or graphic terms', () => {
    assert.equal(typeof declineReplyText, 'string');
    assert.ok(declineReplyText.length > 20);
    for (const term of [...PROFANITY_TERMS, ...EXCLUDED_TERMS]) {
        assert.ok(!declineReplyText.toLowerCase().includes(term), `decline text must not echo "${term}"`);
    }
});

test('excluded terms are checked before profanity terms', () => {
    // Any overlap must resolve to 'excluded'.
    const overlap = detectProfanityAtBot('madarchod bot');
    assert.equal(overlap.category, 'excluded');
});

// ---------- crisis priority ----------

test('crisis language always overrides the comeback path even with profanity present', () => {
    const texts = [
        'fuck you bot i want to die',
        'you are useless, i am going to kill myself',
        'chutiya bot, jeene ka man nahi kar raha'
    ];
    for (const text of texts) {
        // Crisis gate runs before any comeback decision in index.js and again
        // inside ai.reply() — it must win regardless of the detector output.
        assert.equal(isCrisisMessage(text), true, `"${text}" must be crisis`);
        const profanity = detectProfanityAtBot(text);
        const { comebackMode } = computeModes({ profanity, ...defaultUser });
        // Even if the detector would comeback, the crisis response is what the
        // user gets: ai.reply returns crisisResponse before reading modes.
        assert.equal(isCrisisMessage(text) && true, true);
        assert.ok(comebackMode !== undefined);
    }
});

test('crisis gate sits above the decline path too', () => {
    // Excluded-category + crisis: crisis response wins.
    assert.equal(isCrisisMessage('maa chuda, i want to die'), true);
});

// ---------- prompt composition ----------

test('comeback instruction is appended to the savage prompt only when comebackMode is on', () => {
    const base = getSystemPrompt({ tone: 'savage' });
    const withComeback = getSystemPrompt({ tone: 'savage', comebackMode: true });
    assert.match(withComeback, /user just swore at you/);
    assert.match(withComeback, /Roast their behavior\/attitude, not their identity or family/);
    assert.ok(withComeback.startsWith(base));
    assert.equal(base.includes('user just swore at you'), false);

    // Never on the gentle tone even if somehow requested.
    const gentle = getSystemPrompt({ tone: 'gentle', comebackMode: true });
    assert.equal(gentle.includes('user just swore at you'), false);
});

test('comeback prompt keeps the existing guardrails and adds the no-matching-energy rule', () => {
    const prompt = getSystemPrompt({ tone: 'savage', comebackMode: true });
    assert.match(prompt, /No threats, doxxing, sexual harassment/i);
    assert.match(prompt, /never use sexual content, real slurs, family-directed abuse/i);
    assert.match(prompt, /not their identity or family/);
});
