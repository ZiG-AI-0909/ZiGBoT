const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
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
const youtube = require('./youtube');

const MAX_QUEUE = 50;
const queues = new Map();
// 'trackStart' (guildId, track), 'queueChanged' (guildId), 'finished' (guildId, reason)
// — the music panel (panel.js) listens to keep its message up to date.
const events = new EventEmitter();
events.setMaxListeners(20);

function emit(name, ...args) {
    try {
        events.emit(name, ...args);
    } catch (error) {
        console.error(`[ZiGBoT MUSIC] ${name} listener failed: ${error.message}`);
    }
}

function getState(guildId) {
    if (!queues.has(guildId)) {
        const player = createAudioPlayer({
            behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
        });
        const state = { player, tracks: [], current: null, resource: null, volume: 1, loop: false };
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

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "**Title** (3:45)" for YouTube tracks, the URL for direct audio. */
function describeTrack(track) {
    if (!track) return '';
    if (!track.title) return track.url;
    const length = formatDuration(track.duration);
    return `**${track.title}**${length ? ` (${length})` : ''}`;
}

// Kill helper processes still running for a finished/skipped track.
function killAll(children) {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
    }
}

async function createTrackResource(track) {
    const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const children = [ffmpeg];
    // A raw stream or ffmpeg pipe erroring without a listener crashes the process.
    ffmpeg.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') console.error(`[ZiGBoT MUSIC] ffmpeg stdin: ${error.message}`);
    });
    ffmpeg.stdout.on('error', (error) => console.error(`[ZiGBoT MUSIC] ffmpeg stdout: ${error.message}`));
    ffmpeg.on('error', (error) => console.error(`[ZiGBoT MUSIC] ffmpeg process: ${error.message}`));
    ffmpeg.stderr.on('data', (data) => console.error(`[ZiGBoT MUSIC] ${data.toString().trim()}`));

    if (track.source === 'youtube') {
        const ytdlp = youtube.streamAudio(track.url, {
            onFail: (reason) => announce(track, `❌ Could not play ${describeTrack(track)}: ${reason}`)
        });
        children.push(ytdlp);
        ytdlp.stdout.on('error', () => { /* closed when the track is skipped */ });
        ytdlp.stdout.pipe(ffmpeg.stdin);
    } else {
        let response;
        try {
            response = await fetch(track.url);
            if (!response.ok || !response.body) throw new Error(`Audio source returned HTTP ${response.status}.`);
        } catch (error) {
            killAll(children);
            throw error;
        }
        const webStream = Readable.fromWeb(response.body);
        webStream.on('error', (error) => console.error(`[ZiGBoT MUSIC] audio stream: ${error.message}`));
        webStream.pipe(ffmpeg.stdin);
    }

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: track
    });
    resource.playStream.once('close', () => killAll(children));
    return resource;
}

function announce(track, content) {
    if (typeof track?.announce !== 'function') return;
    Promise.resolve()
        .then(() => track.announce(content))
        .catch((error) => console.error(`[ZiGBoT MUSIC] announce failed: ${error.message}`));
}

async function playNext(guildId) {
    const state = queues.get(guildId);
    const connection = getVoiceConnection(guildId);
    if (!state || !connection || (state.tracks.length === 0 && !(state.loop && state.current))) {
        if (state) {
            const wasPlaying = Boolean(state.current);
            state.current = null;
            state.resource = null;
            if (wasPlaying && connection) emit('finished', guildId, 'queue-end');
        }
        return;
    }

    const previous = state.current;
    const track = state.loop && state.current ? state.current : state.tracks.shift();
    state.current = track;
    try {
        const resource = await createTrackResource(track);
        resource.volume?.setVolume(state.volume);
        state.resource = resource;
        connection.subscribe(state.player);
        state.player.play(resource);
        if (track !== previous) emit('trackStart', guildId, track);
    } catch (error) {
        state.current = null;
        state.resource = null;
        console.error(`[ZiGBoT MUSIC] ${error.message}`);
        announce(track, `❌ Could not play ${describeTrack(track)}: ${error.message}`);
        await playNext(guildId);
    }
}

