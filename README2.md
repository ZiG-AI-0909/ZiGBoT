# ZiGBoT — README 2: YouTube Live Chat Updates (Phase 1)

This document reports **all updates from the YouTube Live Chat integration — Phase 1 only**,
committed in `8da5f5f` on `master`. The main project documentation is unchanged in `README.md`;
Phases 2–4 (greeting replies, moderation commands, roast mode) are planned and will append
their own sections here.

---

## Status at a glance

| Item | State |
|---|---|
| Google OAuth via `googleapis` | ✅ done (auth helper + client factory) |
| Owner channel resolution (`forHandle`) + cache | ✅ done |
| Manual `/watch <videoId>` / `/unwatch` (Discord, owner-only) | ✅ done |
| Auto-detection (uploads-playlist polling, per owner's explicit choice) | ✅ done |
| Read-only live-chat monitor honoring `pollingIntervalMillis` | ✅ done |
| Quota ledger, backoff, never-crash error handling | ✅ done |
| Tests (mocked YouTube clients) | ✅ 18 new, 163/163 pass |
| Greeting auto-replies (Phase 2) | ⏳ planned |
| Streamer moderation commands (Phase 3) | ⏳ planned |
| Roast mode (Phase 4) | ⏳ planned |

---

## New files

| Path | Purpose |
|---|---|
| `scripts/youtube-auth.js` | One-time local OAuth helper. Opens the Google consent page, catches the redirect on `127.0.0.1:5455`, exchanges the code, and prints ONLY the refresh token. The client id/secret are read from env and never printed or logged. Requests scope `https://www.googleapis.com/auth/youtube.force-ssl`. |
| `src/youtube/config.js` | Reads all `YOUTUBE_*` env vars ONCE. Any missing required var disables the whole YouTube unit (the Discord bot starts normally). Only the NAMES of missing vars are ever reported — values are never logged. Also parses the wrapping active-hours window (`HH-HH`). |
| `src/youtube/apiClient.js` | Thin wrapper around `googleapis.youtube()`: lazy client construction, uniform error classification (`QUOTA` / `AUTH` / `TRANSIENT` / `PERMANENT` / `FORBIDDEN`), and a process-wide daily quota ledger that resets at midnight Pacific Time (matching Google's reset). `ytCall()` refuses any API call once the configured budget is exhausted. |
| `src/youtube/ownerChannel.js` | Resolves the owner channel via `channels.list(forHandle)` — called once, result cached in-process. Optional `YOUTUBE_OWNER_CHANNEL_ID` override short-circuits the network call. Also resolves the bot's own channel ID via `channels.list(mine=true)` so Phase 2 can filter its own messages; failure there is non-fatal. |
| `src/youtube/liveDetector.js` | The owner-chosen detection method: polls the owner's **uploads playlist** (`UC…` → `UU…` prefix), then `videos.list(part=snippet,liveStreamingDetails)` to find the item whose `liveBroadcastContent == "live"` AND `liveStreamingDetails.activeLiveChatId` exists. Configurable interval (default 3 min) + optional active-hours window. After 4 consecutive failures it disables itself and logs a loud PROPOSAL of alternatives instead of silently spinning. |
| `src/youtube/chatMonitor.js` | Reads live chat via `liveChatMessages.list`, posts an engagement prompt at startup and every 15 minutes, and honors YouTube's returned polling interval. `src/youtube/chatModeration.js` detects common English/Hindi profanity and mild teasing; the orchestrator applies 5-minute timeouts and playful comebacks. |
| `src/youtube/index.js` | Orchestrator: init gating, single active watcher at a time, `/watch` + `/unwatch` command handling, `/ytstatus` export, auto-detect loop lifecycle, `stopAll()` for shutdown. |
| `test/youtubePhase1.test.js` | 13 mocked tests: env gating, active-hours math, quota ledger + exhaustion refusal, error classification, uploads-playlist detection (live / not-live), chat message emission, quota-exhaustion no-crash, auth-expiry no-crash, transient backoff. |
| `test/youtubeOrchestrator.test.js` | 5 mocked tests: owner-gated `/watch` (non-owner silently ignored), disabled-state refusal, happy-path watch resolving `activeLiveChatId`, refusal when a video has no live chat, idempotent re-watch + `/unwatch`. |

## Modified files

| Path | Change |
|---|---|
| `src/slash.js` | Registers `/watch`, `/unwatch`, `/ytstatus` (all `Administrator` default permission). Adds `runYouTubeInteraction()`: owner-gated with the same `isOwner` logic the rest of the bot uses; every YouTube failure inside it is caught and converted into a friendly reply line — it can never bubble up as a Discord crash. |
| `src/index.js` | On `ClientReady`, initializes YouTube AFTER slash registration. Init failure or missing env vars only log a line and continue; Discord is untouched. Slash `InteractionCreate` routes YouTube commands first, then falls through to the existing intent router. |
| `test/p3.test.js` | Command-count/name assertions updated for the 3 new commands (pre-existing test, kept green). |
| `package.json` | Adds `googleapis` dependency; `npm run check` now syntax-checks all 6 new YouTube files + the auth script. |
| `.env.example` | Full commented block for every new variable (see below). |
| `README.md` | New "YouTube Live Chat (optional)" section: Google Cloud setup, OAuth client, running the auth script, bot-channel-as-moderator manual step, and the 7-day refresh-token expiry warning for consent screens in Testing status. |

---

## Environment variables (all in `.env.example` with comments

| Var | Required | Purpose |
|---|---|---|
| `YOUTUBE_CLIENT_ID` | ✅ (to enable) | Google OAuth client id |
| `YOUTUBE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `YOUTUBE_REFRESH_TOKEN` | ✅ | From `scripts/youtube-auth.js` |
| `YOUTUBE_OWNER_HANDLE` | optional | Default `@YourBoyZiG` |
| `YOUTUBE_OWNER_CHANNEL_ID` | optional | Hard override of the resolved owner channel ID |
| `YOUTUBE_BOT_CHANNEL_ID` | optional | Explicit bot-channel id; when omitted the bot resolves its own via `channels.list(mine=true)` |
| `YOUTUBE_AUTO_DETECT` | optional | Default `true`; `false` = manual `/watch` only |
| `YOUTUBE_DETECT_INTERVAL_MS` | optional | Detection poll interval, default 180000 (min 60000) |
| `YOUTUBE_ACTIVE_HOURS` | optional | `HH-HH` server-local window; wrapping (`22-4`) supported |
| `YOUTUBE_QUOTA_BUDGET` | optional | Daily safety cap in units, default 10000 |

If any of the three required vars is missing, YouTube is disabled and the bot logs
`disabled, missing env vars: …` — it never crashes or blocks Discord startup.

---

## Discord interface (owner only)

- `/watch <videoId>` — force-watch a specific stream's live chat. Resolves
  `activeLiveChatId` via `videos.list` when not already known.
- `/unwatch` — stop watching.
- `/ytstatus` — one-line status: enabled, ownerId, currently-watched video, autoDetect
  on/off, quota used today vs budget.
- Non-owners invoking any of them get a **silent** reply (`null`), so the commands'
  existence is not broadcast — matching the Discord-bot convention for owner-only actions.

---

## Quota findings (official quota calculator, verified this phase)

| Call | Cost | Bucket |
|---|---|---|
| `channels.list` / `videos.list` / `playlistItems.list` / `liveBroadcasts.list` | 1 | shared 10,000/day |
| `liveChatMessages.list` | 5 | shared |
| `liveChatMessages.insert` | 20 | shared |
| `liveChatMessages.delete` | 20 | shared |
| `liveChatBans.insert` (timeout/ban, Phase 3) | 200 | shared |
| `search.list` | 1/call | **own bucket, 100 calls/day** |

**Which account the token comes from matters** (user chose: separate bot channel):
- because the token is NOT the stream owner's, `liveBroadcasts.list(mine=true)` cannot see
  the stream — hence the uploads-playlist polling design above;
- the bot channel must be added as a live-chat moderator of `@YourBoyZiG` (manual step)
  or Phase 3 moderation will be rejected with 403.

**Estimated costs:**
- Chat watching: 5 units/poll at the API's own ~5s→10s pacing → **~1,800–3,600 units/hour
  of streaming**, so ~4,000–9,000 units per 2–3-hour stream — roughly one stream per
  default 10,000-unit day.
- Detection at 3-min intervals: 2 units/poll → ~40 units/hour watching, ~480 units/day idle.
- When the daily budget runs out: the ledger refuses further calls until midnight PT,
  logs clearly, and the Discord bot keeps running normally.

---

## Reliability behavior

- Every YouTube call is classified (`QUOTA`/`AUTH`/`TRANSIENT`/`PERMANENT`/`FORBIDDEN`);
  callers decide policy, never crash.
- Chat watcher: transient → exponential backoff (5s base, 60s cap);
  quota/expired token/forbidden → clean stop with a visible notice;
  offline chat → clean stop + notice.
- Detector: 4 consecutive failures → self-disable + loud logged PROPOSAL of next steps
  (owner-account token for `liveBroadcasts.list(mine=true)`, or manual `/watch` only).
- Any startup failure (bad handle, network down, auth error) leaves `state.enabled=false`
  and the Discord bot fully functional.

---

## Tests

`npm run check` ✅ (18 files syntax-checked)
`npm test` ✅ **163/163 passing** (150 pre-existing + 13 Phase 1 unit tests + 5 orchestrator tests), all with fully mocked YouTube clients — no network access needed.

Key scenarios covered:
- missing `YOUTUBE_*` vars disable the feature without throwing
- active-hours window math (including wrap-around `22-4`)
- quota ledger exhaustion refuses calls before any network I/O, no crash
- quota-exhausted / expired-token / transient-error chat monitoring stops or backs off cleanly
- uploads-playlist detection finds a live stream AND correctly reports none-live
- owner-only `/watch`/`/unwatch` (non-owner silently ignored on both)
- a video with no active live chat is refused with a clear message
- watching the same video twice is idempotent; `/unwatch` when idle says so

---

## Manual steps for the owner (cannot be automated)

1. Google Cloud project → enable **YouTube Data API v3** → OAuth consent screen
   (External) → Web-app OAuth client with redirect
   `http://127.0.0.1:5455/oauth-callback`.
2. Run `node scripts/youtube-auth.js` locally with the **bot channel's** Google account
   (not the owner account) and paste the printed refresh token into `.env`.
3. Publish the OAuth consent screen to **In production** — while it is in **Testing**,
   refresh tokens expire after 7 days and the bot will log
   `auth failure (refresh token expired?)` and pause YouTube until re-auth.
4. During the next live stream, add the bot channel as a live-chat moderator of
   https://www.youtube.com/@YourBoyZiG (participant list → ⋮ → Add moderator).
5. Verify once with `/watch <videoId>` and `/ytstatus` that chat messages flow.

## Open verification item

Whether @YourBoyZiG's uploads playlist actually surfaces a live broadcast while live was
_flagged_ to the user and remains unverified without a real stream. If it does not, the
detector will disable itself after 4 consecutive failures and log a loud PROPOSAL — at
that point the fallback options are (a) re-issue the token from the OWNER account to
unlock `liveBroadcasts.list(mine=true)` at 1 unit/call, or (b) rely on manual `/watch`.
`search.list` is deliberately NOT the default fallback (per the owner's explicit instruction)
