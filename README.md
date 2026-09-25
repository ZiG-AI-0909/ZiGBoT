# ZiGBoT — Complete Project Documentation

**ZiGBoT** (v1.0.0) is a witty, stress-relieving Discord chat companion and auto-reply bot. It mingles with server members, lightens the mood with dry Gen-Z / Hinglish humor, and offers fun conversation to de-stress. Built on **Node.js** with **discord.js** and LLM integrations (**NVIDIA NIM** / OpenAI-compatible APIs).

- **Personality:** Savage roast mode by default; gentle/wholesome mode for members with specific roles; JARVIS-like respect for the verified server owner.
- **Creator:** Bhavesh Kumar Tiwari (ZiG) — https://portfolio-eight-neon-70.vercel.app/

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (CommonJS), entry: `index.js` → `src/index.js` |
| Discord | `discord.js` v14.27, `@discordjs/voice` v0.19, `@discordjs/opus` (codec), `prism-media`, `ffmpeg-static` |
| AI | `openai` SDK v7.5 pointed at `https://integrate.api.nvidia.com/v1`, default model `openai/gpt-oss-20b` |
| Config | `dotenv` (`.env`), validated in `src/config/settings.js` |
| Persistence | `mongodb` (official Node.js driver) via MongoDB Atlas — warns survive restarts; all collections in `src/db/brain.js` |
| Tests | Node's built-in `node:test` runner (`npm test`), syntax checks via `npm run check` |

---

## 2. File Structure

```
index.js                      # 1-line launcher → src/index.js
src/
  index.js                    # Discord client, MessageCreate + InteractionCreate handlers,
                              #   intent dispatch (runIntent), voice transcript handling
  slash.js                    # Slash commands (/play /kick /ban /help): definitions,
                              #   registration, interaction → intent conversion
  config/settings.js          # Env parsing/validation, role name defaults, GUILD_CONFIG parsing
  ai/
    client.js                 # OpenAI client, savage/gentle system prompts, creator FAQ,
                              #   intent classifier (JSON schema), crisis gate, moderation filter
    memory.js                 # Per-channel sliding conversation memory (8 msgs / 15 min TTL,
                              #   sweeps inactive channels)
    rateLimiter.js            # Per-user sliding-window AI quota limiter
    triggerDetector.js        # Stress/fun keyword regexes (English + Hinglish) + cooldown tracker
    roleDetector.js           # Role normalization (Unicode-safe), gentle/gender/non-gentle detection
  routing/
    voiceRoute.js             # Deterministic voice-transcript → intent routing;
                              #   destructive/admin actions blocked from voice
  security/
    authorization.js          # Owner checks (config ID must match actual guild owner), bot permission checks
    confirmation.js           # Destructive-action Confirm/Cancel buttons (45s expiry, audited)
    ownerCommands.js          # Owner-only "roast him/her/them" targeting
  logging/auditLog.js         # Console + optional LOG_CHANNEL_ID audit entries
  tools/router.js             # ~30 admin/info/voice/music/warn intents with auth gates,
                              #   action catalog (permissions + descriptions), destructive set
  db/
    brain.js                  # MongoDB Atlas connection (native driver), users/warnings
                              #   collections, async warn store (all queries live here)
  voice/
    voiceManager.js           # Join/leave voice, permission checks, reconnect retry logic
    localSpeech.js            # External STT/TTS executables ({input}/{output}/{text} templates)
    voiceConversation.js      # Opus capture → WAV → STT → transcript callback; TTS playback
  music/player.js             # Per-guild queue, HTTPS-only sources, ffmpeg → PCM playback, volume/loop
test/                         # music, authorization, autoReply, router, p3 suites (node --test)
```

---

## 3. Features

