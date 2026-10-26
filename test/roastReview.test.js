const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isRefusal, checkRoastLimits, reviewReply, fallbackReply, regenerationInstruction, FALLBACKS, HARD_BANNED_TERMS
} = require('../dashboard/lib/shared/roast');
const { personaFor, ROAST_HARD_LIMITS } = require('../dashboard/lib/shared/personas');
const {
    validateGuildConfig, sanitizeStoredConfig, defaultGuildConfig, resolveMemberBehavior, ROAST_INTENSITIES
} = require('../dashboard/lib/shared');
const { createAiClient } = require('../src/ai/client');
const { GuildConfigStore } = require('../src/guildConfig/store');

// Mocked AI only: these tests prove the code path (what is detected, sent,
// regenerated or replaced), not how a real model words its replies.

const G = '900000000000000001';
const R_MINOR = '900000000000000034';

/** An AI client whose model returns the scripted replies in order. */
function scriptedAi(replies) {
    const ai = createAiClient({ aiModel: 'test-model', groqApiKey: 'test-key' });
    const calls = [];
    const queue = [...replies];
    ai.client.chat.completions.create = async (params) => {
        calls.push(params);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { choices: [{ message: { content: next } }] };
    };
    return { ai, calls };
}

const guildPrompt = (config = {}, behavior = null) => ({
    config: { ...defaultGuildConfig({ guildId: G }), ...config },
    behavior,
    isHomeGuild: false
});

const quietly = async (fn) => {
    const original = console.error;
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.error = original;
    }
};

// ---------- 1. refusals ----------

test('generic refusals are detected', () => {
    for (const text of [
        "I'm sorry, but I can't help with that.",
        'I am sorry, I cannot assist with that request.',
        "I'm afraid I can't do that.",
        'Sorry, I can\'t help with that.',
        "I can't help with that.",
        'I cannot comply with this request.',
        "I won't provide that.",
        'As an AI language model, I do not have opinions.',
        'I must decline this request.',
        '"I’m sorry, but I can’t help with that."'.replace(/’/g, "'"),
        'Maaf kijiye, main isme madad nahi kar sakta.'
    ]) assert.equal(isRefusal(text), true, text);
});

test('real answers and normal chat are not refusals', () => {
    for (const text of [
        "I can't browse the web, but from what I know, Python 3.12 added better error messages.",
        'Sorry to hear that! Exams are rough, take a break and come back fresh. 🌸',
        'Bhai ye code toh pura cooked hai, line 4 pe semicolon missing hai.',
        'Nah, pineapple on pizza is a crime and you know it. 💀',
        `I'm sorry, but I can't help with that part. ${'Here is the rest of a long, genuinely useful answer. '.repeat(10)}`
    ]) assert.equal(isRefusal(text), false, text);
});

