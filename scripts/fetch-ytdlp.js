/**
 * Downloads the standalone yt-dlp binary for this platform into bin/ so
 * /play can search and stream YouTube. Runs on `npm install` (postinstall),
 * so every Render deploy gets the latest yt-dlp — YouTube changes often and
 * old versions stop working.
 *
 *   node scripts/fetch-ytdlp.js           download if missing
 *   node scripts/fetch-ytdlp.js --force   always re-download (update)
 *
 * Skipped when YTDLP_PATH points at your own binary or YTDLP_SKIP_DOWNLOAD=1.
 * Never fails the install: without yt-dlp only YouTube playback is unavailable.
 */
const fs = require('node:fs');
const path = require('node:path');

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const BIN_DIR = path.join(__dirname, '..', 'bin');

function assetName() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    if (process.platform === 'linux') return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
    return null;
}

async function main() {
    if (process.env.YTDLP_PATH || process.env.YTDLP_SKIP_DOWNLOAD === '1') return;
    const asset = assetName();
    if (!asset) {
        console.warn(`[yt-dlp] No standalone build for ${process.platform}/${process.arch}; set YTDLP_PATH.`);
        return;
    }
    const target = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(target) && !process.argv.includes('--force')) return;

    const response = await fetch(RELEASE + asset);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset}`);
    const data = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const temp = `${target}.download`;
    fs.writeFileSync(temp, data, { mode: 0o755 });
    fs.renameSync(temp, target);
    console.log(`[yt-dlp] Installed ${asset} (${(data.length / 1e6).toFixed(1)} MB) to ${target}`);
}

main().catch((error) => {
    console.warn(`[yt-dlp] Download failed (${error.message}); YouTube playback will be unavailable until it succeeds.`);
});