### 💬 Funny & Stress-Relief Auto-Reply
- **Direct Mentions & Message Replies**: Responds when pinged (`@ZiGBoT`) or when a user directly replies to one of ZiGBoT's messages.
- **Dedicated Chat Channels**: Auto-replies to all messages in channels configured in `CHAT_CHANNEL_IDS`.
- **Stress & Mingle Triggers**: Detects *stressed*, *exhausted*, *burnt out*, *deadlines*, or requests for *jokes/roasts/cheering up* — in English and Hinglish.
- **Anti-Spam Rate Limiting**: Per-channel **and** per-user cooldowns (`COOLDOWN_SECONDS`, default 15s) for keyword triggers, **plus** a separate per-user AI quota limiter (8 req/min by default) on every LLM call.
- **Sliding Multi-Turn Memory**: Keeps the last 8 messages per channel for 15 minutes; inactive channels are swept so nothing leaks.

### 🎭 Role-Based Personas
- **Savage mode** (default): dark humor, Gen-Z slang, English-Hinglish mix, Samay Raina-style roasts.
- **Gentle mode**: warm, wholesome, gender-neutral by default — for members with gentle roles (`she/her`, `gentleman`, `king`, `soft boy`, `queen`, … including fullwidth Unicode variants like `ｓｈｅ ﹒ ｈｅｒ`).
- **Owner mode**: verified server owner gets a respectful "Sir"/JARVIS tone — unless they hold the `Users.heer` role, which forces roast mode.
- **Gender pronouns** are only used when a member holds explicit `he/him` or `she/her` roles.
- **Creator FAQ**: "Who created you? / Why did ZiG make you? / How was this bot built?" are answered locally (no LLM call) with creator attribution.

### 🛡️ Security & Administration
- Text **and slash** entry points into the same permission-gated tool router.
- Owner-authorized tools for role/channel management and moderation; per-guild owner/admin-role support.
- Bot permission and role-hierarchy checks before every admin action.
- Interactive Confirm/Cancel buttons for every destructive action (45s expiry).
- Audit logging to console and optional `LOG_CHANNEL_ID`.
- Crisis-language override with helpline resources; post-generation moderation on every LLM reply.

### 🔊 Voice & Music
- Optional push-to-talk voice capture with local Whisper/Piper STT/TTS executables.
- Voice commands route deterministically; destructive/admin phrasing is redirected to text channels.
- Automatic voice reconnect with capped exponential backoff.
- HTTPS-only direct-audio music queue with playback controls, volume, and loop.

---

## 4. Message Flow (`src/index.js`)

1. **Intents:** Guilds, GuildMembers, GuildMessages, MessageContent, GuildVoiceStates.
2. Ignores bots. Determines reply eligibility:
   - Direct mention `@ZiGBoT` (with/without `!`)
   - Reply to one of ZiGBoT's messages (fetched via `message.reference`)
   - Message in a configured `CHAT_CHANNEL_IDS` channel
   - `RESPOND_TO_ALL_MESSAGES=true`
   - Keyword trigger (`AUTO_REPLY_KEYWORDS=true`) — stress or fun regex match, gated by cooldowns
3. **Persona selection:**
   - Owner (verified: author ID **and** `guild.ownerId` match `SERVER_OWNER_ID`) → respectful tone, unless `Users.heer` role → roast mode.
   - Non-owner with gentle roles → gentle mode. Everyone else → savage mode.
4. **Bare mention** (no text): canned greeting per persona.
5. **Owner roast command:** owner says "roast him/her/them" + mentions a user → targeted savage roast of that user only.
6. **Crisis gate:** self-harm/crisis language overrides everything → sincere support with helplines (see §5).
7. **Intent classification** (temperature-0 LLM call) → tool action or `chat`.
8. **Dispatch** via `runIntent()` (see §5) → confirmation UI, tool execution, or fall-through.
9. **Chat path:** typing indicator → `ai.reply()` (system prompt + channel history) → moderation check → reply → stored in memory.
10. On AI failure: diagnostics logged, bot replies **"I am dead"**; on rate limit: friendly retry message.

