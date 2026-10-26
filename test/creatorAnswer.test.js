const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CREATOR_PORTFOLIO_URL, CREATOR_REPLIES, creatorAnswer, creatorLanguage, creatorPersonaInstruction, withPortfolioLink } = require('../src/ai/creator');
const { createAiClient } = require('../src/ai/client');
const { defaultGuildConfig } = require('../dashboard/lib/shared');

const ROOT = path.join(__dirname, '..');
const OLD_LINK = ['portfolio-eight-neon-70', 'vercel.app'].join('.');

const allReplies = () => Object.values(CREATOR_REPLIES).flatMap((byTone) => Object.values(byTone).flat());

test('every variation is short and casual, with the link and only the kept facts', () => {
    const replies = allReplies();
    assert.ok(replies.length >= 15);
    for (const reply of replies) {
        assert.match(reply, /ZiG/, reply);
        assert.equal(reply.split(CREATOR_PORTFOLIO_URL).length - 1, 1, `exactly one link: ${reply}`);
        const sentences = reply.replace(CREATOR_PORTFOLIO_URL, '').split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 3);
        assert.ok(sentences.length <= 3, `1-3 sentences: ${reply}`);
        assert.ok(reply.length <= 200, `short: ${reply}`);
        // Removed: Discord id, tech stack line, job titles, real name, owner claims.
        assert.doesNotMatch(reply.replace(CREATOR_PORTFOLIO_URL, ''), /\d{17,20}|Discord\.js|AI model|developer|frontend|product|e-commerce|Bhavesh|owner/i, reply);
    }
});

test('several distinct variations for every tone and language', () => {
    for (const [language, byTone] of Object.entries(CREATOR_REPLIES)) {
        for (const tone of ['neutral', 'gentle', 'savage']) {
            const pool = byTone[tone];
            assert.ok(pool.length >= 2, `${language}/${tone}`);
            assert.equal(new Set(pool).size, pool.length);
        }
    }
    const seen = new Set([0, 0.4, 0.99].map((roll) => creatorAnswer({ tone: 'savage', language: 'Hinglish', rng: () => roll })));
    assert.ok(seen.size >= 2, 'rng picks different variations');
});

test('the server language and member tone pick the pool', () => {
    assert.ok(CREATOR_REPLIES.hinglish.savage.includes(creatorAnswer({ tone: 'savage', language: 'Hinglish' })));
    assert.ok(CREATOR_REPLIES.english.savage.includes(creatorAnswer({ tone: 'savage', language: 'English' })));
    assert.ok(CREATOR_REPLIES.english.gentle.includes(creatorAnswer({ tone: 'gentle', language: 'English' })));
    assert.ok(CREATOR_REPLIES.hinglish.neutral.includes(creatorAnswer({ tone: 'neutral', language: 'Hinglish' })));
    // Unset / mixed language: Savage keeps its Hinglish style, the rest English.
    assert.equal(creatorLanguage('savage', 'English-Hinglish mix'), 'hinglish');
    assert.equal(creatorLanguage('gentle', ''), 'english');
    assert.ok(CREATOR_REPLIES.english.neutral.includes(creatorAnswer({ tone: 'unknown', language: 'English' })));
});

function scriptedAi(replies) {
    const ai = createAiClient({ aiModel: 'test-model', groqApiKey: 'test-key', rateLimiter: { attempt: () => true } });
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
const guild = (config = {}, behavior = null) => ({ config: { ...defaultGuildConfig({ guildId: '900000000000000001' }), ...config }, behavior, isHomeGuild: false });

test('built-in tones answer with no AI call; owner and under-18 get the gentle version', async () => {
    const { ai, calls } = scriptedAi([]);
    const savage = await ai.reply({ userMessage: 'who made you?', tone: 'savage', guildPrompt: guild({ language: 'Hinglish' }) });
    assert.ok(CREATOR_REPLIES.hinglish.savage.includes(savage));
    const owner = await ai.reply({ userMessage: 'who made you?', tone: 'savage', isOwner: true, guildPrompt: guild({ language: 'English' }) });
    assert.ok(CREATOR_REPLIES.english.gentle.includes(owner));
    const minor = await ai.reply({ userMessage: 'who made you?', tone: 'savage', guildPrompt: guild({ language: 'English' }, { isMinor: true }) });
    assert.ok(CREATOR_REPLIES.english.gentle.includes(minor));
    const legacy = await ai.reply({ userMessage: 'why did ZiG create you?', tone: 'gentle' });
    assert.ok(CREATOR_REPLIES.english.gentle.includes(legacy));
    assert.equal(calls.length, 0);
});

test('a custom persona answers in its own voice, and the link is always there', async () => {
    const { ai, calls } = scriptedAi(['Ahoy! Captain ZiG built this ship to keep the crew laughing.']);
    const reply = await ai.reply({ userMessage: 'who made you?', tone: 'neutral', guildPrompt: guild({ language: 'English', custom_system_prompt: 'You are a pirate captain.' }) });
    assert.equal(reply, `Ahoy! Captain ZiG built this ship to keep the crew laughing. ${CREATOR_PORTFOLIO_URL}`);
    const system = calls[0].messages[0].content;
    assert.match(system, /pirate captain/);
    assert.match(system, /THIS TURN: the member is asking who made you/);
    assert.ok(system.includes(CREATOR_PORTFOLIO_URL));
    assert.doesNotMatch(system, /REACTION GIF/, 'no GIF tag on this turn');
    assert.equal(withPortfolioLink(`ZiG made me ${CREATOR_PORTFOLIO_URL}`), `ZiG made me ${CREATOR_PORTFOLIO_URL}`);
    assert.match(creatorPersonaInstruction('Hinglish'), /Reply in Hinglish/);
    assert.match(creatorPersonaInstruction(''), /do not call ZiG the owner of this server/);
});

test('a custom persona whose AI call fails still gets a fixed answer', async () => {
    const { ai } = scriptedAi([Object.assign(new Error('down'), { status: 503 })]);
    const reply = await ai.reply({ userMessage: 'who made you?', tone: 'neutral', guildPrompt: guild({ language: 'English', custom_system_prompt: 'You are a pirate.' }) });
    assert.ok(CREATOR_REPLIES.english.neutral.includes(reply));
});

test('the Commands page example describes the new answer', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'dashboard/data/commands.json'), 'utf8'));
    const example = catalog.talk.find((t) => t.message === '@ZiGBoT who made you?');
    assert.match(example.what, /ZiG made ZiGBoT, with a link to his work/);
    assert.match(example.what, /tone and language/);
});

test('the old portfolio link is gone from the whole repo', () => {
    const skip = new Set(['node_modules', '.next', '.git', 'bin', 'logs']);
    const hits = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|jsx|json|md|sql|css|html|txt|example)$/.test(entry.name) || entry.name.startsWith('.env')) {
                if (fs.readFileSync(full, 'utf8').includes(OLD_LINK)) hits.push(path.relative(ROOT, full));
            }
        }
    };
    walk(ROOT);
    assert.deepEqual(hits, []);
});