function pushTrack(guildId, track) {
    const state = getState(guildId);
    if (state.tracks.length >= MAX_QUEUE) throw new Error(`The queue is full (${MAX_QUEUE} songs). Skip or stop some first.`);
    const idle = state.player.state.status === AudioPlayerStatus.Idle && !state.current;
    track.queued = !idle;
    state.tracks.push(track);
    // `current` is set while a track is still loading, so a second /play
    // during that window queues instead of starting a parallel playNext.
    if (idle) void playNext(guildId);
    else emit('queueChanged', guildId);
    return { position: state.tracks.length, track, startedNow: idle };
}

/** Direct HTTPS audio URL only (synchronous). */
function addTrack(guildId, url, requestedBy) {
    return pushTrack(guildId, { source: 'direct', url: validateUrl(url), title: null, duration: null, requestedBy });
}

/** Song name, YouTube link, or direct HTTPS audio URL -> a playable track. */
async function resolve(input) {
    const query = String(input || '').trim();
    if (!query) throw new Error('Tell me a song name or link to play.');
    if (/^https?:\/\//i.test(query) && !youtube.isYouTubeUrl(query)) {
        if (/(^|\.)spotify\.com$/i.test(safeHost(query))) {
            throw new Error('Spotify links cannot be played. Send the song name instead, e.g. `/play kesariya`.');
        }
        return { source: 'direct', url: validateUrl(query), title: null, duration: null };
    }
    return youtube.resolveTrack(query);
}

/**
 * Queue a track from resolve(). `announce(text)` is used later for "now
 * playing" and playback errors in the same channel.
 */
function queueTrack(guildId, track, requestedBy, { announce: announceFn, channel = null } = {}) {
    return pushTrack(guildId, { ...track, requestedBy, announce: announceFn, channel });
}

function safeHost(value) {
    try {
        return new URL(value).hostname;
    } catch {
        return '';
    }
}

function pause(guildId) {
    const state = getState(guildId);
    const done = state.player.pause();
    if (done) emit('queueChanged', guildId);
    return done;
}

function resume(guildId) {
    const state = getState(guildId);
    const done = state.player.unpause();
    if (done) emit('queueChanged', guildId);
    return done;
}

function skip(guildId) {
    const state = getState(guildId);
    // Skipping a looped track moves on instead of replaying it.
    if (state.loop) state.current = null;
    return state.player.stop();
}

function stop(guildId) {
    const state = getState(guildId);
    const wasActive = Boolean(state.current) || state.tracks.length > 0;
    state.tracks = [];
    state.current = null;
    state.resource = null;
    state.loop = false;
    const stopped = state.player.stop();
    if (wasActive) emit('finished', guildId, 'stopped');
    return stopped;
}

function queue(guildId) {
    const state = getState(guildId);
    const status = state.player.state.status;
    return {
        current: state.current,
        tracks: [...state.tracks],
        loop: state.loop,
        volume: Math.round(state.volume * 100),
        paused: status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused
    };
}

function setVolume(guildId, value) {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('Volume must be between 0 and 100.');
    const state = getState(guildId);
    state.volume = volume / 100;
    state.resource?.volume?.setVolume(state.volume);
    emit('queueChanged', guildId);
    return volume;
}

function toggleLoop(guildId) {
    const state = getState(guildId);
    state.loop = !state.loop;
    emit('queueChanged', guildId);
    return state.loop;
}

function clearGuild(guildId) {
    stop(guildId);
    queues.delete(guildId);
}

module.exports = {
    addTrack, resolve, queueTrack, pause, resume, skip, stop, queue, setVolume, toggleLoop, clearGuild,
    describeTrack, formatDuration, events
};