---

## 5. Intent Routing & Safety Pipeline

Every eligible message (and every voice transcript) flows through this pipeline:

1. **Crisis gate** (`isCrisisMessage`): broad English + Hinglish self-harm/crisis patterns override everything — no tool routing, no persona, immediate sincere support with helpline numbers (Tele-MANAS 14416, Kiran 1800-599-0019, US 988). Deliberately tuned so hyperbole ("this deadline is killing me", "I'm dead laughing") stays roast while "I want to die", "marna chahta hun", "kill myself" can never reach the savage persona — and can't be bypassed by phrasing.
2. **Intent classification** (`classifyIntent`): temperature-0 LLM call with a strict JSON schema (`{"action", "target", "role", "channel", "message", "count", "durationMinutes", "volume", "reason"}`) returns `"chat"` (→ persona reply path) or a tool action. Output is never trusted — every field is re-validated/length-limited by the router's `text()` helpers. Aliases ("kick" → `kick_member`, "pause" → `pause_music` …) are canonicalized in `normalizeAction()`.
3. **Dispatch rules** (`runIntent`):

| Intent type | Path |
|---|---|
| `chat` | Persona/LLM reply path (savage/gentle/owner), unchanged |
| `bot_help` | Generated live from the action catalog — cannot drift from what the bot supports |
| Destructive (`delete_role`, `remove_role`, `delete_channel`, `timeout_member`, `kick_member`, `ban_member`, `unban_member`, `delete_messages`, `warn_member`) | `requestConfirmation()` Confirm/Cancel buttons first; only the original requester (who must be an authorized actor) can click Confirm |
| Other admin (`send_message`, role/channel create, `add_role`, voice listening …) | Authorization (strict owner → per-guild owner → admin role) + bot permission check, then `executeTool()` |
| Info/voice/music/warn-list | `executeTool()` directly, no owner gate |

4. **Post-generation moderation** (`moderateReplyText`): every LLM reply is checked before sending — slurs (including leetspeak), protected-class violence, threats, and self-harm encouragement are blocked locally and replaced with a deflection. Prompt text alone is never the safety boundary.
5. **AI rate limiting:** classification and persona replies both count against a per-user sliding-window quota (`AI_RATE_LIMIT_MAX` per `AI_RATE_LIMIT_WINDOW_SECONDS`, default 8/60s), independent of the chat cooldowns.

**Voice transcripts** (`src/routing/voiceRoute.js`) use deterministic keyword routing (no LLM call, nothing leaves the machine beyond the local STT executable). Only playback/info actions are allowed from voice; anything matching admin/destructive phrasing (kick/ban/timeout/delete/role/channel …) is blocked with a redirect: *"That command only works in a text channel, where I can check permissions and confirm anything destructive."*

**Stream safety:** all raw streams (`opusStream`, opus `decoder`, fetched audio stream, ffmpeg stdin/stdout/process) have `error` listeners — an unhandled stream error can no longer crash the process. `@discordjs/opus` is a declared dependency so opus decoding resolves cleanly with `npm install`.

---

## 6. AI Layer (`src/ai/client.js`)

- Two long system prompts:
  - **Savage** — dark humor, Gen-Z slang (English + Hinglish), roast guidelines, strict guardrails (no hate speech, no protected-class attacks, no threats/doxxing/harassment; genuine mental-health crisis → sincere caring support).
  - **Gentle** — wholesome, uplifting, gender-neutral by default, warm emojis (✨ 🌸 💖 👑 🤝).
- `getSystemPrompt()` composes tone + gender pronoun instruction + owner instruction.
- Sampling: `temperature: 1`, `top_p: 1`, `max_tokens: 4096`, non-streaming.
- `cleanOutput()` strips `ZiGBoT:` prefixes and echoed user quotes; `moderateReplyText()` then enforces guardrails locally (see §5).

---

