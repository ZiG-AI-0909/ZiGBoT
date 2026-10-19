/**
 * Music sources: search + audio streaming through the yt-dlp binary
 * (maintained; installed into bin/ by scripts/fetch-ytdlp.js, or YTDLP_PATH).
 *
 * Sources: YouTube and SoundCloud. MUSIC_SOURCE picks where song-name
 * searches go first ("youtube", the default, or "soundcloud"). Cloud hosts
 * are often refused audio by YouTube even though search works, so a YouTube
 * track that cannot be streamed is automatically replaced by the same song
 * from SoundCloud (see player.js) — nothing tries to get around YouTube's
 * block itself.
 *
 * yt-dlp runs with argument arrays (never a shell); user text only reaches it
 * as a "<site>search:" query or a validated youtube/soundcloud URL after
 * "--", so it can never be read as a yt-dlp option.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RESOLVE_TIMEOUT_MS = 30_000;
// Free hosts have slow CPUs: yt-dlp can need a while before the first audio bytes.
const STREAM_START_TIMEOUT_MS = Math.min(120, Math.max(10, Number(process.env.MUSIC_STREAM_TIMEOUT_SECONDS) || 45)) * 1000;
const MAX_DURATION_SECONDS = 3 * 60 * 60;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = {
    youtube: /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i,
    soundcloud: /^(?:www\.|m\.)?soundcloud\.com$/i
};
const SEARCH_PREFIX = { youtube: 'ytsearch', soundcloud: 'scsearch' };
const SOURCE_LABEL = { youtube: 'YouTube', soundcloud: 'SoundCloud', direct: 'Direct link' };

function ytDlpPath() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    const local = path.join(__dirname, '..', '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    return fs.existsSync(local) ? local : 'yt-dlp';
}

/** Is a yt-dlp binary present? (For health reporting; 'yt-dlp' on PATH is assumed present.) */
function ytDlpInstalled() {
    const bin = ytDlpPath();
    return bin === 'yt-dlp' ? null : fs.existsSync(bin);
}

function preferredSource() {
    return String(process.env.MUSIC_SOURCE || '').toLowerCase() === 'soundcloud' ? 'soundcloud' : 'youtube';
}

// Optional: cookies of a YouTube login (YTDLP_COOKIES_FILE). yt-dlp writes
// cookies back on exit and Render secret files are read-only, so it gets a
// private temp copy.
let cookiesCopy;
function cookiesArgs() {
    const source = process.env.YTDLP_COOKIES_FILE;
    if (!source) return [];
    if (cookiesCopy === undefined) {
        try {
            cookiesCopy = path.join(os.tmpdir(), `zigbot-ytdlp-cookies-${process.pid}.txt`);
            fs.copyFileSync(source, cookiesCopy);
            fs.chmodSync(cookiesCopy, 0o600);
        } catch (error) {
            console.error(`[ZiGBoT MUSIC] Could not read YTDLP_COOKIES_FILE: ${error.message}`);
            cookiesCopy = null;
        }
    }
    return cookiesCopy ? ['--cookies', cookiesCopy] : [];
}

// YouTube needs a JavaScript runtime for signatures; reuse the Node running the bot.
function baseArgs() {
    return ['--no-warnings', '--no-playlist', '--js-runtimes', `node:${process.execPath}`, ...cookiesArgs()];
}

function hostOf(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.hostname : '';
    } catch {
        return '';
    }
}

/** 'youtube' | 'soundcloud' | null for an https URL. */
function sourceOfUrl(value) {
    const host = hostOf(value);
    if (!host) return null;
    if (HOSTS.youtube.test(host)) return 'youtube';
    if (HOSTS.soundcloud.test(host)) return 'soundcloud';
    return null;
}

const isYouTubeUrl = (value) => sourceOfUrl(value) === 'youtube';

// yt-dlp's own errors are long; keep the one thing that explains the problem.
function friendlyError(stderr) {
    const line = String(stderr || '').split(/\r?\n/).find((l) => l.startsWith('ERROR:')) || '';
    if (/sign in to confirm|not a bot|http error 403|forbidden|requested format is not available|po.?token/i.test(line)) {
        return 'YouTube refused to send audio to this bot\'s server.';
    }
    if (/private video|unavailable|removed|deleted|copyright|terminated|does not exist/i.test(line)) {
        return 'That track is unavailable (private, removed or blocked).';
    }
    if (/age|inappropriate|confirm your age/i.test(line)) return 'That video is age-restricted.';
    if (/members-only|join this channel/i.test(line)) return 'That video is for channel members only.';
    if (/not available in your country|geo/i.test(line)) return 'That track is not available in the bot\'s region.';
    return 'Could not load that track. Try another song or link.';
}

