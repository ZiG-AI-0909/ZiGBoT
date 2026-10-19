/**
 * Per-server music player: one queue, one @discordjs/voice AudioPlayer and
 * one set of child processes per guild (keyed by guild id, so servers never
 * share state). Audio: yt-dlp (YouTube / SoundCloud) or a direct https file
 * -> ffmpeg -> raw PCM -> Discord.
 *
 * Events (for the music panel and the dashboard snapshot):
 *   'trackStart' (guildId, track)   a track began playing
 *   'queueChanged' (guildId)        queue / pause / volume / loop changed
 *   'finished' (guildId, reason)    'queue-end' | 'stopped' | 'left'
 *   'trackError' (guildId, message) a track could not be played (or needed the fallback)
 */
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
const sources = require('./sources');

const MAX_QUEUE = 50;
const LOOP_MODES = ['off', 'track', 'queue'];
const DEFAULT_IDLE_MINUTES = 3;
const queues = new Map();
const events = new EventEmitter();
events.setMaxListeners(20);

// index.js sets this so an idle music session never cuts off a voice chat in progress.
let idleLeaveGuard = () => true;

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
        const state = {
            player,
            tracks: [],
            current: null,
            resource: null,
            volume: 1,
            loop: 'off',
            loading: false,
            skipping: false,
            idleMinutes: DEFAULT_IDLE_MINUTES,
            leaveTimer: null,
            pausedForEmpty: false
        };
        player.on(AudioPlayerStatus.Idle, () => void playNext(guildId));
        player.on('error', (error) => console.error(`[ZiGBoT MUSIC] ${guildId}: ${error.message}`));
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

/** "**Title** (3:45)" for searched tracks, the URL for direct audio. */
function describeTrack(track) {
    if (!track) return '';
    if (!track.title) return track.url;
    const length = formatDuration(track.duration);
    return `**${track.title}**${length ? ` (${length})` : ''}`;
}

function announce(track, content) {
    if (typeof track?.announce !== 'function') return;
    Promise.resolve()
        .then(() => track.announce(content))
        .catch((error) => console.error(`[ZiGBoT MUSIC] announce failed: ${error.message}`));
}

// Kill helper processes still running for a finished/skipped track.
function killAll(children) {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
    }
}

// yt-dlp audio for a YouTube/SoundCloud track. YouTube often refuses audio to
// cloud hosts; then the same song is played from SoundCloud instead.
async function openSearchedTrack(track) {
    try {
        return await sources.openStream(track.url);
    } catch (error) {
        if (track.source !== 'youtube' || !sources.isHostBlocked(error.message)) throw error;
        const alt = await sources.findAlternative(track);
        if (!alt) throw new Error(`${error.message} I could not find it on SoundCloud either.`);
        console.log(`[ZiGBoT MUSIC] YouTube refused "${track.title}"; using SoundCloud ${alt.url}`);
        emit('trackError', track.guildId, `YouTube refused audio; played from SoundCloud instead (${error.message})`);
        announce(track, `⚠️ YouTube would not stream **${track.title}** to the bot's server, so I'm playing it from SoundCloud: ${describeTrack(alt)}`);
        Object.assign(track, alt, { fallbackFrom: 'youtube' });
        return sources.openStream(track.url);
    }
}

