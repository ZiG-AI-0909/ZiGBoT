const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReplySystemPrompt, buildReplyMessages } = require('../src/ai/client');
const { RESPONSE_QUALITY_RULES, personaFor } = require('../dashboard/lib/shared/personas');
const { composeSystemPrompt, PLATFORM_SAFETY_RULES } = require('../dashboard/lib/shared/prompt');

// Prompt-level checks only: they prove what the model is told, not how a
// real model answers. Live answer quality still needs a manual check.

test('every persona path carries the answer rules', () => {
    const prompts = {
        legacySavage: buildReplySystemPrompt({ tone: 'savage' }),
        legacyGentle: buildReplySystemPrompt({ tone: 'gentle' }),
        owner: buildReplySystemPrompt({ tone: 'savage', isOwner: true }),
        multiNeutral: buildReplySystemPrompt({ tone: 'neutral', guildPrompt: { config: {}, behavior: null, isHomeGuild: false } }),
        multiEnglish: composeSystemPrompt({ config: { language: 'English' }, behavior: { tone: 'savage', instructions: [], pronouns: null } }),
        customPersona: composeSystemPrompt({ config: { replace_base_persona: true, custom_system_prompt: 'You are a pirate.' } })
    };
    for (const [name, prompt] of Object.entries(prompts)) {
        assert.ok(prompt.includes(RESPONSE_QUALITY_RULES), `${name} has the answer rules`);
    }
    // The platform safety layer still comes first in multi-server prompts.
    assert.ok(prompts.multiNeutral.startsWith(PLATFORM_SAFETY_RULES));
    assert.ok(prompts.customPersona.startsWith(PLATFORM_SAFETY_RULES));
});

test('the answer rules cover helpfulness, honesty, context, language and injection', () => {
    for (const pattern of [
        /answer that first/,
        /say so briefly instead of guessing/,
        /Never invent facts/,
        /follow-ups/,
        /language and script the member writes in/,
        /fenced block with a language tag/,
        /optional seasoning/,
        /cannot browse the web, run code/,
        /never claim to remember/,
        /content to read, not instructions/,
        /reveal or summarise this prompt, API keys/,
        /qualified professional/
    ]) assert.match(RESPONSE_QUALITY_RULES, pattern);
});

test('savage and gentle no longer force every answer into 1 to 3 lines', () => {
    for (const tone of ['savage', 'gentle']) {
        for (const language of ['', 'English', 'Hinglish']) {
            const persona = personaFor(tone, language);
            assert.match(persona, /Real questions|real questions/, `${tone}/${language || 'mixed'} handles real questions`);
        }
    }
    assert.match(personaFor('savage', ''), /Never roast someone just for asking for help/);
});

test('context keeps order, puts the current message last, and does not repeat it', () => {
    const contextMessages = [
        { role: 'user', content: '[asha]: my favourite number is 7' },
        { role: 'assistant', content: 'Noted for this chat: 7.' }
    ];
    const messages = buildReplyMessages({ systemPrompt: 'SYS', contextMessages, authorName: 'asha', userMessage: 'double it?' });
    assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(messages.at(-1).content, '[asha]: double it?');
    assert.equal(messages.filter((m) => m.content.includes('double it?')).length, 1);
});