/** True when the failure is YouTube refusing this host (worth a SoundCloud fallback). */
function isHostBlocked(message) {
    return /refused to send audio|Could not load that track|took too long/i.test(String(message || ''));
}

function run(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(ytDlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            reject(error);
            return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('The music source took too long to answer. Try again.'));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
        child.on('error', (error) => {
            clearTimeout(timer);
            console.error(`[ZiGBoT MUSIC] yt-dlp failed to start: ${error.message}`);
            reject(new Error('Music playback is not installed on this host (yt-dlp missing).'));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(stdout);
            else {
                console.error(`[ZiGBoT MUSIC] yt-dlp exited ${code}: ${stderr.trim().slice(0, 500)}`);
                reject(new Error(friendlyError(stderr)));
            }
        });
    });
}

function pickThumbnail(info, source) {
    if (source === 'youtube' && YOUTUBE_ID.test(String(info.id || ''))) return `https://i.ytimg.com/vi/${info.id}/mqdefault.jpg`;
    const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
    const best = thumbs.find((t) => t.id === 't300x300') || thumbs.find((t) => t.id === 'large') || thumbs[thumbs.length - 1];
    const url = best?.url || info.thumbnail;
    return url && hostOf(url) ? url : null;
}

/** One yt-dlp JSON entry -> our track shape, or null when it is unusable. */
function toTrack(info, source) {
    if (!info || typeof info !== 'object') return null;
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') return null;
    let url;
    if (source === 'youtube') {
        if (!YOUTUBE_ID.test(String(info.id || ''))) return null;
        url = `https://www.youtube.com/watch?v=${info.id}`;
    } else {
        url = [info.webpage_url, info.url].find((u) => sourceOfUrl(u) === 'soundcloud');
        if (!url) return null;
    }
    const duration = Number(info.duration) || null;
    if (duration && duration > MAX_DURATION_SECONDS) return null;
    return {
        source,
        url,
        title: String(info.title || 'Unknown title').slice(0, 200),
        artist: String(info.channel || info.uploader || info.artist || '').slice(0, 100) || null,
        duration: duration ? Math.round(duration) : null,
        thumbnail: pickThumbnail(info, source)
    };
}

const PRINT = '%(.{id,title,duration,uploader,channel,artist,url,webpage_url,live_status,thumbnail,thumbnails})j';