async function createTrackResource(track) {
    const children = [];
    let input;
    if (track.source === 'youtube' || track.source === 'soundcloud') {
        const child = await openSearchedTrack(track);
        children.push(child);
        child.on('close', () => { if (child.failureReason) track.lastError = child.failureReason; });
        input = child.stdout;
    } else {
        // The timeout covers the response headers only, never the song itself.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        let response;
        try {
            response = await fetch(track.url, { signal: controller.signal });
        } catch {
            throw new Error('The audio link did not respond.');
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok || !response.body) throw new Error(`Audio source returned HTTP ${response.status}.`);
        input = Readable.fromWeb(response.body);
        input.on('error', (error) => console.error(`[ZiGBoT MUSIC] audio stream: ${error.message}`));
    }

    const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(ffmpeg);
    // A raw stream or ffmpeg pipe erroring without a listener crashes the process.
    ffmpeg.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') console.error(`[ZiGBoT MUSIC] ffmpeg stdin: ${error.message}`);
    });
    ffmpeg.stdout.on('error', (error) => console.error(`[ZiGBoT MUSIC] ffmpeg stdout: ${error.message}`));
    ffmpeg.on('error', (error) => {
        console.error(`[ZiGBoT MUSIC] ffmpeg process: ${error.message}`);
        track.lastError = error.code === 'ENOENT' ? 'ffmpeg is missing on the bot\'s server.' : `ffmpeg failed: ${error.message}`;
    });
    ffmpeg.stderr.on('data', (data) => {
        const text = data.toString().trim();
        console.error(`[ZiGBoT MUSIC] ffmpeg: ${text}`);
        if (text) track.lastError = `audio conversion error: ${text.split(/\r?\n/)[0].slice(0, 160)}`;
    });
    input.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: track
    });
    resource.playStream.once('close', () => killAll(children));
    return resource;
}

function cancelLeave(state) {
    if (state?.leaveTimer) {
        clearTimeout(state.leaveTimer);
        state.leaveTimer = null;
    }
}

/** Leave the voice channel after `minutes` unless something plays again first. */
function scheduleLeave(guildId, minutes, reason = 'idle') {
    const state = queues.get(guildId);
    if (!state) return;
    cancelLeave(state);
    const ms = Math.max(1, Number(minutes) || DEFAULT_IDLE_MINUTES) * 60_000;
    state.leaveTimer = setTimeout(() => {
        state.leaveTimer = null;
        if (state.current && reason === 'idle') return;
        if (!idleLeaveGuard(guildId)) return;
        const connection = getVoiceConnection(guildId);
        console.log(`[ZiGBoT MUSIC] ${guildId}: leaving voice (${reason}).`);
        clearGuild(guildId, 'left');
        try { connection?.destroy(); } catch { /* already gone */ }
    }, ms);
    state.leaveTimer.unref?.();
}

function nextTrack(state) {
    const previous = state.current;
    const skipping = state.skipping;
    state.skipping = false;
    if (previous && !previous.failed) {
        if (state.loop === 'track' && !skipping) return previous;
        if (state.loop === 'queue') state.tracks.push(previous);
    }
    return state.tracks.shift() || null;
}

// A song that stops after a few seconds although it is much longer means the
// audio stream broke (blocked source, missing ffmpeg, network): say so instead
// of silently moving on.
const EARLY_END_MS = 15_000;
function reportEarlyEnd(guildId, state) {
    const track = state.current;
    const playedMs = state.resource?.playbackDuration ?? 0;
    if (!track || track.failed || state.skipping || state.resource?.metadata !== track || playedMs >= EARLY_END_MS || !(track.duration > 30)) return;
    const reason = track.lastError || 'the audio stream stopped unexpectedly.';
    console.error(`[ZiGBoT MUSIC] ${guildId}: "${track.title || track.url}" ended after ${Math.round(playedMs / 1000)}s: ${reason}`);
    emit('trackError', guildId, `"${track.title || track.url}" stopped after ${Math.round(playedMs / 1000)}s: ${reason}`);
    announce(track, `⚠️ ${describeTrack(track)} stopped after ${Math.round(playedMs / 1000)}s: ${reason}`);
    track.failed = true;
}