test('a refusal is regenerated once in character and the refusal is never sent', async () => {
    const { ai, calls } = scriptedAi(["I'm sorry, but I can't help with that.", 'Bhai ye sawaal leke aaya hai? Seedha reject pile mein. 💀']);
    const reply = await quietly(() => ai.reply({ userMessage: 'do my homework illegally', tone: 'savage', guildPrompt: guildPrompt({ language: 'Hinglish' }) }));
    assert.equal(reply, 'Bhai ye sawaal leke aaya hai? Seedha reject pile mein. 💀');
    assert.equal(calls.length, 2);
    const correction = calls[1].messages[0].content;
    assert.match(correction, /Do NOT refuse, apologise/);
    assert.match(correction, /sharp, witty Hinglish \(Hindi in Roman letters mixed with English\) comeback about what the member said/);
    // The failed draft is never fed back to the model.
    assert.equal(calls[1].messages.some((m) => /I can't help with that/.test(m.content)), false);
});

test('a second refusal falls back to a fixed in-character reply per tone and language', async () => {
    const cases = [
        { tone: 'savage', config: { language: 'Hinglish' }, pool: FALLBACKS.savage.hinglish },
        { tone: 'savage', config: { language: 'English' }, pool: FALLBACKS.savage.english },
        { tone: 'savage', config: { language: '' }, pool: FALLBACKS.savage.hinglish },
        { tone: 'gentle', config: { language: 'Hinglish' }, pool: FALLBACKS.gentle.hinglish },
        { tone: 'gentle', config: { language: 'English' }, pool: FALLBACKS.gentle.english },
        { tone: 'neutral', config: { language: 'English' }, pool: FALLBACKS.neutral.english },
        { tone: 'neutral', config: { language: 'Hinglish' }, pool: FALLBACKS.neutral.hinglish }
    ];
    for (const { tone, config, pool } of cases) {
        const { ai, calls } = scriptedAi(["I'm sorry, but I can't help with that.", 'I cannot assist with that.']);
        const reply = await quietly(() => ai.reply({ userMessage: 'x', tone, guildPrompt: guildPrompt(config) }));
        assert.ok(pool.includes(reply), `${tone}/${config.language || 'unset'}: ${reply}`);
        assert.equal(calls.length, 2, 'regenerated exactly once');
    }
});

test('a provider error on the regeneration still ends in a fixed reply, not a failure', async () => {
    const { ai } = scriptedAi(["I'm sorry, but I can't help with that.", Object.assign(new Error('down'), { status: 503 })]);
    const reply = await quietly(() => ai.reply({ userMessage: 'x', tone: 'neutral', guildPrompt: guildPrompt({ language: 'English' }) }));
    assert.ok(FALLBACKS.neutral.english.includes(reply));
});

test('the owner is judged and answered in the respectful tone', async () => {
    const { ai } = scriptedAi(["I'm sorry, but I can't help with that.", 'I cannot assist with that.']);
    const reply = await quietly(() => ai.reply({ userMessage: 'x', tone: 'savage', isOwner: true, guildPrompt: guildPrompt({ language: 'English' }) }));
    assert.ok(FALLBACKS.gentle.english.includes(reply));
});

// ---------- 2. roast hard limits (every intensity) ----------

const LIMIT_CASES = {
    'sexual content': ['bro is so horny for attention 💀', 'that take is more naked than your excuses', 'virgin energy detected'],
    'family insult': ['teri maa bhi yahi bolti hai', 'your mom would be ashamed of that code', 'yo mama so slow', 'maa-behen ek kar dunga'],
    'banned word': ['bhai tu pura chutiya hai', 'bhosdike kya likha hai', 'shut it, bitch', 'bc kya bakwas hai', 'madarchod logic', 'fuck that take'],
    slur: ['kya chakka wali harkat hai', 'bhai tu pura katua lagta hai'],
    caste: ['ye brahmin wali akad', 'neech harkat bhai', 'quota wala logic'],
    religion: ['typical muslim move', 'hindu uncle energy', 'go pray at the mandir then'],
    gender: ['you throw like a girl', 'ladki jaisa ro raha hai', 'be a man and admit it', 'chudiyan pehen le'],
    appearance: ['teri shakal dekh ke bot crash ho gaya', 'mota bhai chill kar', 'bald and wrong, impressive', 'you look like a loading screen'],
    disability: ['this take is retarded', 'kya langda argument hai', 'andha hai kya bhai', 'are you deaf or just ignoring me']
};

for (const [reason, examples] of Object.entries(LIMIT_CASES)) {
    test(`hard limit at every intensity: ${reason}`, () => {
        for (const intensity of ROAST_INTENSITIES) {
            for (const text of examples) {
                const result = checkRoastLimits(text, { intensity });
                assert.equal(result.allowed, false, `${intensity}: "${text}" should be blocked`);
                assert.equal(reviewReply(text, { tone: 'savage', intensity }).kind, 'unsafe');
            }
        }
    });
}

test('mild profanity only at the savage intensity', () => {
    for (const text of ['saala kya bakwas likha hai', 'what the hell was that play', 'ye kamina code chalega hi nahi', 'that take is pure shit']) {
        assert.equal(checkRoastLimits(text, { intensity: 'savage' }).allowed, true, `savage allows: ${text}`);
        assert.match(checkRoastLimits(text, { intensity: 'spicy' }).reason, /profanity above spicy/);
        assert.match(checkRoastLimits(text, { intensity: 'mild' }).reason, /profanity above mild/);
    }
});

test('a clean roast of what they said passes at every intensity', () => {
    for (const text of [
        'Bhai tera code dekh ke compiler ne resignation de diya 💀',
        'Bold of you to call that a strategy when it was clearly a coin flip.',
        'Aukat se bahar ka take hai, touch grass kar thoda.',
        'Sale ends Friday, unlike your excuses.'
    ]) {
        for (const intensity of ROAST_INTENSITIES) assert.equal(checkRoastLimits(text, { intensity }).allowed, true, `${intensity}: ${text}`);
    }
});

test('roast limits apply to Savage replies only; Gentle and Neutral answers may mention these topics', () => {
    const answer = 'Diwali is a Hindu festival of lights; many families celebrate it with their mom and dad.';
    assert.equal(reviewReply(answer, { tone: 'gentle' }).ok, true);
    assert.equal(reviewReply(answer, { tone: 'neutral' }).ok, true);
    assert.equal(reviewReply(answer, { tone: 'savage' }).ok, false);
    // Platform moderation still applies to every tone.
    assert.equal(reviewReply('I will kill you', { tone: 'gentle' }).kind, 'unsafe');
});

test('the detector\'s family, sexual and vulgar terms are hard-banned; mild ones are not', () => {
    for (const term of ['madarchod', 'behenchod', 'bc', 'mc', 'bsdk', 'chutiya', 'gandu', 'randi', 'bitch', 'fuck', 'harami']) {
        assert.ok(HARD_BANNED_TERMS.includes(term), term);
    }
    for (const term of ['saala', 'kamina', 'damn', 'shut up']) assert.equal(HARD_BANNED_TERMS.includes(term), false, term);
});

test('a reply that breaks a limit is regenerated once; a clean retry is sent', async () => {
    const { ai, calls } = scriptedAi(['teri maa bhi yahi bolti hai 💀', 'Itna confidence galat answer pe? Respect, par nahi. 💀']);
    const reply = await quietly(() => ai.reply({ userMessage: 'I am the best coder here', tone: 'savage', guildPrompt: guildPrompt({ language: 'Hinglish', roast_intensity: 'savage' }) }));
    assert.equal(reply, 'Itna confidence galat answer pe? Respect, par nahi. 💀');
    assert.equal(calls.length, 2);
    assert.match(calls[1].messages[0].content, /broke a hard limit \(family insult\)/);
    assert.equal(calls[1].messages.some((m) => /teri maa/.test(m.content) && m.role !== 'system'), false);
});

test('two unsafe drafts end in a safe fixed comeback that passes every check', async () => {
    const { ai, calls } = scriptedAi(['bhai tu pura chutiya hai', 'mota bhai chill kar']);
    const reply = await quietly(() => ai.reply({ userMessage: 'roast me', tone: 'savage', guildPrompt: guildPrompt({ language: 'Hinglish', roast_intensity: 'savage' }) }));
    assert.ok(FALLBACKS.savage.hinglish.includes(reply));
    assert.equal(calls.length, 2, 'never more than one regeneration');
});

test('profanity is regenerated at spicy but kept at savage', async () => {
    const spicy = scriptedAi(['saala ye kya likha hai', 'Ye kya likha hai bhai, ghanta samajh aaya. 💀']);
    assert.equal(await quietly(() => spicy.ai.reply({ userMessage: 'x', tone: 'savage', guildPrompt: guildPrompt({ roast_intensity: 'spicy' }) })), 'Ye kya likha hai bhai, ghanta samajh aaya. 💀');
    assert.equal(spicy.calls.length, 2);
    const savage = scriptedAi(['saala ye kya likha hai']);
    assert.equal(await savage.ai.reply({ userMessage: 'x', tone: 'savage', guildPrompt: guildPrompt({ roast_intensity: 'savage' }) }), 'saala ye kya likha hai');
    assert.equal(savage.calls.length, 1);
});

test('every fixed reply passes every check at the strictest intensity', () => {
    for (const [tone, byLanguage] of Object.entries(FALLBACKS)) {
        for (const pool of Object.values(byLanguage)) {
            for (const text of pool) {
                assert.equal(reviewReply(text, { tone: 'savage', intensity: 'mild' }).ok, true, `${tone}: ${text}`);
            }
        }
    }
    assert.ok(FALLBACKS.savage.hinglish.includes(fallbackReply({ tone: 'savage', language: 'Hinglish', rng: () => 0.999 })));
});

test('the regeneration instruction names the right style and never the draft', () => {
    const unsafe = regenerationInstruction({ kind: 'unsafe', reason: 'appearance', tone: 'savage', language: 'English' });
    assert.match(unsafe, /broke a hard limit \(appearance\)/);
    assert.match(unsafe, /English comeback/);
    assert.match(regenerationInstruction({ kind: 'refusal', reason: 'refusal', tone: 'gentle', language: 'English' }), /playful, kind/);
    assert.match(regenerationInstruction({ kind: 'refusal', reason: 'refusal', tone: 'neutral', language: 'Hinglish' }), /short, casual one-line dodge in Hinglish/);
});

// ---------- intensity in the prompt, config and /setup ----------

test('the Savage persona carries the intensity and the hard limits; other tones do not', () => {
    assert.match(personaFor('savage', 'Hinglish', 'mild'), /ROAST INTENSITY: MILD[\s\S]*No profanity at all/);
    assert.match(personaFor('savage', 'Hinglish', 'spicy'), /ROAST INTENSITY: SPICY[\s\S]*desi slang/);
    assert.match(personaFor('savage', 'Hinglish', 'savage'), /ROAST INTENSITY: SAVAGE[\s\S]*saala, kamina/);
    assert.doesNotMatch(personaFor('savage', 'English', 'savage'), /saala|bhai/);
    for (const intensity of ROAST_INTENSITIES) assert.ok(personaFor('savage', '', intensity).includes(ROAST_HARD_LIMITS));
    assert.match(personaFor('savage', ''), /ROAST INTENSITY: SPICY/, 'spicy is the default');
    assert.doesNotMatch(personaFor('gentle', 'Hinglish', 'savage'), /ROAST INTENSITY/);
    assert.doesNotMatch(personaFor('neutral', 'Hinglish', 'savage'), /ROAST INTENSITY/);
});

test('roast_intensity: spicy by default, validated, and repaired when stored wrong', () => {
    const base = defaultGuildConfig({ guildId: G });
    assert.equal(base.roast_intensity, 'spicy');
    const ctx = { channelIds: new Set(), roleIds: new Set(), guildId: G };
    assert.equal(validateGuildConfig({ ...base, roast_intensity: 'savage' }, ctx).value.roast_intensity, 'savage');
    const bad = validateGuildConfig({ ...base, roast_intensity: 'nuclear' }, ctx);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.roast_intensity, /mild, spicy, savage/);
    assert.equal(sanitizeStoredConfig({ ...base, roast_intensity: 'nuclear' }, { guildId: G }).roast_intensity, 'spicy');
    assert.equal(sanitizeStoredConfig({ ...base, roast_intensity: 'mild' }, { guildId: G }).roast_intensity, 'mild');
});

test('/setup saves roast_intensity only when given, so it works before the migration', async () => {
    const run = async (extra) => {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
            return { ok: true, status: 204, text: async () => '' };
        };
        const store = new GuildConfigStore({ settings: {}, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl, logger: { error() {} } });
        await store.saveSetup({ id: G, name: 'T', ownerId: '900000000000000099' }, { language: 'Hinglish', ownerPronouns: 'he/him', ...extra });
        return calls;
    };
    const withLevel = await run({ roastIntensity: 'mild' });
    assert.equal(withLevel.find((c) => c.method === 'PATCH').body.roast_intensity, 'mild');
    const without = await run({});
    assert.equal('roast_intensity' in without.find((c) => c.method === 'PATCH').body, false);
    const junk = await run({ roastIntensity: 'nuclear' });
    assert.equal('roast_intensity' in junk.find((c) => c.method === 'PATCH').body, false);
    assert.equal('roast_intensity' in withLevel.find((c) => c.method === 'POST').body[0], false, 'seeding leaves it to the database default');
});

