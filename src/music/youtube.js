/**
 * YouTube search + audio streaming through the yt-dlp binary (installed into
 * bin/ by scripts/fetch-ytdlp.js, or YTDLP_PATH). yt-dlp is run with argument
 * arrays (never a shell) and the user's text only ever reaches it as a
 * "ytsearch1:" query or a validated youtube.com / youtu.be URL after "--",
 * so it can never be read as a yt-dlp option.
 *
 * YTDLP_COOKIES_FILE (optional): a Netscape cookies.txt from a YouTube login,
 * for hosts whose IPs YouTube asks to "sign in to confirm you're not a bot".
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RESOLVE_TIMEOUT_MS = 30_000;
const MAX_DURATION_SECONDS = 3 * 60 * 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOST = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)$/i;

function ytDlpPath() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    const local = path.join(__dirname, '..', '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    return fs.existsSync(local) ? local : 'yt-dlp';
}

// yt-dlp writes cookies back on exit, and Render secret files are read-only:
// work from a private temp copy.
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

function isYouTubeUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && YOUTUBE_HOST.test(url.hostname);
    } catch {
        return false;
    }
}

// yt-dlp's own errors are long; keep the one line that explains the problem.
function friendlyError(stderr) {
    const line = String(stderr || '').split(/\r?\n/).find((l) => l.startsWith('ERROR:')) || '';
    if (/sign in to confirm|not a bot/i.test(line)) {
        return 'YouTube is blocking this server right now (bot check). Try again later.';
    }
    if (/private video|video unavailable|removed|copyright|age/i.test(line)) {
        return 'That video is unavailable (private, removed, or age-restricted).';
    }
    return 'Could not load that from YouTube. Try another song or link.';
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
            reject(new Error('YouTube took too long to answer. Try again.'));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => {
            clearTimeout(timer);
            console.error(`[ZiGBoT MUSIC] yt-dlp failed to start: ${error.message}`);
            reject(new Error('YouTube playback is not installed on this host (yt-dlp missing).'));
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

/** Song name or YouTube link -> { source, url, title, duration }. */
async function resolveTrack(query) {
    const input = String(query || '').trim();
    const searching = !isYouTubeUrl(input);
    const args = [
        ...baseArgs(),
        ...(searching ? ['--flat-playlist'] : []),
        '--skip-download',
        '--print', '%(.{id,title,duration,live_status})j',
        '--', searching ? `ytsearch1:${input}` : input
    ];
    const output = await run(args, RESOLVE_TIMEOUT_MS);
    let info;
    try {
        info = JSON.parse(output.trim().split(/\r?\n/)[0]);
    } catch {
        throw new Error(searching ? `No YouTube results for "${input.slice(0, 80)}".` : 'Could not read that YouTube link.');
    }
    if (!VIDEO_ID.test(String(info?.id || ''))) throw new Error(`No YouTube results for "${input.slice(0, 80)}".`);
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
        throw new Error('Live streams are not supported. Pick a regular video.');
    }
    const duration = Number(info.duration) || null;
    if (duration && duration > MAX_DURATION_SECONDS) throw new Error('That video is longer than 3 hours.');
    return {
        source: 'youtube',
        url: `https://www.youtube.com/watch?v=${info.id}`,
        title: String(info.title || 'Unknown title').slice(0, 200),
        duration
    };
}

/**
 * Spawn yt-dlp writing the track's best audio to stdout. Caller owns the
 * process. onFail(message) fires when yt-dlp itself fails (not when we stop
 * it early, which shows up as a broken pipe).
 */
function streamAudio(url, { onFail } = {}) {
    if (!isYouTubeUrl(url)) throw new Error('Not a YouTube URL.');
    const child = spawn(ytDlpPath(), [
        ...baseArgs(), '-f', 'bestaudio/best', '-o', '-', '--quiet', '--', url
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => {
        console.error(`[ZiGBoT MUSIC] yt-dlp failed to start: ${error.message}`);
        onFail?.('YouTube playback is not installed on this host (yt-dlp missing).');
    });
    child.on('close', (code, signal) => {
        if (!code || signal || /Errno 22|Errno 32|Broken pipe/i.test(stderr)) return;
        console.error(`[ZiGBoT MUSIC] yt-dlp stream exited ${code}: ${stderr.trim().slice(0, 500)}`);
        onFail?.(friendlyError(stderr));
    });
    return child;
}

module.exports = { resolveTrack, streamAudio, isYouTubeUrl, friendlyError, MAX_DURATION_SECONDS };
