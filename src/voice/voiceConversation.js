const { Readable } = require('node:stream');
const prism = require('prism-media');
const {
    AudioPlayerStatus,
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    StreamType
} = require('@discordjs/voice');
const localSpeech = require('./localSpeech');
const nvidiaSpeech = require('./nvidiaSpeech');

const sessions = new Map();

// Leave the voice channel after it has been empty of humans for this long.
const EMPTY_VC_CHECK_MS = 15_000;
const EMPTY_VC_LEAVE_AFTER_MS = 60_000;

/**
 * Transcribes one utterance: NVIDIA hosted ASR first (Render-safe, no local
 * binaries), local STT command as a configured fallback. Returns '' when
 * nothing intelligible was captured.
 */
async function transcribeUtterance(settings, chunks) {
    if (settings.useNvidiaSpeech !== false) {
        try {
            const transcript = await nvidiaSpeech.transcribePcmChunks(settings, chunks);
            if (transcript) return transcript;
        } catch (error) {
            console.error(`[ZiGBoT VOICE] NVIDIA ASR failed, trying local STT: ${error.message}`);
        }
    }
    if (!settings.sttCommand) return '';
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

function startListening(guild, settings, onTranscript) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) throw new Error('Join a voice channel before starting voice listening.');
    if (sessions.has(guild.id)) return false;

    const receiver = connection.receiver;
    const session = { enabled: true, activeUsers: new Set(), receiver };
    sessions.set(guild.id, session);
    watchForEmptyChannel(guild, session);

    const onSpeakingStart = (userId) => {
        if (!session.enabled || session.activeUsers.has(userId)) return;
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
            if (!session.enabled || chunks.length === 0) return;
            try {
                const transcript = await transcribeUtterance(settings, chunks);
                if (transcript) await onTranscript({ guild, userId, transcript });
            } catch (error) {
                console.error(`[ZiGBoT VOICE] ${error.message}`);
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
async function speak(guildId, settings, text) {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error('ZiGBoT is not connected to voice.');

    let outputPath = null;
    let directory = null;
    let pcm = null;

    if (settings.useNvidiaSpeech !== false) {
        try {
            const result = await nvidiaSpeech.synthesizeSpeech(settings, text);
            outputPath = result.outputPath;
            directory = result.directory;
            pcm = result.pcm;
        } catch (error) {
            console.error(`[ZiGBoT VOICE] NVIDIA TTS failed, trying local TTS: ${error.message}`);
        }
    }
    if (!outputPath) {
        const result = await localSpeech.synthesizeSpeech(settings, text);
        outputPath = result.outputPath;
        directory = result.directory;
    }

    const player = createAudioPlayer();
    const resource = pcm
        ? createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })
        : createAudioResource(outputPath, { inputType: StreamType.Arbitrary });
    connection.subscribe(player);
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => {
        if (directory) nvidiaSpeech.removeTemporaryDirectory(directory).catch(() => {});
    });
}

module.exports = { startListening, stopListening, speak, transcribeUtterance };