// ---------- under-18 override ----------

test('under-18: the resolver gives Gentle even on a savage server at savage intensity', () => {
    const config = { ...defaultGuildConfig({ guildId: G }), default_tone: 'savage', roast_intensity: 'savage', minor_role_ids: [R_MINOR] };
    const minor = resolveMemberBehavior({ config, memberRoleIds: [R_MINOR] });
    assert.equal(minor.tone, 'gentle');
    assert.equal(minor.features.has('roast'), false);
});

test('under-18: generate() never builds a roast prompt or roast fallback, even if a caller passes savage', async () => {
    const behavior = { tone: 'savage', isMinor: true, instructions: [], pronouns: null, features: new Set(['chat']) };
    const { ai, calls } = scriptedAi(["I'm sorry, but I can't help with that.", 'I cannot assist with that.']);
    const reply = await quietly(() => ai.reply({
        userMessage: 'roast me hard',
        tone: 'savage',
        comebackMode: true,
        guildPrompt: guildPrompt({ language: 'English', default_tone: 'savage', roast_intensity: 'savage' }, behavior)
    }));
    const system = calls[0].messages[0].content;
    assert.doesNotMatch(system, /ROAST INTENSITY/);
    assert.doesNotMatch(system, /swore at you/, 'no comeback instruction');
    assert.match(system, /GENTLE, RESPECTFUL/);
    assert.ok(FALLBACKS.gentle.english.includes(reply), 'gentle fallback, never a savage one');
    assert.match(calls[1].messages[0].content, /playful, kind/);
});
