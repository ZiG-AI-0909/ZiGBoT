// NVIDIA-hosted speech for ZiGBoT: replaces the local Whisper/Piper binaries
// (which cannot run on Render's free tier) with build.nvidia.com hosted
// endpoints, authenticated by the SAME NVIDIA_API_KEY used for chat.
//
//  - STT: Riva ASR over gRPC (grpc.nvcf.nvidia.com:443). A per-model
//    "function-id" metadata header selects the hosted model. The multilingual
//    Parakeet endpoint used here auto-detects Hindi/English (Indic model type).
//  - TTS: Magpie-TTS-Multilingual over plain HTTPS multipart form posts —
//    returns WAV (mono, 16-bit PCM).
//
// No ffmpeg and no local binaries: all audio conversion is pure-JS PCM math.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// --- Tunable constants -------------------------------------------------------

// Hosted Riva ASR endpoint (NVCF). Same host for every speech model; the
// function-id selects the model.
const ASR_GRPC_HOST = 'grpc.nvcf.nvidia.com:443';

// NVCF function-id for parakeet-1.1b-rnnt-multilingual (Indic type):
// auto language detection across Hindi + English. Override with
// NVIDIA_ASR_FUNCTION_ID to switch models without code changes.
const DEFAULT_ASR_FUNCTION_ID = '71203149-d3b7-4460-8231-1be2543a1fca';

// Discord voice arrives at 48kHz stereo; Riva wants mono 16-bit PCM.
const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const ASR_SAMPLE_RATE = 16000;
const ASR_CHANNELS = 1;

// Magpie-TTS-Multilingual output rate; Discord expects 48kHz stereo.
const TTS_SAMPLE_RATE = 22050;
const TTS_CHANNELS = 1;
const PLAYBACK_SAMPLE_RATE = 48000;
const PLAYBACK_CHANNELS = 2;

// Hard cap on uploaded audio bytes (16-bit mono @16kHz = 32KB/s). Protects
// against runaway subscriptions; matches the old 15s local cap.
const MAX_ASR_AUDIO_SECONDS = 15;

// TTS request guardrails.
const MAX_TTS_TEXT_LENGTH = 600;

// ----------------------------------------------------------------------------

// Linear resample + channel conversion of 16-bit little-endian PCM, in place
// math, no dependencies. Works for both directions (down for ASR, up for
// playback) because it only interpolates samples linearly.
function convertPcm(inputBuffer, { fromRate, toRate, fromChannels, toChannels }) {
    if (!inputBuffer || inputBuffer.length === 0) return Buffer.alloc(0);

    const bytesPerSample = 2;
    const inFrames = Math.floor(inputBuffer.length / (bytesPerSample * fromChannels));
    if (inFrames === 0) return Buffer.alloc(0);

    // Channel mix first happens per output frame during the loop below.
    const ratio = fromRate / toRate;
    const outFrames = Math.max(1, Math.floor(inFrames / ratio));
    const out = Buffer.alloc(outFrames * bytesPerSample * toChannels);

    for (let frame = 0; frame < outFrames; frame += 1) {
        const srcPos = frame * ratio;
        const index = Math.min(Math.floor(srcPos), inFrames - 1);
        const nextIndex = Math.min(index + 1, inFrames - 1);
        const frac = srcPos - index;

        let mono = 0;
        for (let ch = 0; ch < fromChannels; ch += 1) {
            const offset = (index * fromChannels + ch) * bytesPerSample;
            const nextOffset = (nextIndex * fromChannels + ch) * bytesPerSample;
            const sample = inputBuffer.readInt16LE(offset);
            const nextSample = inputBuffer.readInt16LE(nextOffset);
            mono += sample + (nextSample - sample) * frac;
        }
        mono /= fromChannels;

        for (let ch = 0; ch < toChannels; ch += 1) {
            const outOffset = (frame * toChannels + ch) * bytesPerSample;
            out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mono))), outOffset);
        }
    }
    return out;
}

// 48kHz stereo Discord PCM -> 16kHz mono PCM for Riva ASR.
function pcmForAsr(discordPcm) {
    return convertPcm(discordPcm, {
        fromRate: DISCORD_SAMPLE_RATE,
        toRate: ASR_SAMPLE_RATE,
        fromChannels: DISCORD_CHANNELS,
        toChannels: ASR_CHANNELS
    });
}