async function playNext(guildId) {
    const state = queues.get(guildId);
    if (!state || state.loading) return;
    reportEarlyEnd(guildId, state);
    const connection = getVoiceConnection(guildId);
    const track = connection ? nextTrack(state) : null;
    if (!track) {
        const wasPlaying = Boolean(state.current);
        state.current = null;
        state.resource = null;
        if (wasPlaying && connection) {
            emit('finished', guildId, 'queue-end');
            scheduleLeave(guildId, state.idleMinutes, 'idle');
        }
        return;
    }

    const previous = state.current;
    state.current = track;
    state.loading = true;
    cancelLeave(state);
    try {
        const resource = await createTrackResource(track);
        // Stopped or left while the stream was starting.
        if (state.current !== track || !getVoiceConnection(guildId)) {
            resource.playStream.destroy();
            return;
        }
        resource.volume?.setVolume(state.volume);
        state.resource = resource;
        getVoiceConnection(guildId).subscribe(state.player);
        state.player.play(resource);
        if (track !== previous || track.fallbackFrom) emit('trackStart', guildId, track);
    } catch (error) {
        console.error(`[ZiGBoT MUSIC] ${guildId}: ${error.message}`);
        emit('trackError', guildId, error.message);
        announce(track, `❌ Could not play ${describeTrack(track)}: ${error.message}`);
        track.failed = true;
        state.loading = false;
        await playNext(guildId);
        return;
    } finally {
        state.loading = false;
    }
}

function pushTrack(guildId, track, { front = false } = {}) {
    const state = getState(guildId);
    if (state.tracks.length >= MAX_QUEUE) throw new Error(`The queue is full (${MAX_QUEUE} songs). Remove or skip some first.`);
    const idle = !state.current && !state.loading;
    if (front) state.tracks.unshift(track);
    else state.tracks.push(track);
    if (idle) void playNext(guildId);
    else emit('queueChanged', guildId);
    return { position: front ? 1 : state.tracks.length, track, startedNow: idle };
}

/** Direct HTTPS audio URL only (synchronous). */
function addTrack(guildId, url, requestedBy) {
    return pushTrack(guildId, { source: 'direct', url: validateUrl(url), title: null, duration: null, requestedBy });
}

function safeHost(value) {
    try {
        return new URL(value).hostname;
    } catch {
        return '';
    }
}

/** Song name, YouTube/SoundCloud link, or direct HTTPS audio URL -> a playable track. */
async function resolve(input) {
    const query = String(input || '').trim();
    if (!query) throw new Error('Tell me a song name or link to play.');
    if (/^https?:\/\//i.test(query) && !sources.sourceOfUrl(query)) {
        if (/(^|\.)spotify\.com$/i.test(safeHost(query))) {
            throw new Error('Spotify links cannot be played. Send the song name instead, e.g. `/play faded`.');
        }
        return { source: 'direct', url: validateUrl(query), title: null, duration: null };
    }
    return sources.resolveTrack(query);
}

/**
 * Apply per-server music settings at the start of a session:
 * idle-disconnect minutes always, the default volume only while nothing plays.
 */
function configure(guildId, { idleMinutes, defaultVolume } = {}) {
    const state = getState(guildId);
    if (Number.isFinite(idleMinutes) && idleMinutes >= 1) state.idleMinutes = Math.min(60, idleMinutes);
    if (!state.current && !state.loading && Number.isFinite(defaultVolume) && defaultVolume >= 1 && defaultVolume <= 100) {
        state.volume = defaultVolume / 100;
    }
}

/**
 * Queue a track from resolve(). `announce(text)` reports problems in the
 * channel; `channel` is where the music panel is shown.
 */
function queueTrack(guildId, track, requestedBy, { announce: announceFn, channel = null, front = false } = {}) {
    return pushTrack(guildId, { ...track, guildId, requestedBy, announce: announceFn, channel }, { front });
}

function pause(guildId) {
    const state = getState(guildId);
    const done = state.player.pause();
    if (done) emit('queueChanged', guildId);
    return done;
}

function resume(guildId) {
    const state = getState(guildId);
    state.pausedForEmpty = false;
    const done = state.player.unpause();
    if (done) emit('queueChanged', guildId);
    return done;
}

function skip(guildId) {
    const state = getState(guildId);
    if (!state.current) return false;
    state.skipping = true;
    return state.player.stop(true);
}

