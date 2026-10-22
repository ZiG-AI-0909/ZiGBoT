const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatClient, buildProviders, DEFAULT_GROQ_CHAT_MODEL } = require('../src/ai/providers');

function fakeProvider(name, model, behaviour) {
    const calls = [];
    return {
        name,
        model,
        calls,
        client: { chat: { completions: { create: async (params, options) => { calls.push({ params, options }); return behaviour(params); } } } }
    };
}
const ok = (text) => () => ({ choices: [{ message: { content: text } }] });
const fail = (status) => () => { const e = new Error(`HTTP ${status}`); e.status = status; throw e; };
const quiet = { error() {} };

test('NVIDIA comes first and Groq is the fallback, each with its own model', () => {
    class FakeOpenAI { constructor(opts) { this.opts = opts; } }
    const both = buildProviders({ groqApiKey: 'g', nvidiaApiKey: 'n', aiModel: 'openai/gpt-oss-20b' }, { OpenAIClass: FakeOpenAI });
    assert.deepEqual(both.map((p) => [p.name, p.model]), [['NVIDIA', 'openai/gpt-oss-20b'], ['Groq', DEFAULT_GROQ_CHAT_MODEL]]);
    assert.equal(both[1].client.opts.baseURL, 'https://api.groq.com/openai/v1');
    const nvidiaOnly = buildProviders({ nvidiaApiKey: 'n', aiModel: 'm' }, { OpenAIClass: FakeOpenAI });
    assert.deepEqual(nvidiaOnly.map((p) => p.name), ['NVIDIA']);
    assert.throws(() => createChatClient({}, { providers: [] }), /No chat AI configured/);
});

