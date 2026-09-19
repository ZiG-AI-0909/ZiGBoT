const test = require('node:test');
const assert = require('node:assert/strict');

const nvidia = require('../src/voice/nvidiaSpeech');

const {
    convertPcm,
    pcmForAsr,
    pcmForPlayback,
    parseWav,
    wavHeader,
    writeTemporaryWav,
    removeTemporaryDirectory,
    buildAsrStreamMessages,
    MAX_ASR_AUDIO_SECONDS,
    ASR_SAMPLE_RATE
} = nvidia;
const {
    startListening,
    stopListening,
    speak
} = require('../src/voice/voiceConversation');

const voiceSettings = {
    nvidiaApiKey: 'nvapi-test',
    useNvidiaSpeech: true,
    sttCommand: '',
    ttsCommand: ''
};

// ---------- pure PCM conversion ----------

test('convertPcm downsamples 48kHz stereo to 16kHz mono for ASR', () => {
    // 3 frames of stereo silence-ish tone: [0, 1000], [0, 2000], [0, 3000] (L,R)
    const input = Buffer.alloc(6 * 2);
    input.writeInt16LE(0, 0); input.writeInt16LE(1000, 2);
    input.writeInt16LE(0, 4); input.writeInt16LE(2000, 6);
    input.writeInt16LE(0, 8); input.writeInt16LE(3000, 10);

    const output = pcmForAsr(input);
    // 3 frames @48k -> ~1 frame @16k
    assert.equal(output.length, 2);
    const mono = output.readInt16LE(0);
    // Downmix averages each stereo frame: frame 0 is (0 + 1000) / 2 = 500,
    // and the single output frame maps to input frame 0.
    assert.ok(Math.abs(mono - 500) <= 2, `expected ~500, got ${mono}`);
});

test('convertPcm upsamples mono 22.05kHz to 48kHz stereo for playback', () => {
    const input = Buffer.alloc(4 * 2);
    input.writeInt16LE(1000, 0);
    input.writeInt16LE(2000, 2);
    input.writeInt16LE(3000, 4);
    input.writeInt16LE(4000, 6);

    const output = convertPcm(input, { fromRate: 22050, toRate: 48000, fromChannels: 1, toChannels: 2 });
    const outFrames = output.length / 4; // stereo s16le
    // ~2.18x more frames out than in
    assert.ok(outFrames >= 7 && outFrames <= 10, `expected ~8-9 frames, got ${outFrames}`);
    // every output frame duplicates the mono sample into L and R
    assert.equal(output.readInt16LE(0), output.readInt16LE(2));
});

test('convertPcm handles empty and degenerate input without throwing', () => {
    assert.equal(convertPcm(Buffer.alloc(0), { fromRate: 48000, toRate: 16000, fromChannels: 2, toChannels: 1 }).length, 0);
    assert.equal(convertPcm(Buffer.alloc(3), { fromRate: 48000, toRate: 16000, fromChannels: 2, toChannels: 1 }).length, 0);
});

test('parseWav walks RIFF chunks and reads fmt/data correctly', () => {
    const pcm = Buffer.alloc(8000); // 0.25s stereo @48k
    const wav = Buffer.concat([wavHeader(pcm.length, 48000, 2), pcm]);
    const parsed = parseWav(wav);
    assert.equal(parsed.sampleRate, 48000);
    assert.equal(parsed.channels, 2);
    assert.equal(parsed.bitsPerSample, 16);
    assert.equal(parsed.pcm.length, pcm.length);
});

test('parseWav tolerates extra LIST chunks before data', () => {
    const pcm = Buffer.alloc(100);
    const listChunk = Buffer.alloc(8 + 10);
    listChunk.write('LIST', 0);
    listChunk.writeUInt32LE(10, 4);
    listChunk.write('INFOhello', 8);
    const wav = Buffer.concat([wavHeader(pcm.length, 22050, 1), pcm]);
    // splice LIST in right after the 44-byte header
    const withList = Buffer.concat([wav.subarray(0, 36), listChunk, wav.subarray(36)]);
    const parsed = parseWav(withList);
    assert.equal(parsed.sampleRate, 22050);
    assert.equal(parsed.pcm.length, pcm.length);
});

test('writeTemporaryWav produces a parseable WAV and cleanup removes it', async () => {
    const chunks = [Buffer.alloc(9600), Buffer.alloc(9600)];
    const { directory, wavPath, pcm } = await writeTemporaryWav(chunks);
    assert.equal(pcm.length, 19200);
    const written = await require('node:fs/promises').readFile(wavPath);
    const parsed = parseWav(written);
    assert.equal(parsed.sampleRate, 48000);
    assert.equal(parsed.channels, 2);
    await removeTemporaryDirectory(directory);
    await assert.rejects(() => require('node:fs/promises').readFile(wavPath));
});

// ---------- ASR stream message building (pure) ----------