function stop(guildId, reason = 'stopped') {
    const state = getState(guildId);
    const wasActive = Boolean(state.current) || state.tracks.length > 0;
    state.tracks = [];
    state.current = null;
    state.resource = null;
    state.loop = 'off';
    state.pausedForEmpty = false;
    const stopped = state.player.stop(true);
    if (wasActive) emit('finished', guildId, reason);
    if (reason === 'stopped') scheduleLeave(guildId, state.idleMinutes, 'idle');
    return stopped;
}

function shuffle(guildId) {
    const state = getState(guildId);
    const list = state.tracks;
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    if (list.length > 1) emit('queueChanged', guildId);
    return list.length;
}

/** Remove the upcoming track at 1-based `position`; returns it. */
function remove(guildId, position) {
    const state = getState(guildId);
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= state.tracks.length) {
        throw new Error(state.tracks.length ? `Pick a position between 1 and ${state.tracks.length}.` : 'The queue is empty.');
    }
    const [removed] = state.tracks.splice(index, 1);
    emit('queueChanged', guildId);
    return removed;
}

/** Empty the upcoming queue (the current song keeps playing); returns how many were removed. */
function clearQueue(guildId) {
    const state = getState(guildId);
    const count = state.tracks.length;
    state.tracks = [];
    if (count) emit('queueChanged', guildId);
    return count;
}

function queue(guildId) {
    const state = getState(guildId);
    const status = state.player.state.status;
    return {
        current: state.current,
        tracks: [...state.tracks],
        loop: state.loop,
        volume: Math.round(state.volume * 100),
        paused: status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused,
        loading: state.loading,
        elapsedMs: state.resource?.playbackDuration || 0
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

function setLoop(guildId, mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error('Loop mode must be track, queue or off.');
    const state = getState(guildId);
    state.loop = mode;
    emit('queueChanged', guildId);
    return mode;
}

/** off -> track -> queue -> off. Returns the new mode. */
function toggleLoop(guildId) {
    const state = getState(guildId);
    return setLoop(guildId, LOOP_MODES[(LOOP_MODES.indexOf(state.loop) + 1) % LOOP_MODES.length]);
}

/** Everyone left the voice channel: pause and leave later unless someone returns. */
function onChannelEmpty(guildId) {
    const state = queues.get(guildId);
    if (!state) return;
    if (state.current && state.player.pause()) {
        state.pausedForEmpty = true;
        emit('queueChanged', guildId);
    }
    scheduleLeave(guildId, state.idleMinutes, 'empty');
}

/** Someone came back: cancel the pending leave and resume what was auto-paused. */
function onChannelOccupied(guildId) {
    const state = queues.get(guildId);
    if (!state) return;
    cancelLeave(state);
    if (state.pausedForEmpty) {
        state.pausedForEmpty = false;
        if (state.player.unpause()) emit('queueChanged', guildId);
    }
    if (!state.current) scheduleLeave(guildId, state.idleMinutes, 'idle');
}

function isActive(guildId) {
    const state = queues.get(guildId);
    return Boolean(state && (state.current || state.tracks.length || state.loading));
}

function activeGuildCount() {
    let count = 0;
    for (const id of queues.keys()) if (isActive(id)) count += 1;
    return count;
}

function clearGuild(guildId, reason = 'stopped') {
    const state = queues.get(guildId);
    if (!state) return;
    cancelLeave(state);
    const wasActive = Boolean(state.current) || state.tracks.length > 0;
    state.tracks = [];
    state.current = null;
    state.resource = null;
    state.player.stop(true);
    queues.delete(guildId);
    if (wasActive || reason === 'left') emit('finished', guildId, reason);
}

function setIdleLeaveGuard(fn) {
    idleLeaveGuard = typeof fn === 'function' ? fn : () => true;
}

module.exports = {
    addTrack, resolve, queueTrack, configure,
    pause, resume, skip, stop, shuffle, remove, clearQueue,
    queue, setVolume, setLoop, toggleLoop, clearGuild,
    onChannelEmpty, onChannelOccupied, isActive, activeGuildCount, setIdleLeaveGuard,
    describeTrack, formatDuration, events, LOOP_MODES, MAX_QUEUE,
    // For tests only.
    _openSearchedTrack: openSearchedTrack
};
