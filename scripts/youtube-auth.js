/**
 * One-time local helper: run `node scripts/youtube-auth.js` ON YOUR MACHINE,
 * never on the server. It opens the Google consent page, spins up a temporary
 * local HTTP server to catch the redirect, exchanges the authorization code
 * for a token set, and prints ONLY the refresh token (the client id/secret
 * are read from env and never logged). You then paste the refresh token into
 * YOUTUBE_REFRESH_TOKEN.
 *
 * OAuth consent screen in "Testing" status: the refresh token EXPIRES after
 * 7 days unless the client is moved to "In production". The bot detects the
 * resulting invalid_grant error at startup and asks for a re-run.
 *
 * Prerequisites (README, "Google Cloud setup"):
 *   1. Google Cloud project, enable "YouTube Data API v3".
 *   2. OAuth consent screen: External, add the owner Google account as a test user.
 *   3. OAuth client ID of type "Web application" with redirect URI
 *      http://127.0.0.1:5455/oauth-callback (matches REDIRECT_PORT below).
 *   4. Env vars before running: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET.
 *
 * Scope requested: https://www.googleapis.com/auth/youtube.force-ssl
 * (required for live chat read + moderation and works with playlists.list,
 * videos.list, channels.list used for detection).
 */
require('dotenv').config();

const http = require('http');
const { google } = require('googleapis');
const { URL } = require('url');

const REDIRECT_PORT = 5455; // must match the OAuth client redirect URI
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth-callback`;
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
    console.error('Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET. Set them in .env and re-run.');
    process.exit(1);
}

function logWithTime(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

const oauthClient = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const consentUrl = oauthClient.generateAuthUrl({
    access_type: 'offline',            // a refresh token is only issued on consent
    prompt: 'consent',                 // guarantee a NEW refresh token every run
    scope: [SCOPE]
});

const server = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith('/oauth-callback')) {
        res.writeHead(404).end();
        return;
    }
    try {
        const params = new URL(req.url, REDIRECT_URI).searchParams;
        const code = params.get('code');
        const error = params.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family: system-ui;"><h2>You can close this tab now.</h2></body></html>');

        server.close(() => logWithTime('Callback received, closing local server.'));

        if (error) {
            logWithTime(`Consent screen returned error: ${error}`);
            process.exit(1);
        }
        if (!code) {
            logWithTime('Callback reachable but no code param found.');
            process.exit(1);
        }

        (async () => {
            try {
                const { tokens } = await oauthClient.getToken(code);
                if (!tokens.refresh_token) {
                    console.error('No refresh token in response. Re-run the helper with "consent" forced (already forced).');
                    process.exit(1);
                }
                logWithTime('=== PASTE THIS INTO .env AS YOUTUBE_REFRESH_TOKEN ===');
                console.log(tokens.refresh_token);
                logWithTime('=== copy only the line above ===');
                logWithTime('Reminder: a refresh token from a consent screen still in "Testing" status expires after 7 days.');
            } catch (tokenError) {
                logWithTime(`Token exchange failed: ${tokenError?.stack || tokenError}`);
                process.exit(1);
            }
        })();
    } catch (parseError) {
        logWithTime(`Failed to parse callback URL: ${parseError?.stack || parseError}`);
        process.exit(1);
    }
});

server.listen(REDIRECT_PORT, '127.0.0.1', () => {
    logWithTime(`Local redirect target: ${REDIRECT_URI}`);
    logWithTime('Opening consent URL (close this tab after approving)...');
    console.log(consentUrl);
    try {
        // start is optional for url strings; wrapped so headless environments still print the URL.
        require('child_process').exec(`start "" "${consentUrl}"`, () => {});
    } catch {
        // Linux/macOS: no start command — print the URL; the user opens it.
    }
});

logWithTime('Waiting for the OAuth redirect on 127.0.0.1:5455 ...');