## 7. Memory & Triggers

- **ConversationMemory** (`src/ai/memory.js`): Map keyed by channel ID; keeps the last 8 messages within 15 minutes; user messages prefixed `[DisplayName]:`. A `sweep()` runs on every add/read, evicting expired messages **and deleting channels that go fully inactive** — no unbounded growth.
- **TriggerTracker** (`src/ai/triggerDetector.js`): two cooldown maps (channel, user) so the bot never floods; resettable for tests.
- **RateLimiter** (`src/ai/rateLimiter.js`): per-user sliding-window quota protecting the NVIDIA API; users are tracked independently and recover automatically as the window slides.
- **Keyword lists:** stress (English + Hinglish: "tension mat le", "dimag kharab", "thak gaya", "exams aa gaye"…) and fun ("roast me", "joke sunao", "kya scene hai", "bore ho raha"…).

---

## 8. Security Model

- **Authorization layers** (`src/security/authorization.js` + `isAuthorizedActor()` in the router):
  1. **Strict owner (original guarantee, untouched):** `SERVER_OWNER_ID` must equal both the message author's ID and the actual `guild.ownerId`. This remains the single-server fallback.
  2. **Per-guild owners** (`GUILD_CONFIG`): configured owner ID for that specific guild only — power never crosses guilds.
  3. **Per-guild admin roles** (`GUILD_CONFIG.adminRoleNames`): case-insensitive role-name match, scoped to the configuring guild.
  - `botPermission()` always checks the bot's own Discord permissions before any admin action.
- **Confirmation** (`src/security/confirmation.js`): every destructive action gets interactive Confirm/Cancel buttons; the clicker must be the **original requester AND an authorized actor** (strict owner, per-guild owner, or configured admin role); 45s expiry; pending/cancelled/expired states all audited.
- **Audit log** (`src/logging/auditLog.js`): every security decision/action — success, failure, or denial — logged to console + optional log channel.
- **Role hierarchy:** the bot never manages a role at or above its own highest role, never touches managed roles, and never kicks/bans a member discord.js reports as not `kickable`/`bannable`.
- **Compliance:** music accepts only direct `https://` URLs — no scraping, search, or DRM-bypass logic, by design.
- **Secrets:** `DISCORD_TOKEN`, `NVIDIA_API_KEY`, and raw voice transcripts are never logged or printed (`STORE_TRANSCRIPTS=false` by default).

---

## 9. Tools Router (`src/tools/router.js`)

The action catalog is the single source of truth (action → required permission + description); `bot_help` and the classifier schema are generated from it, so help output can't drift.

