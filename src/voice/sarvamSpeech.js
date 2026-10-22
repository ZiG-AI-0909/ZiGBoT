/**
 * Text-to-speech with Sarvam AI (Bulbul): natural Indian voices that read
 * Hinglish and Indian English properly. Used first when SARVAM_API_KEY is
 * set; NVIDIA TTS stays the automatic fallback (voiceConversation.js).
 *
 *   SARVAM_API_KEY   required to enable it (server-side only, never logged)
 *   SARVAM_VOICE     speaker for bulbul:v3 (default "shubh"; e.g. priya, kavya, rahul, aditya)
 *   SARVAM_MODEL     bulbul:v3 (default)
 *   SARVAM_PACE      0.5-2.0 (default 1.0)
 */
const { pcmForPlayback } = require('./nvidiaSpeech');
const { languageMode } = require('../../dashboard/lib/shared/personas');

const ENDPOINT = 'https://api.sarvam.ai/text-to-speech';
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 2500;

function isSarvamEnabled(settings) {
    return Boolean(settings?.sarvamApiKey);
}

/** The server's voice language, else English-only servers get Indian English; everything else Hindi/Hinglish. */
function languageCodeFor(settings) {
    const chosen = settings?.guildContext?.config?.voice_language;
    if (chosen === 'hi-IN' || chosen === 'en-IN') return chosen;
    return languageMode(settings?.guildContext?.config?.language) === 'english' ? 'en-IN' : 'hi-IN';
}

function requestBody(settings, text) {
    const config = settings?.guildContext?.config || {};
    // Per-server choice from the dashboard wins over the bot-wide env defaults.
    const pace = config.voice_pace && config.voice_pace !== 100 ? config.voice_pace / 100 : Number(settings.sarvamPace);
    return {
        text: String(text).slice(0, MAX_TEXT),
        language_code: languageCodeFor(settings),
        model: settings.sarvamModel || 'bulbul:v3',
        speaker: String(config.voice_speaker || settings.sarvamVoice || 'shubh').toLowerCase(),
        pace: Number.isFinite(pace) && pace >= 0.5 && pace <= 2 ? pace : 1.0,
        // Discord's own rate, so only mono -> stereo is left to convert.
        speech_sample_rate: 48000,
        output_audio_codec: 'wav'
    };
}

/** Text -> { pcm } as 48 kHz stereo 16-bit PCM, ready for Discord. */
async function synthesizeSpeech(settings, text) {
    if (!isSarvamEnabled(settings)) throw new Error('SARVAM_API_KEY is not configured.');
    const clean = String(text || '').trim();
    if (!clean) throw new Error('TTS text is empty.');

    const body = requestBody(settings, clean);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
        response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'api-subscription-key': settings.sarvamApiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (error) {
        throw new Error(error.name === 'AbortError' ? 'Sarvam TTS timed out.' : `Sarvam request failed: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const message = String(detail?.error?.message || detail?.error?.code || '').slice(0, 200);
        throw new Error(`Sarvam TTS failed (${response.status})${message ? `: ${message}` : ''}`);
    }
    const data = await response.json().catch(() => ({}));
    const audio = Array.isArray(data?.audios) ? data.audios[0] : null;
    if (!audio) throw new Error('Sarvam TTS returned no audio.');
    return { pcm: pcmForPlayback(Buffer.from(audio, 'base64')), speaker: body.speaker };
}

module.exports = { synthesizeSpeech, isSarvamEnabled, languageCodeFor, requestBody };