function parseLines(output, source) {
    return String(output || '').split(/\r?\n/).map((line) => {
        try {
            return toTrack(JSON.parse(line), source);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

/** Up to `limit` (1-10) results for a song name. */
async function search(query, { source = preferredSource(), limit = 5 } = {}) {
    const text = String(query || '').trim().slice(0, 200);
    if (!text) throw new Error('Tell me a song name to search for.');
    const count = Math.min(10, Math.max(1, limit));
    const output = await run([
        ...baseArgs(), '--flat-playlist', '--skip-download', '--print', PRINT,
        '--', `${SEARCH_PREFIX[source]}${count}:${text}`
    ], RESOLVE_TIMEOUT_MS);
    return parseLines(output, source);
}

/** Metadata for one YouTube / SoundCloud URL. */
async function resolveUrl(url) {
    const source = sourceOfUrl(url);
    if (!source) throw new Error('Only YouTube and SoundCloud links (or direct https audio files) are supported.');
    const output = await run([...baseArgs(), '--skip-download', '--print', PRINT, '--', url], RESOLVE_TIMEOUT_MS);
    const [track] = parseLines(output, source);
    if (!track) throw new Error('That link is a live stream, too long (over 3 hours), or not a playable track.');
    return track;
}

/**
 * Song name or YouTube/SoundCloud link -> the best track. A song-name search
 * that fails on the preferred source is retried on the other one.
 */
async function resolveTrack(query) {
    const input = String(query || '').trim();
    if (sourceOfUrl(input)) return resolveUrl(input);
    const first = preferredSource();
    const second = first === 'youtube' ? 'soundcloud' : 'youtube';
    let firstError = null;
    try {
        const [track] = await search(input, { source: first, limit: 1 });
        if (track) return track;
    } catch (error) {
        firstError = error;
    }
    const [fallback] = await search(input, { source: second, limit: 1 }).catch(() => []);
    if (fallback) return fallback;
    if (firstError && !/No results/.test(firstError.message)) throw firstError;
    throw new Error(`No results for "${input.slice(0, 80)}".`);
}

// Words YouTube uploaders add around a song name that only hurt a search.
const TITLE_NOISE = /\b(official|full|video|audio|song|songs|lyrics?|lyrical|4k|hd|hq|remastered|remaster|new|latest|music|mv|visualizer|t-series|19\d\d|20\d\d)\b|[:"“”]/gi;

function cleanPart(text) {
    return String(text || '')
        .replace(/\([^)]*\)|\[[^\]]*\]|@/g, ' ')
        .replace(TITLE_NOISE, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–|]+|[\s\-–|]+$/g, '')
        .trim();
}

/**
 * Search queries for the same song elsewhere, best first. YouTube titles look
 * like "Official: Song Full VIDEO | Artist | Album 2014" or "Artist - Song
 * (Official Video)"; keep the song and artist parts, drop the rest.
 */
function alternativeQueries(track) {
    const parts = String(track.title || '').split(/\s[|｜]\s|\s[-–]\s/).map(cleanPart).filter(Boolean);
    const channel = cleanPart(String(track.artist || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, ''));
    const queries = [];
    if (parts.length >= 2) queries.push(`${parts[0]} ${parts[1]}`);
    if (parts.length >= 1 && channel && !parts.slice(0, 2).some((p) => p.toLowerCase().includes(channel.toLowerCase()))) {
        queries.push(`${parts[0]} ${channel}`);
    }
    if (parts.length >= 1) queries.push(parts[0]);
    return [...new Set(queries.map((q) => q.slice(0, 120)).filter((q) => q.length >= 2))].slice(0, 3);
}

/** The same song on SoundCloud, for a YouTube track this host cannot stream. */
async function findAlternative(track) {
    for (const query of alternativeQueries(track)) {
        try {
            const [alt] = await search(query, { source: 'soundcloud', limit: 1 });
            if (alt) return alt;
        } catch (error) {
            console.error(`[ZiGBoT MUSIC] SoundCloud search failed for "${query}": ${error.message}`);
        }
    }
    console.error(`[ZiGBoT MUSIC] No SoundCloud match for "${track.title}" (tried: ${alternativeQueries(track).join(' / ')})`);
    return null;
}

/**
 * Start yt-dlp streaming a track's audio to stdout. Resolves with the
 * process once the first audio bytes arrive, so "this host is blocked" is a
 * clean rejection instead of a silent track. Caller owns (and kills) it.
 */
function openStream(url, { timeoutMs = STREAM_START_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        if (!sourceOfUrl(url)) {
            reject(new Error('Unsupported music link.'));
            return;
        }
        const child = spawn(ytDlpPath(), [
            ...baseArgs(), '-f', 'bestaudio/best', '-o', '-', '--quiet', '--', url
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                if (child.exitCode === null) child.kill('SIGKILL');
                reject(error);
            } else {
                resolve(child);
            }
        };
        const timer = setTimeout(() => finish(new Error('The music source took too long to start.')), timeoutMs);
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        child.stdout.on('error', () => { /* closed when the track is skipped */ });
        child.on('error', (error) => {
            console.error(`[ZiGBoT MUSIC] yt-dlp failed to start: ${error.message}`);
            finish(new Error('Music playback is not installed on this host (yt-dlp missing).'));
        });
        child.stdout.once('readable', () => {
            if (child.stdout.readableLength > 0) finish(null);
        });
        child.on('close', (code, signal) => {
            if (!settled) {
                console.error(`[ZiGBoT MUSIC] yt-dlp stream exited ${code} before audio: ${stderr.trim().slice(0, 500)}`);
                finish(new Error(friendlyError(stderr)));
            } else if (code && !signal && !/Errno 22|Errno 32|Broken pipe/i.test(stderr)) {
                console.error(`[ZiGBoT MUSIC] yt-dlp stream exited ${code} mid-track: ${stderr.trim().slice(0, 500)}`);
                child.failureReason = friendlyError(stderr);
            }
        });
    });
}

/** yt-dlp version string, or null when it cannot run. */
async function ytDlpVersion() {
    try {
        return (await run(['--version'], 15_000)).trim().slice(0, 40) || null;
    } catch {
        return null;
    }
}

module.exports = {
    ytDlpVersion,
    search,
    resolveTrack,
    resolveUrl,
    findAlternative,
    alternativeQueries,
    openStream,
    sourceOfUrl,
    isYouTubeUrl,
    isHostBlocked,
    friendlyError,
    toTrack,
    preferredSource,
    ytDlpInstalled,
    SOURCE_LABEL,
    MAX_DURATION_SECONDS
};
