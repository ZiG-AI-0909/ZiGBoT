/**
 * Speech-to-text with OpenAI's Whisper large-v3 hosted on Groq
 * (OpenAI-compatible /audio/transcriptions). Used first when GROQ_API_KEY is
 * set; NVIDIA ASR stays the automatic fallback (voiceConversation.js).
 *
 *   GROQ_API_KEY      required to enable it (server-side only, never logged)
 *   GROQ_STT_MODEL    whisper-large-v3-turbo (default, fastest) or whisper-large-v3
 */
const { pcmForAsr, wavHeader, ASR_SAMPLE_RATE } = require('./nvidiaSpeech');

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TIMEOUT_MS = 20_000;
const MIN_PCM_BYTES = ASR_SAMPLE_RATE * 2 * 0.3; // under ~0.3 s of 16 kHz mono is noise
// Whisper writes Hindi in Devanagari unless nudged; the bot's voice commands
// ("play kesariya", "gaana bajao") and personas expect Roman-script Hinglish.
const HINGLISH_PROMPT = 'Casual Discord voice chat in English and Hinglish written in Roman letters, e.g. "bhai kya scene hai", "play kesariya", "tension mat le".';

function isGroqEnabled(settings) {
    return Boolean(settings?.groqApiKey);
}

/** Discord PCM chunks (48 kHz stereo) -> transcript text ('' when silent). */
async function transcribePcmChunks(settings, chunks) {
    if (!isGroqEnabled(settings)) throw new Error('GROQ_API_KEY is not configured.');
    const pcm = pcmForAsr(Buffer.concat(chunks));
    if (pcm.length < MIN_PCM_BYTES) return '';
    const wav = Buffer.concat([wavHeader(pcm.length, ASR_SAMPLE_RATE, 1), pcm]);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', settings.groqSttModel || 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', HINGLISH_PROMPT);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${settings.groqApiKey}` },
            body: form,
            signal: controller.signal
        });
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'Groq transcription timed out.' : `Groq request failed: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const message = String(detail?.error?.message || '').slice(0, 200);
        throw new Error(`Groq transcription failed (${response.status})${message ? `: ${message}` : ''}`);
    }
    const data = await response.json().catch(() => ({}));
    const text = String(data?.text || '').trim();
    // Whisper "hears" these in silence or background noise.
    if (/^(thank you\.?|thanks for watching!?|you|\.|bye\.?)$/i.test(text)) return '';
    return text;
}

module.exports = { transcribePcmChunks, isGroqEnabled, HINGLISH_PROMPT };
