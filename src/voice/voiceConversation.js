const { Readable } = require('node:stream');
const prism = require('prism-media');
const {
    AudioPlayerStatus,
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    StreamType,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const localSpeech = require('./localSpeech');
const nvidiaSpeech = require('./nvidiaSpeech');
const groqSpeech = require('./groqSpeech');
const sarvamSpeech = require('./sarvamSpeech');

const sessions = new Map();

// Per-guild TTS playback queue: when several people talk over each other,
// their replies play sequentially instead of overlapping into garbage.
const playbackQueues = new Map(); // guildId -> Promise chain tail

// Leave the voice channel after it has been empty of humans for this long.
const EMPTY_VC_CHECK_MS = 15_000;
const EMPTY_VC_LEAVE_AFTER_MS = 60_000;

/**
 * Transcribes one utterance: NVIDIA hosted ASR first (Render-safe, no local
 * binaries), local STT command as a configured fallback. Returns '' when
 * nothing intelligible was captured.
 */
async function transcribeUtterance(settings, chunks) {
    // Whisper large-v3 on Groq first (best for Hinglish), then NVIDIA, then local.
    const failures = [];
    if (groqSpeech.isGroqEnabled(settings)) {
        try {
            return await groqSpeech.transcribePcmChunks(settings, chunks);
        } catch (error) {
            console.error(`[ZiGBoT VOICE] Groq Whisper failed, trying NVIDIA: ${error.message}`);
            failures.push(`Groq: ${error.message}`);
        }
    }
    if (settings.useNvidiaSpeech !== false) {
        try {
            const transcript = await nvidiaSpeech.transcribePcmChunks(settings, chunks);
            if (transcript) return transcript;
            if (!failures.length) return '';
        } catch (error) {
            console.error(`[ZiGBoT VOICE] NVIDIA ASR failed, trying local STT: ${error.message}`);
            failures.push(`NVIDIA: ${error.message}`);
        }
    }
    if (!settings.sttCommand) {
        // Every service failed: say so instead of looking like silence.
        if (failures.length) throw new Error(`speech-to-text failed (${failures.join(' | ').slice(0, 300)})`);
        return '';
    }
    const { directory, wavPath } = await nvidiaSpeech.writeTemporaryWav(chunks);
    try {
        return (await localSpeech.transcribeWav(settings, wavPath)) || '';
    } finally {
        await nvidiaSpeech.removeTemporaryDirectory(directory).catch(() => {});
    }
}

function stopListening(guildId) {
    const session = sessions.get(guildId);
    if (!session) return false;
    session.enabled = false;
    session.receiver.speaking.off('start', session.onSpeakingStart);
    if (session.emptyCheckInterval) clearInterval(session.emptyCheckInterval);
    sessions.delete(guildId);
    return true;
}

// Auto-leave: when every human has left the bot's voice channel, stop
// listening and disconnect so the bot never sits alone in an empty VC.
function watchForEmptyChannel(guild, session) {
    session.emptyCheckInterval = setInterval(() => {
        const botChannelId = guild.members?.me?.voice?.channelId;
        if (!botChannelId) {
            stopListening(guild.id);
            return;
        }
        const humansPresent = guild.voiceStates.cache.some(
            (state) => state.channelId === botChannelId && !state.member?.user?.bot
        );
        if (!humansPresent) {
            console.log(`[ZiGBoT VOICE] Channel empty in ${guild.name}; disconnecting.`);
            stopListening(guild.id);
            const connection = getVoiceConnection(guild.id);
            if (connection) connection.destroy();
        }
    }, EMPTY_VC_CHECK_MS);
    session.emptyCheckInterval.unref?.();
}

// How often a "I heard you but could not understand" note may be posted.
const FAILURE_NOTICE_EVERY_MS = 2 * 60_000;

/**
 * notify(text) posts a short note in the text channel the listening was
 * started from, e.g. when speech-to-text keeps failing.
 */
function startListening(guild, settings, onTranscript, { notify = null } = {}) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) throw new Error('Join a voice channel before starting voice listening.');
    const existing = sessions.get(guild.id);
    if (existing && existing.receiver === connection.receiver) {
        if (notify) existing.notify = notify;
        return false;
    }
    // A session left over from an earlier (now destroyed) connection would
    // listen to nothing: replace it.
    if (existing) stopListening(guild.id);

    const receiver = connection.receiver;
    const session = { enabled: true, activeUsers: new Set(), receiver, notify, lastFailureNotice: 0 };
    sessions.set(guild.id, session);
    watchForEmptyChannel(guild, session);
    connection.once(VoiceConnectionStatus.Destroyed, () => {
        if (sessions.get(guild.id) === session) stopListening(guild.id);
    });

    const onSpeakingStart = (userId) => {
        if (!session.enabled || session.activeUsers.has(userId)) {
            console.log(`[ZiGBoT VC] speaking event ignored (enabled=${session.enabled}, busy=${session.activeUsers.has(userId)}) user=${userId}`);
            return;
        }
        console.log(`[ZiGBoT VC] capturing audio from user=${userId}`);
        session.activeUsers.add(userId);
        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
        });
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const chunks = [];
        let totalBytes = 0;
        // Unhandled 'error' on a raw stream would crash the whole process.
        opusStream.on('error', (error) => console.error(`[ZiGBoT VOICE] opus stream: ${error.message}`));
        decoder.on('error', (error) => console.error(`[ZiGBoT VOICE] decoder: ${error.message}`));
        opusStream.pipe(decoder);
        decoder.on('data', (chunk) => {
            if (totalBytes < 48_000 * 2 * 2 * 15) {
                chunks.push(chunk);
                totalBytes += chunk.length;
            }
        });
        decoder.once('end', async () => {
            session.activeUsers.delete(userId);
            if (!session.enabled || chunks.length === 0) {
                console.log(`[ZiGBoT VC] utterance discarded (enabled=${session.enabled}, chunks=${chunks.length}) user=${userId}`);
                return;
            }
            const seconds = (totalBytes / (48_000 * 2 * 2)).toFixed(1);
            console.log(`[ZiGBoT VC] utterance captured (${seconds}s, ${totalBytes} bytes) user=${userId}; transcribing...`);
            try {
                const transcript = await transcribeUtterance(settings, chunks);
                if (!transcript) {
                    console.log('[ZiGBoT VC] ASR returned an empty transcript; ignoring.');
                    return;
                }
                console.log(`[ZiGBoT VC] transcript: "${transcript}"`);
                await onTranscript({ guild, userId, transcript });
            } catch (error) {
                console.error(`[ZiGBoT VOICE] ${error.message}`);
                if (typeof session.notify === 'function' && Date.now() - session.lastFailureNotice > FAILURE_NOTICE_EVERY_MS) {
                    session.lastFailureNotice = Date.now();
                    Promise.resolve(session.notify(`🎙️ I heard you, but couldn't understand it: ${error.message}`)).catch(() => {});
                }
            }
        });
    };
    session.onSpeakingStart = onSpeakingStart;
    receiver.speaking.on('start', onSpeakingStart);
    return true;
}