// Magpie 22.05kHz mono WAV bytes -> 48kHz stereo PCM for @discordjs/voice.
function pcmForPlayback(wavBytes) {
    const { pcm, sampleRate, channels, bitsPerSample } = parseWav(wavBytes);
    if (bitsPerSample !== 16) throw new Error(`Unsupported TTS bit depth: ${bitsPerSample}`);
    return convertPcm(pcm, {
        fromRate: sampleRate || TTS_SAMPLE_RATE,
        toRate: PLAYBACK_SAMPLE_RATE,
        fromChannels: channels || TTS_CHANNELS,
        toChannels: PLAYBACK_CHANNELS
    });
}

// Minimal WAV parser: walks RIFF chunks to find the fmt and data blocks, so
// extra LIST chunks from providers do not break parsing.
function parseWav(buffer) {
    if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('TTS response is not a WAV file.');
    }
    let offset = 12;
    let fmt = { sampleRate: 0, channels: 1, bitsPerSample: 16 };
    let data = null;
    while (offset + 8 <= buffer.length) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (id === 'fmt ') {
            fmt = {
                channels: buffer.readUInt16LE(body + 2),
                sampleRate: buffer.readUInt32LE(body + 4),
                bitsPerSample: buffer.readUInt16LE(body + 14)
            };
        } else if (id === 'data') {
            data = buffer.subarray(body, Math.min(body + size, buffer.length));
        }
        offset = body + size + (size % 2); // chunks are word-aligned
    }
    if (!data) throw new Error('TTS WAV has no data chunk.');
    return { ...fmt, pcm: data };
}

function wavHeader(pcmLength, sampleRate, channels) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * 2;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmLength, 40);
    return header;
}

// Lazily-built Riva ASR client. The vendored protos keep the include path
// upstream uses ("riva/proto/..."), so they load with keepCase defaults.
let cachedAsrClient = null;
function getAsrClient() {
    if (cachedAsrClient) return cachedAsrClient;
    const packageDefinition = protoLoader.loadSync(
        'riva/proto/riva_asr.proto', // relative to includeDirs
        {
            includeDirs: [path.join(__dirname, 'protos')],
            keepCase: false,
            longs: Number,
            enums: Number,
            defaults: false,
            oneofs: true
        }
    );
    const rivaProto = grpc.loadPackageDefinition(packageDefinition);
    const Ctor = rivaProto.nvidia.riva.asr.RivaSpeechRecognition;
    cachedAsrClient = new Ctor(ASR_GRPC_HOST, grpc.credentials.createSsl());
    return cachedAsrClient;
}

function asrMetadata(settings) {
    const meta = new grpc.Metadata();
    meta.set('function-id', settings.asrFunctionId || DEFAULT_ASR_FUNCTION_ID);
    meta.set('authorization', `Bearer ${settings.nvidiaApiKey}`);
    return meta;
}

// Pure message builder for the StreamingRecognize call: per proto contract,
// the first message carries ONLY the config, every following message carries
// raw audio (16-bit mono s16le, chunked at 100ms frames = 3200 bytes).
function buildAsrStreamMessages(audio) {
    const messages = [{
        streaming_config: {
            config: {
                encoding: 1, // LINEAR_PCM (nvidia.riva.AudioEncoding)
                sample_rate_hertz: ASR_SAMPLE_RATE,
                language_code: 'en-US', // endpoint auto-detects hi-IN; needed for routing
                max_alternatives: 1,
                enable_automatic_punctuation: true,
                audio_channel_count: ASR_CHANNELS
            },
            interim_results: false
        }
    }];
    const chunkSize = ASR_SAMPLE_RATE * 2 / 10; // 100ms of mono s16le @16kHz
    for (let offset = 0; offset < audio.length; offset += chunkSize) {
        messages.push({ audio_content: audio.subarray(offset, Math.min(offset + chunkSize, audio.length)) });
    }
    return messages;
}

/**
 * Transcribes 48kHz-stereo PCM chunks (as produced by the Discord opus
 * decoder) using NVIDIA's hosted Riva ASR. Streams the whole utterance as
 * one gRPC stream and returns the first final transcript.
 */