test('buildAsrStreamMessages emits config first then 100ms audio chunks', () => {
    // 1 second of mono 16-bit @16kHz = 32000 bytes -> 10 chunks
    const audio = Buffer.alloc(ASR_SAMPLE_RATE * 2);
    const messages = buildAsrStreamMessages(audio);

    assert.equal(messages.length, 11); // 1 config + 10 audio
    const config = messages[0].streaming_config.config;
    assert.equal(config.encoding, 1); // LINEAR_PCM
    assert.equal(config.sample_rate_hertz, ASR_SAMPLE_RATE);
    assert.equal(config.audio_channel_count, 1);
    assert.equal(messages[0].streaming_config.interim_results, false);
    for (let i = 1; i < messages.length; i += 1) {
        assert.equal(messages[i].audio_content.length, 3200);
    }
    assert.equal(messages[messages.length - 1].audio_content.length, 3200);
});

test('buildAsrStreamMessages caps audio at the 15s ASR limit shape', () => {
    const maxBytes = MAX_ASR_AUDIO_SECONDS * ASR_SAMPLE_RATE * 2;
    const audio = Buffer.alloc(maxBytes);
    const messages = buildAsrStreamMessages(audio);
    const audioMessages = messages.length - 1;
    assert.equal(audioMessages, Math.ceil(maxBytes / 3200));
});

// ---------- ASR end-to-end against a mocked gRPC surface ----------

function makeFakeAsrClient({ finalTranscript = 'bhai ek joke sunao', failWith = null } = {}) {
    const calls = [];
    return {
        calls,
        StreamingRecognize(metadata, options) {
            const writes = [];
            const handlers = {};
            const call = {
                write: (msg) => writes.push(msg),
                end: () => {
                    calls.push({ metadata, options, writes });
                    setImmediate(() => {
                        if (failWith) {
                            handlers.error?.(failWith);
                            return;
                        }
                        handlers.data?.({
                            results: [{
                                is_final: true,
                                alternatives: [{ transcript: finalTranscript, confidence: 0.9 }]
                            }]
                        });
                        setImmediate(() => handlers.end?.());
                    });
                },
                on: (event, cb) => { handlers[event] = cb; }
            };
            return call;
        }
    };
}

test('transcribePcmChunks sends NVCF metadata, mono 16k audio, and resolves the final transcript', async () => {
    const fake = makeFakeAsrClient({ finalTranscript: 'bhai ek joke sunao' });
    nvidia.setAsrClientForTests(fake);
    try {
        // 1 second of 48kHz stereo silence -> 1 second mono 16k after conversion
        const stereo = Buffer.alloc(48000 * 2 * 2);
        const transcript = await nvidia.transcribePcmChunks(voiceSettings, [stereo]);
        assert.equal(transcript, 'bhai ek joke sunao');

        assert.equal(fake.calls.length, 1);
        const { metadata, writes } = fake.calls[0];
        const headers = metadata.getMap();
        assert.equal(headers['function-id'], nvidia.DEFAULT_ASR_FUNCTION_ID);
        assert.match(headers.authorization, /^Bearer nvapi-test$/);

        // config first, then audio chunks; audio must be mono 16k sized
        assert.ok(writes.length > 2);
        assert.equal(writes[0].streaming_config.config.sample_rate_hertz, ASR_SAMPLE_RATE);
        assert.equal(writes[0].streaming_config.config.audio_channel_count, 1);
        const audioBytes = writes.slice(1).reduce((sum, w) => sum + w.audio_content.length, 0);
        assert.equal(audioBytes, ASR_SAMPLE_RATE * 2); // exactly 1s of mono s16le
    } finally {
        nvidia.closeAsrClient();
    }
});

test('transcribePcmChunks rejects with a clear error when the gRPC call fails', async () => {
    const fake = makeFakeAsrClient({ failWith: { details: 'unauthenticated' } });
    nvidia.setAsrClientForTests(fake);
    try {
        const stereo = Buffer.alloc(48000 * 2 * 2);
        await assert.rejects(
            () => nvidia.transcribePcmChunks(voiceSettings, [stereo]),
            /Riva ASR failed: unauthenticated/
        );
    } finally {
        nvidia.closeAsrClient();
    }
});

test('transcribeUtterance falls back to local STT when NVIDIA ASR is unavailable', async () => {
    const fake = makeFakeAsrClient({ failWith: { details: 'endpoint down' } });
    nvidia.setAsrClientForTests(fake);
    try {
        const conversation = require('../src/voice/voiceConversation');
        const stereo = [Buffer.alloc(48000 * 2 * 2)];
        const settings = {
            ...voiceSettings,
            // Cross-platform no-op STT: node with an empty inline script
            sttCommand: process.execPath,
            sttArgs: ['-e', ''],
            sttTimeoutMs: 5000
        };
        const transcript = await conversation.transcribeUtterance(settings, stereo);
        assert.equal(transcript, '');
    } finally {
        nvidia.closeAsrClient();
    }
});