| Category | Intents |
|---|---|
| Info | `get_server_info`, `get_member_info`, `get_channel_info` |
| Admin (auth-gated) | `send_message`, `create_role`, `delete_role`*, `add_role`, `remove_role`*, `create_channel`, `delete_channel`*, `rename_channel`, `timeout_member`*, `kick_member`*, `ban_member`*, `unban_member`*, `delete_messages`* (1–100), `warn_member`* |
| Moderation (open) | `list_warnings` |
| Memory | `memory_status` (owner/admin diagnostics), `forget_memory` (own memories; admin-gated for others) |
| Accountability | `behavior_status` (owner/admin: a member's behavior record and standing, live from the ledger) |
| Voice | `join_voice`, `leave_voice`, `voice_status`, `start_voice_listening`, `stop_voice_listening` |
| Music | `play` (direct HTTPS URL), `pause_music`, `resume_music`, `skip_music`, `stop_music`, `queue_music`, `now_playing`, `volume_music` (0–100), `loop_music` |
| Meta | `bot_help` (live-generated) |

\* = destructive → requires the Confirm/Cancel flow before execution.

> ✅ **The router is fully wired:** every message is classified into a tool intent and dispatched through `executeTool()` — admin, info, voice, music, and warn commands are live, from text, slash, and voice entry points.

---

## 10. Slash Commands (`src/slash.js`)

Second entry point into the exact same router/authorization/confirmation path as text commands — `/play`, `/kick`, `/ban`, `/help`.

- Registered on startup: per-guild when `SLASH_COMMAND_GUILD_IDS` is set (instant), otherwise globally (may take up to an hour to propagate).
- `/kick` and `/ban` carry Discord's `DefaultMemberPermissions` (hidden from members without Kick/Ban Members) **and** still require the Confirm/Cancel flow before executing.
- `/help` renders from the live action catalog.
- Interactions are converted to the same validated intent shape; all field validation happens inside `executeTool`, never in the converter.

---

## 11. Voice & Music

### Voice Pipeline (`src/voice/`)
1. Speaking-start event → opus stream capture (ends 1s after silence).
2. Decoded via `prism-media` + `@discordjs/opus` → max 15s PCM buffer.
3. WAV written to a temp dir → external **STT** command (e.g., Whisper) → transcript callback.
4. Temp files always deleted after processing.
5. Transcripts route through the deterministic voice router (§5) — destructive/admin actions are blocked from voice and redirected to a text channel.
6. **TTS:** external command (e.g., Piper) writes a WAV, played through an audio player, cleaned up on idle.

### Reconnect Handling (`src/voice/voiceManager.js`)
Transient disconnects (channel moves, regional blips) no longer kill playback silently: up to 3 reconnect attempts with capped exponential backoff (2s → 15s), using discord.js's recommended signal-wait race. Destroyed connections are never resurrected; if reconnect finally fails, the connection and music queue are cleaned up and the failure is logged.

### Music Player (`src/music/player.js`)
- Per-guild state (queue, current track, volume, loop).
- HTTPS-only URL validation (any other protocol rejected).
- Streams through `ffmpeg` into raw s16le 48kHz stereo with inline volume; all ffmpeg/stream pipes have error listeners.
- Track end (Idle) → auto-advance; loop toggle replays the current track; queue cleared on voice leave.

---

## 12. Warn System & Persistence (`src/db/`)

- **MongoDB Atlas via the official `mongodb` Node.js driver** (no ODM), connected at startup from `MONGODB_URI`; database `zigbot` with `users`, `warnings`, `counters`, `memories`, and `behaviors` collections.
- **All queries live in `src/db/brain.js`** — unique index on `users.userId`, compound index on `warnings (guildId, userId, created_at)`, index on `memories (guildId, userId, created_at desc)` and `behaviors (guildId, userId, created_at desc)`; warning/memory ids come from an atomic counter, mirroring the old SQLite AUTOINCREMENT.
- **`warn_member`** (destructive → confirmation flow) records who warned, the reason, and when; **`list_warnings`** shows a member's warnings with timestamps. Every warning AND timeout also lands in the behavior ledger as a negative accountability signal.
- Warns survive restarts. The DB is required at startup: if `connectBrain()` fails, the bot logs a clear error and exits instead of running in a broken state.
- **Persistent long-term memory** (`memories` collection): durable user facts/preferences are saved selectively (never commands or chat noise; passwords/API keys/tokens are refused outright) via `remember()` and retrieved per user per guild via `recall()` before every AI reply. Memory questions ("what do you remember?") are answered deterministically from live MongoDB state — the bot never fakes memories and never claims a save/delete that did not happen. `memory_status` (owner/admin) reports the REAL runtime state; `forget_memory` lets users delete their own memories (admin-gated for other users).
- Everything else (conversation memory, music queues) intentionally stays in-process.

---

## 13. Configuration Reference (`.env.example`)

### Required
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token from the Developer Portal |
| `NVIDIA_API_KEY` | NVIDIA NIM API key (or OpenAI-compatible endpoint key) |
| `MONGODB_URI` | MongoDB Atlas connection string (free M0 tier at cloud.mongodb.com) — the process exits at startup without it |

### Behavior
| Variable | Default | Description |
|---|---|---|
| `SERVER_OWNER_ID` | — | Discord user ID of the server owner (ZiG: `1296202178263912448`). Single-server fallback; still requires matching `guild.ownerId`. |
| `SERVER_OWNER_ROLE_NAME` | `꧁༺ ZiG ༻꧂` | Display name of the owner's role (informational) |
| `GUILD_CONFIG` | — | Per-guild owners/admins (multi-server). JSON: `{"<guildId>": {"ownerId": "...", "adminRoleNames": ["..."]}}` |
| `AI_MODEL` | `openai/gpt-oss-20b` | Model used for chat completions |
| `LOG_CHANNEL_ID` | — | Channel that receives audit log entries |
| `RESPOND_TO_ALL_MESSAGES` | `false` | Reply to every message in every server |
| `CHAT_CHANNEL_IDS` | — | Comma-separated channel IDs for always-on chat |
| `AUTO_REPLY_KEYWORDS` | `false` | Enable stress/fun keyword triggers |
| `COOLDOWN_SECONDS` | `15` | Anti-spam cooldown per channel and per user (keyword triggers) |
| `AI_RATE_LIMIT_MAX` | `8` | Max AI calls per user per window (classification + replies) |
| `AI_RATE_LIMIT_WINDOW_SECONDS` | `60` | Sliding window for the AI rate limit |
| `SLASH_COMMAND_GUILD_IDS` | — | Comma-separated guild IDs for instant guild-only slash registration; empty = global |
| `MONGODB_URI` | — | MongoDB Atlas connection string for the warn system (free M0 tier at cloud.mongodb.com) |
| `HUMOR_STYLE` | `witty_stress_relief` | Personality preset |

### Roles
| Variable | Description |
|---|---|
| `GENTLE_ROLE_NAMES` | Roles that receive gentle, wholesome treatment |
| `FEMALE_ROLE_NAMES` | Roles that map to she/her pronouns |
| `MALE_ROLE_NAMES` | Roles that map to he/him pronouns |
| `NON_GENTLE_ROLE_NAMES` | Roles (e.g., `Users.heer`) that force savage mode even for the owner |

### Voice
| Variable | Default | Description |
|---|---|---|
| `VOICE_MODE` | `push-to-talk` | Voice mode |
| `STORE_TRANSCRIPTS` | `false` | Persist voice transcripts (temp files deleted by default) |
| `NVIDIA_SPEECH` | `true` | Use NVIDIA hosted ASR/TTS (no local binaries — Render-friendly). `false` restores legacy local STT/TTS commands |
| `NVIDIA_ASR_FUNCTION_ID` | multilingual Parakeet | Override the hosted Riva ASR model function-id |
| `NVIDIA_TTS_ENDPOINT` | Magpie multilingual | Override the hosted Magpie TTS base URL |
| `NVIDIA_TTS_LANGUAGE` | `en-US` | TTS language (use `hi-IN` for Hindi) |
| `NVIDIA_TTS_VOICE` | `Magpie-Multilingual.EN-US.Aria` | TTS voice name (list via the endpoint's `list_voices`) |
| `STT_COMMAND` / `STT_ARGS` | — | Legacy local STT executable + JSON arg template (`{input}`, `{output}`) — only used when `NVIDIA_SPEECH=false` or as fallback |
| `TTS_COMMAND` / `TTS_ARGS` | — | Legacy local TTS executable + JSON arg template (`{text}`, `{output}`) — only used when `NVIDIA_SPEECH=false` or as fallback |
| `STT_TIMEOUT_MS` / `TTS_TIMEOUT_MS` | `60000` | Executable timeouts (legacy local path) |

---

## 14. Tests (6 suites, 130 tests)

| Suite | Covers |
|---|---|
| `test/music.test.js` | HTTPS-only source validation, volume bounds (0–100) |
| `test/authorization.test.js` | Owner checks, guild-owner match requirement, roast-target gating |
| `test/autoReply.test.js` | Creator-question regexes, prompt contents, `Users.heer` override, gender-neutrality rules, stress/fun/neutral triggers, cooldowns, memory window **+ sweep**, Unicode role detection, settings parsing, **crisis-gate cases (incl. hyperbole false-positive guards)**, **moderation blocks & banter pass-through** |
| `test/router.test.js` | **Non-owner admin denial, destructive-set completeness, catalog/permission consistency, info/music/help without owner auth, alias canonicalization, role-hierarchy block, voice blocks destructive actions, voice allows playback/info** |
| `test/memory.test.js` | **Memory store CRUD + indexes, credential refusal, capability truth-telling (connected/unconnected/failing), simulated restart persistence, memory-question detection & truthful answers, selective save heuristics, owner-gated `memory_status`, `forget_memory` auth + honest zero-delete reporting** |
| `test/behavior.test.js` | **Behavior ledger CRUD + indexes, sliding-window scoring (+1/−2, 30-day window), tier boundaries, conservative signal detection (banter never punished), structural spam tracker, reputation grounding blocks, truthful reputation answers, owner-gated `behavior_status`, automatic `warning` signal on warns** |
| `test/p3.test.js` | **Rate-limiter window & per-user independence, Mongo warn store (add/count/list, indexes, default profile shape, unconnected guard) via fake client, strict-fallback unchanged, per-guild owner scoping, admin-role matching/scoping, warn routing, slash intent conversion** |

Run everything:
```bash
npm test         # all suites
npm run check    # syntax-check every source file
```

---

## 15. Getting Started

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure your credentials in `.env` (see §13). At minimum:
   - `DISCORD_TOKEN` — from the Discord Developer Portal.
   - `NVIDIA_API_KEY` — for NVIDIA NIM inference.
3. Start the bot:
   ```bash
   npm start
   ```

Quick sanity checks after inviting the bot:
- `@ZiGBoT help` (or `/help`) — lists every live action, generated from the catalog.
- `@ZiGBoT kick @someone` as the owner — should produce a Confirm/Cancel prompt, not an instant kick.
- Same command as a non-owner — should be denied and audited.

---

## 16. Design Notes & Limitations

- **Multi-server:** per-guild owners/admins via `GUILD_CONFIG`; conversation memory, music queues, and voice sessions are per-guild.
- **Persistence scope:** only warns are persisted (MongoDB Atlas, required at startup). Conversation memory and music queues intentionally stay in-process and reset on restart.
- **Voice listening** uses NVIDIA hosted speech by default (`NVIDIA_SPEECH=true`): Discord audio is downsampled in pure JS (no ffmpeg) and sent to the hosted Riva ASR endpoint, and replies are synthesized with hosted Magpie TTS and played back as raw PCM — no local binaries, so it works on Render's free tier. Plain conversation in voice chat gets spoken replies; set `NVIDIA_SPEECH=false` to restore the legacy local-executable pipeline.
- **Slash-command global registration** (when `SLASH_COMMAND_GUILD_IDS` is empty) can take up to an hour to propagate on Discord's side; guild-scoped registration is instant.
- **Compliance stance:** playback is restricted to direct HTTPS sources — no YouTube/Spotify scraping, search, or DRM bypass, by explicit design.
- **Safety in depth:** crisis gate → intent classification → authorization → confirmation → execution → audit → post-generation moderation. Prompts are never the only safety boundary.
- **Behavior accountability:** positive/negative signals (conservative detection + structural spam + admin warnings/timeouts) feed a 30-day sliding-window ledger (+1/−2). The AI's treatment adapts to the derived standing (valued/respected/neutral/rocky/hostile) via prompt ground truth — sharper for rocky/hostile members, warmer for valued ones, with every guardrail intact. "What's my reputation?" is answered from the real record.
