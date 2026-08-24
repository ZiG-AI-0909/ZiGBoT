const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const ffmpegPath = require('ffmpeg-static');
const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    createAudioPlayer,
    createAudioResource,
    StreamType,
    getVoiceConnection
} = require('@discordjs/voice');

const queues = new Map();

function getState(guildId) {
    if (!queues.has(guildId)) {
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
        const state = { player, tracks: [], current: null, volume: 1, loop: false };
        player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
        player.on('error', (error) => console.error(`[ZiGBoT MUSIC] ${error.message}`));
        queues.set(guildId, state);
    }
    return queues.get(guildId);
}

function validateUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Music requires a direct HTTPS audio URL from a permitted source.');
    }
    if (parsed.protocol !== 'https:') {
        throw new Error('Only HTTPS audio sources are allowed.');
    }
    return parsed.toString();
}

async function createTrackResource(track, volume) {
    const response = await fetch(track.url);
    if (!response.ok || !response.body) throw new Error(`Audio source returned HTTP ${response.status}.`);

    const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    Readable.fromWeb(response.body).pipe(ffmpeg.stdin);
    ffmpeg.stderr.on('data', (data) => console.error(`[ZiGBoT MUSIC] ${data.toString().trim()}`));

    return createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: track
    });
}

async function playNext(guildId) {
    const state = queues.get(guildId);
    const connection = getVoiceConnection(guildId);
    if (!state || !connection || state.tracks.length === 0) {
        if (state) state.current = null;
        return;
    }

    const track = state.loop && state.current ? state.current : state.tracks.shift();
    state.current = track;
    try {
        const resource = await createTrackResource(track, state.volume);
        resource.volume?.setVolume(state.volume);
        connection.subscribe(state.player);
        state.player.play(resource);
    } catch (error) {
        state.current = null;
        console.error(`[ZiGBoT MUSIC] ${error.message}`);
        await playNext(guildId);
    }
}

function addTrack(guildId, url, requestedBy) {
    const state = getState(guildId);
    const track = { url: validateUrl(url), requestedBy };
    state.tracks.push(track);
    if (state.player.state.status === AudioPlayerStatus.Idle) void playNext(guildId);
    return { position: state.tracks.length, track };
}

function pause(guildId) {
    const state = getState(guildId);
    return state.player.pause();
}

function resume(guildId) {
    const state = getState(guildId);
    return state.player.unpause();
}

function skip(guildId) {
    const state = getState(guildId);
    return state.player.stop();
}

function stop(guildId) {
    const state = getState(guildId);
    state.tracks = [];
    state.current = null;
    state.loop = false;
    return state.player.stop();
}

function queue(guildId) {
    const state = getState(guildId);
    return { current: state.current, tracks: [...state.tracks], loop: state.loop };
}

function setVolume(guildId, value) {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('Volume must be between 0 and 100.');
    const state = getState(guildId);
    state.volume = volume / 100;
    return volume;
}

function toggleLoop(guildId) {
    const state = getState(guildId);
    state.loop = !state.loop;
    return state.loop;
}

function clearGuild(guildId) {
    stop(guildId);
    queues.delete(guildId);
}

module.exports = { addTrack, pause, resume, skip, stop, queue, setVolume, toggleLoop, clearGuild };
