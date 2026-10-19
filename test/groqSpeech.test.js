const test = require('node:test');
const assert = require('node:assert/strict');
const groq = require('../src/voice/groqSpeech');

// One second of 48 kHz stereo 16-bit "audio" (Discord's PCM format).
const oneSecond = [Buffer.alloc(48000 * 2 * 2, 1)];

function withFetch(fake, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = fake;
    return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('Groq Whisper is only used with a key', async () => {
    assert.equal(groq.isGroqEnabled({}), false);
    assert.equal(groq.isGroqEnabled({ groqApiKey: 'gsk_test' }), true);
    await assert.rejects(groq.transcribePcmChunks({}, oneSecond), /GROQ_API_KEY/);
});

test('sends a 16 kHz WAV with the model and Hinglish prompt, returns the text', async () => {
    let seen;
    await withFetch(async (url, init) => {
        seen = { url, auth: init.headers.Authorization, form: init.body };
        return { ok: true, json: async () => ({ text: ' bhai play kesariya ' }) };
    }, async () => {
        const text = await groq.transcribePcmChunks({ groqApiKey: 'gsk_test', groqSttModel: 'whisper-large-v3' }, oneSecond);
        assert.equal(text, 'bhai play kesariya');
    });
    assert.equal(seen.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(seen.auth, 'Bearer gsk_test');
    assert.equal(seen.form.get('model'), 'whisper-large-v3');
    assert.match(seen.form.get('prompt'), /Hinglish/);
    const wav = Buffer.from(await seen.form.get('file').arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
});

test('silence and Whisper noise phrases give an empty transcript; errors are reported', async () => {
    await withFetch(async () => { throw new Error('should not be called'); }, async () => {
        assert.equal(await groq.transcribePcmChunks({ groqApiKey: 'k' }, [Buffer.alloc(100)]), '');
    });
    await withFetch(async () => ({ ok: true, json: async () => ({ text: 'Thank you.' }) }), async () => {
        assert.equal(await groq.transcribePcmChunks({ groqApiKey: 'k' }, oneSecond), '');
    });
    await withFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) }), async () => {
        await assert.rejects(groq.transcribePcmChunks({ groqApiKey: 'k' }, oneSecond), /401.*Invalid API Key/);
    });
});

test('when Groq and NVIDIA both fail, transcription reports why instead of going silent', async () => {
    const nvidia = require('../src/voice/nvidiaSpeech');
    const conversation = require('../src/voice/voiceConversation');
    nvidia.setAsrClientForTests({
        StreamingRecognize() { throw new Error('endpoint down'); }
    });
    try {
        await withFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) }), async () => {
            await assert.rejects(
                conversation.transcribeUtterance({ groqApiKey: 'bad', nvidiaApiKey: 'x' }, oneSecond),
                /speech-to-text failed \(Groq: .*401.*NVIDIA/
            );
        });
    } finally {
        nvidia.closeAsrClient();
    }
});