function transcribePcmChunks(settings, pcmChunks) {
    return new Promise((resolve, reject) => {
        if (!settings.nvidiaApiKey) {
            reject(new Error('NVIDIA_API_KEY is not configured for hosted speech.'));
            return;
        }

        const monoPcm = pcmForAsr(Buffer.concat(pcmChunks));
        const maxBytes = MAX_ASR_AUDIO_SECONDS * ASR_SAMPLE_RATE * 2;
        const audio = monoPcm.length > maxBytes ? monoPcm.subarray(0, maxBytes) : monoPcm;
        if (audio.length < ASR_SAMPLE_RATE * 2 * 0.3) {
            // Under ~300ms of speech: not worth a network round trip.
            resolve('');
            return;
        }

        const client = getAsrClient();
        // StreamingRecognize is a BIDI rpc: responses arrive as 'data' events
        // and the call is finished with call.end(). A hard deadline keeps a
        // stuck stream from hanging an utterance forever.
        const call = client.StreamingRecognize(
            asrMetadata(settings),
            { deadline: Date.now() + 20_000 }
        );
        let transcript = '';
        call.on('data', (response) => {
            for (const result of response?.results || []) {
                if (!result.is_final) continue;
                const text = result.alternatives?.[0]?.transcript;
                if (text && text.trim()) transcript = text.trim();
            }
        });
        call.on('error', (error) => {
            reject(new Error(`Riva ASR failed: ${error.details || error.message}`));
        });
        call.on('end', () => resolve(transcript));

        const streamingMessages = buildAsrStreamMessages(audio);
        for (const message of streamingMessages) {
            call.write(message);
        }
        call.end();
    });
}

// Convenience: transcribe an already-written 48kHz stereo WAV file (the shape
// the old local pipeline produced).
async function transcribeWavFile(settings, wavPath) {
    const buffer = await fsp.readFile(wavPath);
    const { pcm } = parseWav(buffer);
    return transcribePcmChunks(settings, [pcm]);
}

/**
 * Synthesizes speech with hosted Magpie-TTS-Multilingual and returns a
 * 48kHz-stereo PCM buffer ready for prism-media's opus encoder, plus a
 * temp WAV file on disk for the existing stream-based player.
 */
async function synthesizeSpeech(settings, text) {
    if (!settings.nvidiaApiKey) throw new Error('NVIDIA_API_KEY is not configured for hosted speech.');
    const clean = String(text || '').trim().slice(0, MAX_TTS_TEXT_LENGTH);
    if (!clean) throw new Error('TTS text is empty.');

    const baseUrl = settings.ttsEndpoint
        || 'https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com';
    const form = new URLSearchParams({
        text: clean,
        language: settings.ttsLanguage || 'en-US',
        voice: settings.ttsVoice || 'Magpie-Multilingual.EN-US.Aria',
        encoding: 'LINEAR_PCM',
        sample_rate_hz: String(TTS_SAMPLE_RATE)
    });

    const response = await fetch(`${baseUrl}/v1/audio/synthesize`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${settings.nvidiaApiKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'audio/wav'
        },
        body: form.toString()
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Magpie TTS failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const wavBytes = Buffer.from(await response.arrayBuffer());
    const pcm = pcmForPlayback(wavBytes);

    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zigbot-tts-'));
    const outputPath = path.join(directory, 'response.wav');
    await fsp.writeFile(outputPath, wavHeader(pcm.length, PLAYBACK_SAMPLE_RATE, PLAYBACK_CHANNELS));
    return { outputPath, directory, pcm };
}

// Shared temp cleanup used by the conversation pipeline.
async function removeTemporaryDirectory(directory) {
    await fsp.rm(directory, { recursive: true, force: true });
}

// Write a temp WAV (48kHz stereo) for a set of PCM chunks — used by the
// conversation pipeline when falling back to local STT.
async function writeTemporaryWav(chunks, { sampleRate = DISCORD_SAMPLE_RATE, channels = DISCORD_CHANNELS } = {}) {
    const pcm = Buffer.concat(chunks);
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zigbot-stt-'));
    const wavPath = path.join(directory, 'speech.wav');
    await fsp.writeFile(wavPath, wavHeader(pcm.length, sampleRate, channels));
    return { directory, wavPath, pcm };
}

// Exposed for the graceful-shutdown path.
function closeAsrClient() {
    if (cachedAsrClient) cachedAsrClient.close?.();
    cachedAsrClient = null;
}

// Test-only hook: swap the gRPC client with a fake (unit tests inject a stub
// that mimics the StreamingRecognize bidi call surface).
function setAsrClientForTests(client) {
    cachedAsrClient = client;
}

module.exports = {
    // speech
    transcribePcmChunks,
    transcribeWavFile,
    synthesizeSpeech,
    // audio helpers (exported for tests)
    convertPcm,
    pcmForAsr,
    pcmForPlayback,
    parseWav,
    wavHeader,
    writeTemporaryWav,
    removeTemporaryDirectory,
    buildAsrStreamMessages,
    closeAsrClient,
    setAsrClientForTests,
    // constants (exported for tests/tuning)
    ASR_SAMPLE_RATE,
    ASR_GRPC_HOST,
    DEFAULT_ASR_FUNCTION_ID,
    MAX_ASR_AUDIO_SECONDS,
    MAX_TTS_TEXT_LENGTH,
    TTS_SAMPLE_RATE
};