test('a failing provider (e.g. NVIDIA 404 model not found) fails over to the next', async () => {
    const groq = fakeProvider('Groq', 'llama-3.3-70b-versatile', fail(429));
    const nvidia = fakeProvider('NVIDIA', 'openai/gpt-oss-20b', ok('hello bestie'));
    const client = createChatClient({}, { providers: [groq, nvidia], logger: quiet });
    const response = await client.chat.completions.create({ model: 'ignored', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.choices[0].message.content, 'hello bestie');
    assert.equal(groq.calls[0].params.model, 'llama-3.3-70b-versatile');
    assert.equal(nvidia.calls[0].params.model, 'openai/gpt-oss-20b');

    const allDown = createChatClient({}, { providers: [fakeProvider('A', 'a', fail(500)), fakeProvider('B', 'b', fail(404))], logger: quiet });
    await assert.rejects(allDown.chat.completions.create({ messages: [] }), (error) => error.status === 404);
});

test('reasoningLow only nudges gpt-oss models and never reaches the HTTP options', async () => {
    const gptOss = fakeProvider('Groq', 'openai/gpt-oss-120b', ok('x'));
    const llama = fakeProvider('Groq', 'llama-3.3-70b-versatile', ok('x'));
    const messages = [{ role: 'system', content: 'You are ZiGBoT.' }, { role: 'user', content: 'yo' }];
    await createChatClient({}, { providers: [gptOss], logger: quiet }).chat.completions.create({ messages }, { timeout: 30000, reasoningLow: true });
    await createChatClient({}, { providers: [llama], logger: quiet }).chat.completions.create({ messages }, { timeout: 30000, reasoningLow: true });
    assert.match(gptOss.calls[0].params.messages[0].content, /^Reasoning: low\n/);
    assert.equal(llama.calls[0].params.messages[0].content, 'You are ZiGBoT.');
    assert.deepEqual(gptOss.calls[0].options, { timeout: 30000 });
    assert.equal(messages[0].content, 'You are ZiGBoT.'); // caller's array untouched
});

test('reasoning in <think> tags never reaches Discord or the voice', () => {
    const { cleanOutput } = require('../src/ai/client');
    assert.equal(cleanOutput('<think>user wants a roast, keep it short</think>\nBhai tu pura cooked hai 💀'), 'Bhai tu pura cooked hai 💀');
    assert.equal(cleanOutput('<think>still thinking when the tokens ran out'), '');
    assert.equal(cleanOutput('Plain answer'), 'Plain answer');
});

test('text chat goes to NVIDIA first; voice chat (prefer Groq) goes to Groq first', async () => {
    const nvidia = fakeProvider('NVIDIA', 'nvidia/nemotron-3-super-120b-a12b', ok('from nvidia'));
    const groq = fakeProvider('Groq', 'llama-3.3-70b-versatile', ok('from groq'));
    const client = createChatClient({}, { providers: [nvidia, groq], logger: quiet });
    const text = await client.chat.completions.create({ messages: [] });
    assert.equal(text.choices[0].message.content, 'from nvidia');
    const voice = await client.chat.completions.create({ messages: [] }, { prefer: 'Groq', timeout: 30000 });
    assert.equal(voice.choices[0].message.content, 'from groq');
    assert.deepEqual(groq.calls[0].options, { timeout: 30000 });

    // Voice still works when Groq is down: NVIDIA takes over.
    const groqDown = fakeProvider('Groq', 'llama-3.3-70b-versatile', fail(429));
    const backup = createChatClient({}, { providers: [fakeProvider('NVIDIA', 'n', ok('nvidia backup')), groqDown], logger: quiet });
    const fallback = await backup.chat.completions.create({ messages: [] }, { prefer: 'Groq' });
    assert.equal(fallback.choices[0].message.content, 'nvidia backup');
});

test('startup check reports a model the key cannot use, with what is available', async () => {
    const { checkProviders } = require('../src/ai/providers');
    const logs = [];
    const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    // NVIDIA lists nemotron, but calling it 404s (as seen in production);
    // gemma-4 is listed and works, the old llama2 is never test-called.
    const called = [];
    const fetchImpl = async (url, init) => {
        if (url.endsWith('/chat/completions')) {
            const { model } = JSON.parse(init.body);
            called.push(model);
            return model === 'nvidia/nemotron-3-super-120b-a12b'
                ? { ok: false, status: 404, text: async () => 'Function not found for account' }
                : { ok: true, status: 200 };
        }
        return {
            ok: true,
            json: async () => ({ data: url.includes('groq')
                ? [{ id: 'openai/gpt-oss-20b' }, { id: 'whisper-large-v3' }]
                : [{ id: 'meta/llama2-70b' }, { id: 'google/gemma-4-31b-it' }, { id: 'nvidia/nemotron-3-super-120b-a12b' }] })
        };
    };
    const results = await checkProviders({ groqApiKey: 'g', groqChatModel: 'llama-3.3-70b-versatile', nvidiaApiKey: 'n', aiModel: 'nvidia/nemotron-3-super-120b-a12b' }, { fetchImpl, logger });
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [['Groq', false], ['NVIDIA', false]]);
    assert.deepEqual(results.map((r) => r.working), [['openai/gpt-oss-20b'], ['google/gemma-4-31b-it']]);
    assert.ok(!called.includes('meta/llama2-70b'));
    assert.match(logs.join('\n'), /Groq: model llama-3.3-70b-versatile is NOT in this key's model list/);
    assert.match(logs.join('\n'), /Groq: these models answered a test request — use one: openai\/gpt-oss-20b/);
    assert.match(logs.join('\n'), /NVIDIA: model nvidia\/nemotron-3-super-120b-a12b is listed but a test request failed \(HTTP 404\)/);
    assert.match(logs.join('\n'), /NVIDIA: these models answered a test request — use one: google\/gemma-4-31b-it/);
    assert.doesNotMatch(logs.join('\n'), /whisper/);
});

test('a slow model is reported as slow, not broken, and no alternatives are test-called', async () => {
    const { checkProviders } = require('../src/ai/providers');
    const logs = [];
    const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    let probes = 0;
    const fetchImpl = async (url) => {
        if (url.endsWith('/chat/completions')) {
            probes += 1;
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        return { ok: true, json: async () => ({ data: [{ id: 'google/gemma-4-31b-it' }, { id: 'openai/gpt-oss-120b' }] }) };
    };
    const results = await checkProviders({ nvidiaApiKey: 'n', aiModel: 'google/gemma-4-31b-it' }, { fetchImpl, logger });
    assert.deepEqual(results.map((r) => [r.name, r.ok, r.slow]), [['NVIDIA', false, true]]);
    assert.equal(probes, 1);
    assert.match(logs.join('\n'), /NVIDIA: model google\/gemma-4-31b-it is listed but did not answer a test request within 20s/);
});

test('chat clients get a bounded timeout so a stalled NVIDIA request fails over quickly', () => {
    class FakeOpenAI { constructor(opts) { this.opts = opts; } }
    const [nvidia, groq] = buildProviders({ groqApiKey: 'g', nvidiaApiKey: 'n', aiModel: 'm' }, { OpenAIClass: FakeOpenAI });
    assert.equal(nvidia.client.opts.maxRetries, 0);
    assert.ok(nvidia.client.opts.timeout <= 60_000);
    assert.ok(groq.client.opts.timeout <= 60_000);
});

test('a provider that just failed is tried last until its cooldown ends', async () => {
    let clock = 0;
    let nvidiaBehaviour = fail(504);
    const nvidia = fakeProvider('NVIDIA', 'google/gemma-4-31b-it', () => nvidiaBehaviour());
    const groq = fakeProvider('Groq', 'openai/gpt-oss-20b', ok('from groq'));
    const client = createChatClient({}, { providers: [nvidia, groq], logger: quiet, now: () => clock });

    await client.chat.completions.create({ messages: [] });
    assert.equal(nvidia.calls.length, 1);
    // Next message skips straight to Groq.
    await client.chat.completions.create({ messages: [] });
    assert.equal(nvidia.calls.length, 1);
    assert.equal(groq.calls.length, 2);

    // After the cooldown NVIDIA is first again.
    clock += 3 * 60_000 + 1;
    nvidiaBehaviour = ok('from nvidia');
    const back = await client.chat.completions.create({ messages: [] });
    assert.equal(back.choices[0].message.content, 'from nvidia');

    // The startup check can demote a provider the same way.
    client.markDown('NVIDIA');
    const demoted = await client.chat.completions.create({ messages: [] });
    assert.equal(demoted.choices[0].message.content, 'from groq');
});
