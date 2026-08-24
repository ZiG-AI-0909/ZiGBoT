const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const prism = require('prism-media');
const {
    AudioPlayerStatus,
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    getVoiceConnection,
    StreamType
} = require('@discordjs/voice');
const { transcribeWav, synthesizeSpeech, removeTemporaryDirectory } = require('./localSpeech');

const sessions = new Map();

function wavHeader(dataLength) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(192000, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

async function writeTemporaryWav(chunks) {
    const pcm = Buffer.concat(chunks);
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zigbot-stt-'));
    const wavPath = path.join(directory, 'speech.wav');
    await fsp.writeFile(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));
    return { directory, wavPath };
}

function stopListening(guildId) {
    const session = sessions.get(guildId);
    if (!session) return false;
    session.enabled = false;
    session.receiver.speaking.off('start', session.onSpeakingStart);
    sessions.delete(guildId);
    return true;
}

function startListening(guild, settings, onTranscript) {
    const connection = getVoiceConnection(guild.id);
    if (!connection) throw new Error('Join a voice channel before starting voice listening.');
    if (sessions.has(guild.id)) return false;

    const receiver = connection.receiver;
    const session = { enabled: true, activeUsers: new Set(), receiver };
    sessions.set(guild.id, session);

    const onSpeakingStart = (userId) => {
        if (!session.enabled || session.activeUsers.has(userId)) return;
        session.activeUsers.add(userId);
        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 }
        });
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const chunks = [];
        let totalBytes = 0;
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
            let temporary;
            try {
                temporary = await writeTemporaryWav(chunks);
                const transcript = await transcribeWav(settings, temporary.wavPath);
                if (transcript) await onTranscript({ guild, userId, transcript });
            } catch (error) {
                console.error(`[ZiGBoT VOICE] ${error.message}`);
            } finally {
                if (temporary) await removeTemporaryDirectory(temporary.directory);
            }
        });
    };
    session.onSpeakingStart = onSpeakingStart;
    receiver.speaking.on('start', onSpeakingStart);
    return true;
}

async function speak(guildId, settings, text) {
    const connection = getVoiceConnection(guildId);
    if (!connection) throw new Error('ZiGBoT is not connected to voice.');
    const { outputPath, directory } = await synthesizeSpeech(settings, text);
    const player = createAudioPlayer();
    const resource = createAudioResource(fs.createReadStream(outputPath), { inputType: StreamType.Arbitrary });
    connection.subscribe(player);
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => removeTemporaryDirectory(directory).catch(() => {}));
}

module.exports = { startListening, stopListening, speak };
