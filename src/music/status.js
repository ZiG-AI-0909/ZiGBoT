/**
 * Publishes the real music state to Supabase so the dashboard can show it
 * (the dashboard runs on Vercel and cannot reach the bot directly):
 *  - zb_music_state: per server — current song, the next few, volume, loop.
 *  - zb_music_health: one row — yt-dlp / ffmpeg availability, the preferred
 *    source, active players and the most recent playback error.
 * Written with the bot's service-role key only; admins read their own
 * server's row through RLS. Failures are logged and never affect playback.
 */
const fs = require('node:fs');
const ffmpegPath = require('ffmpeg-static');
const music = require('./player');
const sources = require('./sources');

const WRITE_DELAY_MS = 1500;
const HEALTH_INTERVAL_MS = 60_000;

function trackSummary(track) {
    if (!track) return null;
    return {
        title: track.title || null,
        artist: track.artist || null,
        url: track.url,
        duration: track.duration || null,
        thumbnail: track.thumbnail || null,
        source: track.source || 'direct',
        requested_by: track.requestedBy ? String(track.requestedBy) : null,
        fallback_from: track.fallbackFrom || null
    };
}

/** Row for zb_music_state (pure, so it can be tested). */
function stateRow(guildId, q, now = Date.now()) {
    const playing = Boolean(q.current);
    return {
        guild_id: String(guildId),
        status: playing ? (q.paused ? 'paused' : 'playing') : 'idle',
        current_track: trackSummary(q.current),
        upcoming: q.tracks.slice(0, 10).map(trackSummary),
        queue_length: q.tracks.length,
        volume: q.volume,
        loop_mode: q.loop,
        updated_at: new Date(now).toISOString()
    };
}

function startMusicStatus(guildStore, { logger = console } = {}) {
    if (!guildStore?.enabled) return { stop() {} };
    const timers = new Map();
    let lastError = null;
    let warned = false;
    const warnOnce = (error) => {
        if (warned) return;
        warned = true;
        logger.error?.(`[ZiGBoT MUSIC] Could not publish music status (run the music migration?): ${error.message}`);
    };

    const writeState = (guildId) => {
        timers.delete(guildId);
        if (!/^\d{17,20}$/.test(String(guildId))) return;
        guildStore.request('zb_music_state?on_conflict=guild_id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [stateRow(guildId, music.queue(guildId))]
        }).catch(warnOnce);
    };
    const schedule = (guildId) => {
        if (!timers.has(guildId)) timers.set(guildId, setTimeout(() => writeState(guildId), WRITE_DELAY_MS));
    };

    music.events.on('trackStart', (guildId) => schedule(guildId));
    music.events.on('queueChanged', (guildId) => schedule(guildId));
    music.events.on('finished', (guildId) => schedule(guildId));
    music.events.on('trackError', (_guildId, message) => {
        lastError = { message: String(message || '').slice(0, 300), at: new Date().toISOString() };
    });

    let ytdlpVersion = null;
    const writeHealth = async () => {
        if (!ytdlpVersion) ytdlpVersion = await sources.ytDlpVersion();
        const ffmpegReady = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
        await guildStore.request('zb_music_health?on_conflict=id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: [{
                id: 'main',
                ready: Boolean(ytdlpVersion && ffmpegReady),
                ytdlp_version: ytdlpVersion,
                ffmpeg_ready: ffmpegReady,
                preferred_source: sources.preferredSource(),
                active_players: music.activeGuildCount(),
                last_error: lastError?.message || null,
                last_error_at: lastError?.at || null,
                updated_at: new Date().toISOString()
            }]
        }).catch(warnOnce);
    };
    void writeHealth();
    const interval = setInterval(() => void writeHealth(), HEALTH_INTERVAL_MS);
    interval.unref?.();
    return {
        stop() {
            clearInterval(interval);
            for (const timer of timers.values()) clearTimeout(timer);
        }
    };
}

module.exports = { startMusicStatus, stateRow, trackSummary };
