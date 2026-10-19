const test = require('node:test');
const assert = require('node:assert/strict');
const sarvam = require('../src/voice/sarvamSpeech');
const { wavHeader } = require('../src/voice/nvidiaSpeech');

// 0.1 s of 48 kHz mono 16-bit audio, as Sarvam returns it (base64 WAV).
const monoPcm = Buffer.alloc(4800 * 2, 2);
const wavBase64 = Buffer.concat([wavHeader(monoPcm.length, 48000, 1), monoPcm]).toString('base64');

function withFetch(fake, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = fake;
    return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('Sarvam is only used with a key; language follows the server setting', async () => {
    assert.equal(sarvam.isSarvamEnabled({}), false);
    assert.equal(sarvam.isSarvamEnabled({ sarvamApiKey: 'k' }), true);
    await assert.rejects(sarvam.synthesizeSpeech({}, 'hi'), /SARVAM_API_KEY/);
    assert.equal(sarvam.languageCodeFor({ guildContext: { config: { language: 'English' } } }), 'en-IN');
    assert.equal(sarvam.languageCodeFor({ guildContext: { config: { language: 'Hinglish' } } }), 'hi-IN');
    assert.equal(sarvam.languageCodeFor({}), 'hi-IN');
});

test('request uses bulbul:v3, the chosen voice and 48 kHz WAV; reply becomes Discord PCM', async () => {
    let seen;
    await withFetch(async (url, init) => {
        seen = { url, key: init.headers['api-subscription-key'], body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ request_id: 'r1', audios: [wavBase64] }) };
    }, async () => {
        const { pcm } = await sarvam.synthesizeSpeech({ sarvamApiKey: 'sk_test', sarvamVoice: 'Priya', sarvamPace: '1.2' }, 'Bhai tension mat le');
        // mono 48 kHz -> stereo 48 kHz doubles the bytes
        assert.equal(pcm.length, monoPcm.length * 2);
    });
    assert.equal(seen.url, 'https://api.sarvam.ai/text-to-speech');
    assert.equal(seen.key, 'sk_test');
    assert.deepEqual(seen.body, {
        text: 'Bhai tension mat le',
        language_code: 'hi-IN',
        model: 'bulbul:v3',
        speaker: 'priya',
        pace: 1.2,
        speech_sample_rate: 48000,
        output_audio_codec: 'wav'
    });
});

test('Sarvam errors are reported so NVIDIA can take over', async () => {
    await withFetch(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Invalid API key', code: 'invalid_api_key_error' } }) }), async () => {
        await assert.rejects(sarvam.synthesizeSpeech({ sarvamApiKey: 'bad' }, 'hello'), /403.*Invalid API key/);
    });
    await withFetch(async () => ({ ok: true, json: async () => ({ audios: [] }) }), async () => {
        await assert.rejects(sarvam.synthesizeSpeech({ sarvamApiKey: 'k' }, 'hello'), /no audio/);
    });
});