/**
 * Speaks text through the bot's voice connection using hosted Magpie TTS.
 * The returned PCM is already 48kHz stereo s16le, so it is fed to Discord as
 * StreamType.Raw — no ffmpeg involved in the voice path at all.
 * Falls back to a locally configured TTS command when NVIDIA speech is off.
 */
/**
 * Chat text -> something a voice can read: no mentions, links, custom emojis,
 * emoji, markdown or code. Returns '' when nothing speakable is left.
 */
function toSpeechText(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<a?:(\w+):\d+>/g, ' ')
        .replace(/<[@#][!&]?\d+>/g, ' ')
        .replace(/https?:\/\/\S+/g, ' a link ')
        .replace(/[*_~`|>#]+/g, ' ')
        .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
}

async function speak(guildId, settings, rawText) {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error('ZiGBoT is not connected to voice.');
    const text = toSpeechText(rawText);
    if (!text) return;

    let outputPath = null;
    let directory = null;
    let pcm = null;

    // Sarvam (Indian voices) first, then NVIDIA, then a local TTS command.
    if (sarvamSpeech.isSarvamEnabled(settings)) {
        try {
            ({ pcm } = await sarvamSpeech.synthesizeSpeech(settings, text));
        } catch (error) {
            console.error(`[ZiGBoT VOICE] Sarvam TTS failed, trying NVIDIA: ${error.message}`);
        }
    }
    if (!pcm && settings.useNvidiaSpeech !== false) {
        try {
            const result = await nvidiaSpeech.synthesizeSpeech(settings, text);
            outputPath = result.outputPath;
            directory = result.directory;
            pcm = result.pcm;
        } catch (error) {
            console.error(`[ZiGBoT VOICE] NVIDIA TTS failed, trying local TTS: ${error.message}`);
        }
    }
    if (!outputPath && !pcm) {
        const result = await localSpeech.synthesizeSpeech(settings, text);
        outputPath = result.outputPath;
        directory = result.directory;
    }

    // Queue behind any reply already playing in this guild.
    const previous = playbackQueues.get(guildId) || Promise.resolve();
    let release;
    const myTurn = new Promise((resolve) => { release = resolve; });
    playbackQueues.set(guildId, previous.then(() => myTurn));
    await previous.catch(() => {});

    try {
        console.log(`[ZiGBoT VC] speaking reply (${text.length} chars)`);
        const player = createAudioPlayer();
        // Without this listener, a player error is an unhandled 'error' event
        // and crashes the whole process.
        player.on('error', (error) => console.error(`[ZiGBoT VC] playback error: ${error.message}`));
        const resource = pcm
            ? createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })
            : createAudioResource(outputPath, { inputType: StreamType.Arbitrary });
        connection.subscribe(player);
        player.play(resource);
        await new Promise((resolve) => {
            // Idle = finished; error = give up but never wedge the queue.
            player.once(AudioPlayerStatus.Idle, resolve);
            player.once('error', resolve);
            // Absolute watchdog so a stuck stream cannot block every future reply.
            setTimeout(resolve, 120_000).unref?.();
        });
        console.log('[ZiGBoT VC] playback finished.');
    } finally {
        release?.();
        if (directory) nvidiaSpeech.removeTemporaryDirectory(directory).catch(() => {});
    }
}

// True when the guild's voice session is actively capturing audio.
function isListening(guildId) {
    return sessions.get(guildId)?.enabled === true;
}

module.exports = { startListening, stopListening, speak, transcribeUtterance, isListening, toSpeechText };
