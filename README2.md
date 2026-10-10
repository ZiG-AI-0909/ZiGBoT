# ZiGBoT — README 2: YouTube Live Chat Updates (Phases 1–4 + quota hardening)

This document reports **every update from the YouTube Live Chat integration on `master`**.
The main project documentation lives in `README.md` and is unchanged except for the
"YouTube Live Chat (optional)" setup section.

| Phase | Scope | Commit |
|---|---|---|
| Phase 1 | OAuth, owner resolution, auto-detect, read-only chat watcher | `8da5f5f` |
| Phase 2 | Greeting + direct-mention replies | `1cf6989` |
| Phase 3 | Owner-only moderation commands (`!timeout`, `!ban`, `!unban`, `!delete`) | `e0b609f` |
| Phase 4 | Owner-only roast mode (`!roast`, `!roastmode`, `!noroast`, `!yesroast`) | `a607809` |
| Hardening | Persistent authoritative quota ledger, single-watcher guarantee, poll floor | `49c40e6` |
| Quota recovery | Wait for the Pacific reset instead of disabling, auto-retry, `/ytretry`, threshold logs | `625389f` |

---

## Status at a glance

| Item | State |
|---|---|
| Google OAuth via `googleapis` | ✅ done (auth helper + client factory) |
| Owner channel resolution (`forHandle`) + cache | ✅ done |
| Bot's own channel id (`YOUTUBE_BOT_CHANNEL_ID` first, `mine=true` fallback) | ✅ done |
| Manual `/watch <videoId>` / `/unwatch` (Discord, owner-only) | ✅ done |
| Auto-detection (uploads-playlist polling, per owner's explicit choice) | ✅ done |
| Read-only live-chat monitor honoring `pollingIntervalMillis` | ✅ done |
| Poll floor `YOUTUBE_MIN_POLL_MS` (default 8000) + idle backoff | ✅ done |
| Greeting + direct-mention replies (Phase 2) | ✅ done |
| Owner-only YouTube moderation commands (Phase 3) | ✅ done |
| Roast mode (Phase 4) | ✅ done |
| Persistent, Google-authoritative quota ledger (PT-date keyed) | ✅ done |
| Single chat watcher per live chat id (no duplicate poll loops) | ✅ done |
| Per-method quota usage + 10-minute summary + `/ytstatus` | ✅ done |
| Quota exhaustion = wait for the Pacific reset, then auto-retry (not a permanent disable) | ✅ done |
| Owner-only `/ytretry`, and 50/75/90% usage-threshold logs | ✅ done |
| Tests (mocked YouTube clients) | ✅ **210/210 pass** |
| `search.list` fallback for detection | ❌ deliberately NOT used (owner's explicit instruction) |

---

## Phase 1 — detection and the read-only watcher

| Path | Purpose |
|---|---|
| `scripts/youtube-auth.js` | One-time local OAuth helper. Opens the Google consent page, catches the redirect on `127.0.0.1:5455`, exchanges the code, and prints ONLY the refresh token. Client id/secret come from env and are never printed/logged. Requests scope `https://www.googleapis.com/auth/youtube.force-ssl`. |
| `src/youtube/config.js` | Reads every `YOUTUBE_*` env var ONCE. Any missing required var disables the whole YouTube unit (the Discord bot starts normally). Only the NAMES of missing vars are ever reported — values are never logged. Parses the wrapping active-hours window (`HH-HH`) and exposes `minPollMs`. |
| `src/youtube/apiClient.js` | Thin wrapper around `googleapis.youtube()`: lazy client construction, uniform error classification (`QUOTA` / `AUTH` / `TRANSIENT` / `PERMANENT` / `FORBIDDEN`), and the process-wide quota ledger (see hardening below). `ytCall()` refuses any API call once the budget is exhausted or Google has declared quota exhaustion. |
| `src/youtube/ownerChannel.js` | Resolves the owner channel via `channels.list(forHandle)`, called once and cached in-process. Optional `YOUTUBE_OWNER_CHANNEL_ID` override short-circuits the network call. Also resolves the bot's own channel id — from `YOUTUBE_BOT_CHANNEL_ID` when set, otherwise `channels.list(mine=true)`; failure there is non-fatal. |
| `src/youtube/liveDetector.js` | The owner-chosen detection method: polls the owner's **uploads playlist** (`UC…` → `UU…` prefix) then `videos.list(part=snippet,liveStreamingDetails)` to find an item whose `liveBroadcastContent == "live"` with an `activeLiveChatId`. Configurable interval (default 3 min) + optional active-hours window. After 4 consecutive failures it disables itself and logs a loud PROPOSAL of alternatives instead of silently spinning. Also reports `upcoming` streams with a scheduled-start notice. |
| `src/youtube/chatMonitor.js` | Reads live chat via `liveChatMessages.list`, honors YouTube's returned polling hint subject to the configured floor, backs off on errors and on idle chat, emits messages to the orchestrator, and logs a per-method quota summary every 10 minutes. Legacy engagement prompts exist but are **off by default** (`YOUTUBE_ENGAGEMENT_PROMPTS=false`). |
| `src/youtube/index.js` | Orchestrator: init gating, **one active watcher at a time**, `/watch` + `/unwatch` handling, `/ytstatus` export, auto-detect loop lifecycle, quota-ledger configuration + hydration, `stopAll()` for shutdown. |

## Phase 2 — greeting and mention replies

| Path | Purpose |
|---|---|
| `src/youtube/greetings.js` | Greets first-time chatters and answers direct mentions with short, safe templates (English + Hinglish), enforcing: one greeting per viewer per stream, a max word count, backlog tolerance, a global outgoing send interval, a bounded reply queue, a per-viewer mention cooldown, a per-stream reply cap, and a quota reserve. Greeting history and message dedupe live in `brain` (`ytGreeted`, 24 h TTL) so a restart does not re-greet everyone. Forbidden/auth send errors disable sending for the stream; quota errors pause it; the chat reader keeps running. |
| `src/youtube/chatterCache.js` | In-memory, 30-minute sliding cache of chatters (display name, normalized name, protection flags, recent message ids/texts). Powers `!delete`, target resolution, and roast eligibility/context. |

## Phase 3 — owner-only moderation commands

| Path | Purpose |
|---|---|
| `src/youtube/commands.js` | `YouTubeCommandRouter` parses the configured prefix (`YOUTUBE_COMMAND_PREFIX`, default `!`) and executes owner-only actions: `!timeout`, `!ban` (+ `!confirm` / `!cancel`), `!unban`, `!delete`, plus the roast commands. Enforces a per-stream action cap, a ban/timeout cooldown, and a moderation quota reserve; ban ids are persisted in `brain` (`ytBans`) so they survive restarts, with in-memory fallback. Every attempt is written to the Discord audit log. |
| `src/youtube/chatModeration.js` | Conservative, local-only profanity detection (English + Hindi/Hinglish) for automatic 5-minute timeouts, plus `getPlayfulRoast()` for mild teasing aimed at the streamer/bot. |

## Phase 4 — roast mode

| Path | Purpose |
|---|---|
| `src/youtube/roast.js` | `YouTubeRoast` generates one-line roasts via the shared AI client with a YouTube-specific system prompt. Strict eligibility (owner/mod/self/bot/member-off-limits/no-roast-list/crisis all skipped), output filtering (length, newlines, links, domains, hashtags/mentions, content + profanity filters), per-stream cap, min interval, per-viewer cooldown, AI rate bucket, AI timeout, quota reserve, and an outgoing queue. No-roast opt-outs persist in `brain` (`ytNoRoast`, 24 h TTL). |

## Hardening — persistent authoritative quota ledger and a single watcher (commit `49c40e6`)

This closed the gap that let the daily quota be exhausted within ~1 hour of the Pacific reset.

1. **Google `quotaExceeded` is authoritative.** `ytCall()` tags the error `QUOTA` and calls
   `markQuotaExceeded()`, which sets `quotaExhaustedByGoogle`, records usage at the budget cap,
   logs **once**, and persists the flag. Every later call sees `quotaRemaining() === 0` and is
   refused *before* any network I/O, until the next midnight Pacific — at which point
   `resetForDay()` clears it. Errors are tagged, never thrown raw into the Discord path.
2. **Persistent ledger in MongoDB** (`brain.js`, `ytQuota` collection): keyed by the
   `America/Los_Angeles` calendar date (unique index + 3-day TTL). `getYtQuotaLedger` /
   `recordYtQuotaCall` (`$inc` usedUnits and per-method calls/units) / `markYtQuotaExhausted`.
   `hydrateQuotaLedger()` restores it at startup, so restarts and overlapping deploys do not
   reset accounting. Any Mongo failure logs once and keeps in-memory accounting.
3. **Per-method counting + 10-minute summary + `/ytstatus`.** Every `ytCall` records `method`,
   calls, and units. The watcher emits a one-line `YouTube quota summary (last 10m): …` notice
   every 10 minutes, and `getYouTubeStatus().quotaMethods` is rendered in `/ytstatus`.
4. **Exactly one watcher per live chat id.** `watch()` is serialized through a promise tail and
   dedupes on `watcherLiveChatId`, so an auto-detect `onLive` and a manual `/watch` cannot
   install two poll loops. `stopWatcher()` (and re-init) always calls `stop()` on the old loop.
   *This fixed a real duplicate-polling bug:* previously, two concurrent `watch()` calls sharing
   a live chat id could each install a monitor, and `state.watcher` only tracked the last one —
   the orphaned loop kept polling forever (~doubling `liveChatMessages.list` cost).
5. **Poll floor + idle backoff.** `YOUTUBE_MIN_POLL_MS` (default 8000) overrides a shorter
   `pollingIntervalMillis`; `pollIntervalMs = max(apiHint, minPollMs, idleInterval)`. After 3
   idle minutes the interval grows (up to a 60 s cap). It never polls faster than the API's hint.
6. **Bot channel id precedence.** `YOUTUBE_BOT_CHANNEL_ID` is used first; `channels.list(mine=true)`
   is only called when it is unset.
7. **Tests** for each of the above (see Tests below).

### Quota recovery — the unit survives the reset (commit `625389f`)

Google's quota window resets at **midnight Pacific**, but the bot used to disable YouTube for the
life of the process the moment init or a poll hit a quota error. It now treats quota as temporary:

8. **Quota failures pause, they do not disable.** `initYouTube()` treats an exhausted/hydrated
   ledger and any `QUOTA`-classified init error as a *waiting for quota reset* state: calls stop,
   `state.enabled` goes false, and the Discord bot keeps running normally. Only `AUTH` / `FORBIDDEN`
   /missing-credentials failures still disable YouTube permanently, and those never retry in a loop.
9. **One scheduled re-init just after the reset.** A single timer is armed for the next midnight
   Pacific **+ 2 minutes + up to 60 s of jitter** (`nextQuotaResetAt()`), so overlapping restarts and
   deploys do not all fire at the same instant. The timer is `unref()`ed (the Discord client keeps the
   process alive, not the retry) and only one retry can ever be pending, so quota-error bursts cannot
   stack timers. On success the new PT date is hydrated (fresh row = zero usage) and auto-detection
   resumes; each retry reuses the original init config and injected dependencies.
10. **Mid-stream exhaustion uses the same path.** `chatMonitor` reports a `QUOTA` poll failure through
    `onQuotaExhausted`, which stops the poll loop and schedules the reset retry; the auto-detect loop
    pauses the same way. `/ytstatus` now shows `quota state: waiting for quota reset (retry <ISO time>)`.
11. **Owner-only `/ytretry`.** Re-runs initialization on demand (same `isOwner` gate and silent
    non-owner ignore as every other YouTube command); if the quota is still spent it reports the next
    automatic retry time instead of failing.
12. **Usage-threshold logging.** `recordQuota()` logs one line with per-method calls/units when the
    ledger crosses **50%, 75% and 90%** of the budget (once each per PT day), and a `quotaExceeded`
    jump reports the crossed thresholds together — so the method responsible is visible in the logs.
13. **Guards unchanged.** Reserves, per-stream caps, the single-watcher rule, the poll floor, idle
    backoff and the persistent ledger all behave exactly as before; the recovery path only adds a
    scheduled re-init.

---

## New files (all phases)

| Path | Purpose |
|---|---|
| `scripts/youtube-auth.js` | Local OAuth helper (prints refresh token only). |
| `src/youtube/config.js` | Env parsing + active-hours math + `minPollMs`. |
| `src/youtube/apiClient.js` | Error classification + quota ledger + client factory. |
| `src/youtube/ownerChannel.js` | Owner channel resolve/cache + self channel resolve. |
| `src/youtube/liveDetector.js` | Uploads-playlist live detection loop. |
| `src/youtube/chatMonitor.js` | Live-chat poll loop, backoff, quota summary. |
| `src/youtube/greetings.js` | Greeting/mention reply engine with paced queue. |
| `src/youtube/chatterCache.js` | Sliding chatter cache + name normalization. |
| `src/youtube/commands.js` | Owner-only moderation + roast command router. |
| `src/youtube/chatModeration.js` | Local profanity detection + playful comebacks. |
| `src/youtube/roast.js` | AI roast engine with strict eligibility/filters. |
| `src/youtube/index.js` | Orchestrator (single watcher, lifecycle, status). |
| `test/youtubePhase1.test.js` | 20 tests: env gating, active hours, quota ledger/exhaustion/hydration, 50/75/90% threshold logs, `nextQuotaResetAt()`, error classification, detection, monitor stop/backoff/`onQuotaExhausted`, poll floor + idle backoff + method summary. |
| `test/youtubeOrchestrator.test.js` | 13 tests: owner gating, disabled refusal, happy path, no-live-chat refusal, idempotent re-watch/unwatch, concurrent single-watcher, `/ytstatus` method usage + wait state, quota init failure schedules a retry, retry re-enables after the reset, non-quota failure never retries, mid-stream exhaustion, `/ytretry` owner-only. |
| `test/youtubeGreetings.test.js` | 8 tests: greeting matching, dedupe/backlog/own/owner/mod/bot/command exclusions, mention cooldown, global send interval, queue overflow, cap/quota/forbidden behavior. |
| `test/youtubeCommands.test.js` | 22 tests: target parsing, owner-only gating, timeout/ban/confirm/cancel/unban/delete, reserves, audit, persistence wiring, roast command gating. |

## Modified files

| Path | Change |
|---|---|
| `src/slash.js` | Registers `/watch`, `/unwatch`, `/ytstatus`, `/ytgreet`, `/ytmod`, `/ytroast`, `/ytretry` (all `Administrator` default permission). `runYouTubeInteraction()` is owner-gated with the same `isOwner` logic as the bot; every YouTube failure is caught and converted to a friendly reply. `/ytstatus` now includes per-method quota usage and the quota wait state + retry time. |
| `src/index.js` | On `ClientReady`, initializes YouTube after slash registration; init failure or missing env vars only log and continue, and a quota-spent start logs the scheduled retry instead of pretending YouTube is dead. Slash `InteractionCreate` routes YouTube commands first, then the normal intent router. |
| `src/db/brain.js` | Adds `ytGreeted`, `ytBans`, `ytNoRoast`, and `ytQuota` collections with unique + TTL indexes and CRUD helpers. Only `brain.js` talks to Mongo. |
| `package.json` | Adds `googleapis`; `npm run check` syntax-checks all YouTube modules + the auth script. |
| `.env.example` | Full commented block for every YouTube variable (see below). |
| `README.md` | New "YouTube Live Chat (optional)" section: Google Cloud setup, OAuth client, auth script, bot-as-moderator step, and the 7-day refresh-token warning for consent screens in Testing status. |

---

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `YOUTUBE_CLIENT_ID` | ✅ (to enable) | — | Google OAuth client id |
| `YOUTUBE_CLIENT_SECRET` | ✅ | — | Google OAuth client secret |
| `YOUTUBE_REFRESH_TOKEN` | ✅ | — | From `scripts/youtube-auth.js` |
| `YOUTUBE_OWNER_HANDLE` | optional | `@YourBoyZiG` | Owner channel handle for `channels.list(forHandle)` |
| `YOUTUBE_OWNER_CHANNEL_ID` | optional | — | Hard override of the resolved owner channel id |
| `YOUTUBE_BOT_CHANNEL_ID` | optional | — | Bot's own channel id; when omitted resolved via `mine=true` |
| `YOUTUBE_AUTO_DETECT` | optional | `true` | Uploads-playlist detection on/off |
| `YOUTUBE_DETECT_INTERVAL_MS` | optional | `180000` | Detection poll interval (min 60000) |
| `YOUTUBE_MIN_POLL_MS` | optional | `8000` | Hard floor for live-chat polling, overrides shorter API hints |
| `YOUTUBE_DISCORD_CHANNEL_ID` | optional | built-in | Channel for live/scheduled notices |
| `YOUTUBE_DISCORD_ROLE_ID` | optional | built-in | Role pinged on live/scheduled notices |
| `YOUTUBE_ACTIVE_HOURS` | optional | — | `HH-HH` server-local window; wrapping (`22-4`) supported |
| `YOUTUBE_QUOTA_BUDGET` | optional | `10000` | Daily safety cap in units |
| `YOUTUBE_ALLOW_MANUAL_WATCH` | optional | `true` | Allow manual `/watch` regardless of auto-detect |
| `YOUTUBE_GREETINGS` | optional | `true` | Enable greeting/mention replies |
| `YOUTUBE_ENGAGEMENT_PROMPTS` | optional | `false` | Legacy periodic engagement prompts |
| `YOUTUBE_IGNORE_CHANNEL_IDS` | optional | — | Comma-separated channel ids greetings must ignore |
| `YOUTUBE_BOT_NAME` | optional | `ZiGBoT` | Fallback display name for mention matching |
| `YOUTUBE_QUOTA_RESERVE` | optional | `2500` | Units kept unused for other calls |
| `YOUTUBE_MAX_REPLIES_PER_STREAM` | optional | `60` | Greeting/mention reply cap per stream |
| `YOUTUBE_GREETING_MAX_WORDS` | optional | `6` | Max normalized words for a greeting |
| `YOUTUBE_BACKLOG_TOLERANCE_MS` | optional | `3000` | Ignore messages older than watcher start minus this |
| `YOUTUBE_REPLY_INTERVAL_MS` | optional | `5000` | Minimum gap between outgoing replies |
| `YOUTUBE_REPLY_QUEUE_MAX` | optional | `10` | Max waiting/in-flight replies before drops |
| `YOUTUBE_MENTION_COOLDOWN_MS` | optional | `60000` | Per-viewer direct-mention cooldown |
| `YOUTUBE_MODERATION` | optional | `true` | Enable owner-only moderation commands |
| `YOUTUBE_COMMAND_PREFIX` | optional | `!` | Live-chat command prefix |
| `YOUTUBE_MOD_QUOTA_RESERVE` | optional | `400` | Quota kept for moderation actions |
| `YOUTUBE_MAX_MOD_ACTIONS_PER_STREAM` | optional | `25` | Moderation action cap per stream |
| `YOUTUBE_MOD_ACTION_COOLDOWN_MS` | optional | `2000` | Min spacing between ban/timeout actions |
| `YOUTUBE_ROAST` | optional | `true` | Enable owner-only roast commands (mode still starts OFF) |
| `YOUTUBE_ROAST_MEMBERS` | optional | `false` | Allow roasts of paying members |
| `YOUTUBE_MAX_ROASTS_PER_STREAM` | optional | `25` | Successful roast cap per stream |
| `YOUTUBE_ROAST_INTERVAL_MS` | optional | `10000` | Min delay between generated roasts |
| `YOUTUBE_ROAST_VIEWER_COOLDOWN_MS` | optional | `120000` | Per-viewer roast cooldown |
| `YOUTUBE_ROAST_AI_TIMEOUT_MS` | optional | `8000` | AI request timeout for roasts |
| `YOUTUBE_ROAST_AI_RATE_LIMIT_MAX` | optional | `2` | YouTube-only AI calls per window |
| `YOUTUBE_ROAST_AI_RATE_LIMIT_WINDOW_MS` | optional | `60000` | YouTube-only AI rate window |

If any of the three required vars is missing, YouTube is disabled and the bot logs
`disabled, missing env vars: …` — it never crashes or blocks Discord startup.

---

## Interfaces

### Discord (owner only, `Administrator` default permission)
- `/watch <videoId>` — force-watch a stream's live chat; resolves `activeLiveChatId` via
  `videos.list` when unknown.
- `/unwatch` — stop watching.
- `/ytstatus` — one-line status: enabled, **quota state (ok, or `waiting for quota reset` + retry
  time)**, ownerId, selfId, watching, autoDetect, quota used/budget/remaining, **per-method quota
  usage**, greetings, replies sent, moderation state/actions, roast mode/roasts/AI calls.
- `/ytgreet on|off`, `/ytmod on|off`, `/ytroast on|off|status`.
- `/ytretry` — re-run YouTube initialization immediately (used after a quota reset or an env fix).

Non-owners invoking any of them get a **silent** reply (`null`), so the commands'
existence is not broadcast.

### YouTube live chat (verified stream owner only)
The author must match `ownerId` **and** have `isChatOwner === true`; everything else is
audit-logged as `DENIED`. Prefix is `YOUTUBE_COMMAND_PREFIX` (default `!`).
- `!timeout <target> [minutes] [reason]` — temporary ban (1–1440 min).
- `!ban <target> [reason]` → `!confirm` / `!cancel` (30 s confirmation window).
- `!unban <target> [reason]` — only for bans the bot created (persisted ban id).
- `!delete <target> [count]` — deletes up to 10 recent cached messages.
- `!roast <target>`, `!roastmode on|off`, `!noroast <target>`, `!yesroast <target>`.

---

## Quota findings (official quota calculator)

| Call | Cost | Bucket |
|---|---|---|
| `channels.list` / `videos.list` / `playlistItems.list` / `liveBroadcasts.list` | 1 | shared 10,000/day |
| `liveChatMessages.list` | 5 | shared |
| `liveChatMessages.insert` (greeting / mention / roast / reply) | 20 | shared |
| `liveChatMessages.delete` | 20 | shared |
| `liveChatBans.insert` / `liveChatBans.delete` (timeout/ban/unban) | 200 | shared |
| `search.list` | 1/call | **own bucket, 100 calls/day** |

**Which account the token comes from matters** (user chose a separate bot channel):
- because the token is not the stream owner's, `liveBroadcasts.list(mine=true)` cannot see
  the stream — hence the uploads-playlist polling design;
- the bot channel must be added as a live-chat moderator of `@YourBoyZiG` (manual step) or
  moderation commands and outgoing sends will be rejected with 403.

**Estimated costs after the hardening:**
- Chat watching: `liveChatMessages.list` at the 8 s floor = 5 × (3600/8) =
  **~2,250 units/hour** worst case (chat never idle). Idle backoff drops this to
  ~1,125 u/hr at 16 s, ~750 u/hr at 24 s, and **~300 u/hr** at the 60 s cap.
- Detection at 3-min intervals: 2 units/poll → **~40 units/hour** while watching,
  ~480 units/day idle.
- Outgoing inserts add 20 units each and are bounded by the reply cap / roast cap and the
  quota reserves.
- **Combined maximum while live + auto-detecting: ~2,290 units/hour**, versus ~3,600 u/hr
  before the floor and up to ~7,200 u/hr with the old duplicate-polling bug.
- When the budget runs out (or Google declares `quotaExceeded`): the ledger refuses further calls
  until midnight Pacific, logs once, and the Discord bot keeps running normally. YouTube itself is
  **not** disabled — `/ytstatus` reports `waiting for quota reset`, and one init retry is scheduled
  for midnight Pacific + 2 min (+ jitter), which hydrates the new PT day at zero and resumes
  auto-detect. `/ytretry` does the same thing on demand.

---

## Reliability behavior

- Every YouTube call is classified (`QUOTA`/`AUTH`/`TRANSIENT`/`PERMANENT`/`FORBIDDEN`);
  callers decide policy, never crash.
- Chat watcher: transient → exponential backoff (8 s base, 60 s cap); idle → stepwise
  backoff to 60 s; quota/expired token/forbidden → clean stop with a visible notice;
  offline chat → clean stop + notice.
- Duplicate protection: `watch()` is serialized and dedupes on live chat id, so auto-detect
  and `/watch` can never run two poll loops; `stopWatcher()` always stops the old loop.
- Quota ledger: Google `quotaExceeded` is authoritative until the PT reset; usage is
  persisted per PT date in MongoDB with in-memory fallback if Mongo is unavailable. Crossing
  50/75/90% of the budget logs a per-method usage line.
- Quota recovery: init, a mid-stream poll, or the auto-detect loop hitting the quota pauses
  YouTube and arms exactly one retry at midnight Pacific + 2 min (jitter up to 60 s). The retry
  re-runs init, hydrates the new PT date at zero, and resumes auto-detect. Auth/forbidden errors
  stay permanent (no retry loop).
- Detector: 4 consecutive failures → self-disable + loud logged PROPOSAL of next steps
  (owner-account token for `liveBroadcasts.list(mine=true)`, or manual `/watch` only).
- Any startup failure (bad handle, network down, auth error) leaves `state.enabled=false`
  and the Discord bot fully functional. A quota-spent startup leaves the same state *plus* the
  scheduled reset retry, so the unit comes back on its own.

---

## Tests

`npm run check` ✅ (all modules syntax-checked)
`npm test` ✅ **210/210 passing**, all with fully mocked YouTube clients — no network access needed.

YouTube-focused suites:
- `test/youtubePhase1.test.js` — 20 tests
- `test/youtubeOrchestrator.test.js` — 13 tests
- `test/youtubeGreetings.test.js` — 8 tests
- `test/youtubeCommands.test.js` — 22 tests
- `test/p3.test.js` — includes the `ytQuota` persistence test (unique + TTL indexes)

Key scenarios covered:
- missing `YOUTUBE_*` vars disable the feature without throwing
- active-hours window math (including wrap-around `22-4`)
- quota ledger tracks usage, resets on PT-day rollover, refuses calls before network I/O
- Google `quotaExceeded` marks the PT day exhausted, persists it, and blocks later calls;
  a restart hydrates the persisted exhausted day
- per-method quota counts, the 10-minute summary, and `/ytstatus` exposure
- per-method usage logged once at 50%, 75% and 90% of the budget
- `nextQuotaResetAt()` lands on the next midnight Pacific plus margin/jitter
- an exhausted ledger at startup pauses YouTube and schedules exactly one retry
- the retry after the reset hydrates the new PT day at zero and resumes auto-detect
- a non-quota init failure (bad token) still disables YouTube and schedules no retry
- mid-stream quota exhaustion stops the watcher and schedules the reset retry
- `/ytretry` is registered and owner-only
- configured `YOUTUBE_BOT_CHANNEL_ID` skips `channels.list(mine=true)`
- chat poll floor overrides a short API hint; idle chat backs off further
- concurrent auto/manual watch requests sharing a live chat id install exactly one watcher;
  switching stops the old loop
- quota-exhausted / expired-token / transient-error chat monitoring stops or backs off cleanly
- uploads-playlist detection finds a live stream and correctly reports none-live
- greeting matching, dedupe, backlog/own/owner/mod/bot/command exclusions, cooldowns, caps
- owner-only `/watch`/`/unwatch`/moderation (non-owner silently ignored)
- a video with no active live chat is refused with a clear message

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

Whether `@YourBoyZiG`'s uploads playlist actually surfaces a live broadcast while live was
_flagged_ to the user and remains unverified without a real stream. If it does not, the
detector will disable itself after 4 consecutive failures and log a loud PROPOSAL — at that
point the fallback options are (a) re-issue the token from the OWNER account to unlock
`liveBroadcasts.list(mine=true)` at 1 unit/call, or (b) rely on manual `/watch`.
`search.list` is deliberately NOT the default fallback (per the owner's explicit instruction).
