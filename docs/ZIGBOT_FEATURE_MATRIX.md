# ZiGBoT Feature Matrix

## Scope and method

Read-only audit of the current workspace against `ZIGBOT_FEATURE_EXPANSION.md`,
limited to Phases 1–3: project discovery, the Phase 2 A–M inventory, and this
implementation matrix. No application code was changed. A feature is marked
`WORKING` only when a named test directly exercises it; implemented features
without that proof are `WORKING (UNTESTED)`. `PARTIAL` means some but not all
requested behavior exists. Missing-feature proof identifies the repository
search and scope used.

## Project snapshot

| Area | Finding | Evidence |
|---|---|---|
| Discord.js / Node | discord.js `^14.27.0`; Node `24.x` | `package.json:24-32` |
| Bot/backend | Node.js CommonJS Discord client; no separate backend web framework | `src/index.js:1-40`; `package.json:7-9` |
| Dashboard | Next.js `15.5.28`, React `19.3.1`, App Router | `dashboard/package.json:7-20`; pages under `dashboard/app/` |
| Databases | MongoDB native driver for bot collections; Supabase/PostgreSQL for dashboard/server configuration and SaaS data | `src/db/brain.js:11,172-190`; `dashboard/lib/supabase/server.js`; `supabase/migrations/` |
| Authentication | Supabase Auth session using Discord OAuth; privileged guild requests re-fetch guild/member through Discord and verify owner/Admin/Manage Server | `dashboard/lib/auth.js:12-53`; tests `Discord id comes only from Supabase identities, never editable user_metadata`, `access decision: managers allowed, helpers and strangers denied, bot-missing reported` in `test/dashboardAccess.test.js` |
| AI providers | NVIDIA and Groq through the OpenAI-compatible SDK; Google YouTube Data API for YouTube features; voice speech backends include NVIDIA, Groq, Sarvam and local | `src/ai/providers.js:1-40`; `src/youtube/apiClient.js`; `src/voice/` |
| Test framework | Node built-in `node:test`; `npm test` runs `node --test` | `package.json:9`; 52 test files under `test/` |
| Background work | In-process Anti-Nuke per-guild bounded queue (`500`); scheduled greetings tick every 30s; YouTube polling and memory-summary queue are in-process | `src/antinuke/monitor.js:17-24`; `src/greetings/scheduler.js:2,126-132`; `src/youtube/liveDetector.js`; `src/memory/summaries.js` |
| Existing dashboard surface | Public landing/commands/privacy/terms; guild dashboard/config, Anti-Nuke, music, greetings and identity; admin analytics, servers, users, security, audit, premium and feedback | `dashboard/app/` pages; 30 API route files under `dashboard/app/api/` |
| Existing security/moderation | Discord owner/admin-gated tool actions (role/channel management, timeout/kick/ban/unban, purge, warnings), deterministic security processor, Anti-Nuke audit-log monitoring and optional containment | `src/tools/router.js:16-40,520-780`; `src/security/integration.js`; `src/antinuke/monitor.js`; tests `kick_member: still works on a member below the requester`, `end-to-end phishing link is quarantined`, `2. a rapid destructive burst is CRITICAL, and needs the burst (window-based)` |

### Existing commands

**Slash commands (base set, 30):** `/play`, `/search`, `/pause`, `/resume`,
`/skip`, `/stop`, `/queue`, `/nowplaying`, `/volume`, `/shuffle`, `/loop`,
`/remove`, `/clearqueue`, `/leave`, `/join`, `/kick`, `/ban`, `/memory`,
`/reputation`, `/security`, `/summarychannels`, `/help`, `/setup`, `/watch`,
`/unwatch`, `/ytstatus`, `/ytgreet`, `/ytmod`, `/ytroast`, `/ytretry`.
`/identity` is additionally registered when `CUSTOM_IDENTITY_ENABLED=true`.
Definitions and conditional identity registration: `src/slash.js:47-247`;
YouTube commands are home-guild scoped at `src/slash.js:250-280`.

**Prefix commands:** there is no general `!` prefix for the Discord bot; its
normal interface is mentions, configured channels and slash commands
(`src/index.js:636-702`). YouTube live chat has a configurable prefix
(`YOUTUBE_COMMAND_PREFIX`, default `!`) and owner-only commands:
`timeout`, `ban`, `unban`, `delete`, `confirm`, `cancel`, `roast`,
`roastmode`, `noroast`, `yesroast` (`src/youtube/config.js:63`;
`src/youtube/commands.js:70-90`). AFK uses `afk [reason]` and the avatar
viewer uses phrases such as `av @user`; these are message triggers, not a
general prefix (`src/afk/afk.js:22-28`; `src/avatar/avatar.js:21-34`).

### Duplicate Discord event listeners

| Event | Registrations | Finding |
|---|---|---|
| `messageCreate` | `src/index.js:636`; `src/security/integration.js:252` | Two listeners: normal bot/AFK/avatar/chat pipeline and security processing. |
| `guildMemberAdd` | `src/index.js:272`; `src/security/integration.js:255` | Two listeners: legacy Anti-Nuke join processing and security raid processing. |

Other `client.on`/`client.once` registrations found in `src/index.js` and
`src/security/integration.js` are single registrations by event name. The
gateway audit-log stream and the resource-event hooks can see the same
underlying destructive action; `src/antinuke/monitor.js:221-233` deduplicates
audit entry IDs. The two rows above are duplicate listener registrations,
though they serve distinct subsystems.

### TODO, FIXME and placeholder scan

The case-insensitive search for `TODO|FIXME|placeholder function|not
implemented|stub|coming soon` across `src/`, `dashboard/` and `test/` found no
production TODO/FIXME marker or unfinished function. Matches requiring
context:

- `src/voice/nvidiaSpeech.js:335`: explicitly test-only injectable fake client.
- `src/reply/delivery.js:240` and `src/memory/commands.js:156`: optional no-op
  callback defaults, not empty feature handlers.
- `src/ai/userContext.js:23-27`: intentional model-output name/mention
  placeholders that are replaced or removed.
- UI input placeholder attributes and test-only stubs are not implementations.
- A duplicate `case 'get_server_info'` appears at `src/tools/router.js:336-337`;
  it does not add behavior.

## A. Moderation

| Feature | Status | Proof | Action |
|---|---|---|---|
| Ban and unban | WORKING | `src/tools/router.js:915-932`; `existing ban, unban, and purge actions still call Discord with their original arguments` (`test/moderation-actions.test.js:101`) verifies both existing actions and audit/case writes. | Reuse |
| Kick | WORKING | `src/tools/router.js:904-914`; tests `kick_member: still works on a member below the requester`, `kick_member: refuses a target at or above the requester's highest role` (`test/router.test.js`). | Reuse |
| Timeout and untimeout | WORKING | `src/tools/router.js:802-863`; tests `untimeout checks hierarchy and clears the Discord timeout` and `existing timeout keeps its response and persists its expiry before calling Discord` (`test/moderation-actions.test.js:126,133`). | Reuse |
| Warnings | WORKING | Per-guild/member warning storage and list action: `src/tools/router.js:618-679`; tests `brain warns store adds, counts, and lists per guild+user` (`test/p3.test.js`), `warn_member records a negative accountability signal automatically` (`test/behavior.test.js`). | Reuse |
| Warning escalation | WORKING | Opt-in third-warning timeout and disabled behavior are verified by `warning escalation is opt-in and applies the configured third-warning timeout` (`test/moderation-actions.test.js:163`); per-guild default is false (`dashboard/lib/shared/defaults.js:63`). | Reuse |
| Message purge | WORKING | `delete_messages` validates count and calls `bulkDelete`: `src/tools/router.js:933-940`; original args and logging are checked in `existing ban, unban, and purge actions still call Discord with their original arguments` (`test/moderation-actions.test.js:101`). | Reuse |
| Slowmode | WORKING | `src/tools/router.js:942-951`; `slowmode and channel lock actions update only the requested channel controls` (`test/moderation-actions.test.js:146`) verifies `setRateLimitPerUser`. | Reuse |
| Channel lock and unlock | WORKING | `src/tools/router.js:953-969`; `slowmode and channel lock actions update only the requested channel controls` (`test/moderation-actions.test.js:146`) verifies lock and unlock overwrites. | Reuse |
| Role management | WORKING | Create/delete/add/remove with bot and requester hierarchy checks: `src/tools/router.js:571-598`; tests `add_role: cannot hand out a role at or above the requester's highest role`, `remove_role and delete_role respect the requester's hierarchy`. | Reuse |
| Nickname management | WORKING | Moderator nickname route checks permission and target hierarchy: `src/tools/router.js:970-985`; `nickname management checks manageable target and sets the requested nickname` (`test/moderation-actions.test.js:156`). Existing AFK behavior remains covered by `test/afk.test.js`. | Reuse |
| Auto moderation | WORKING | Opt-in incoming-message quarantine and alerts: `src/moderation/messageFilters.js:37-90`; `opt-in auto moderation quarantines violating messages and audits/alerts moderators` (`test/moderation-filters.test.js:54`) and `end-to-end phishing link is quarantined` (`test/security-intelligence.test.js:48`). | Reuse |
| Word filters | WORKING | Per-guild configured word rules: `src/moderation/messageFilters.js:37-49`; `opt-in word, caps, and mention filters are per-guild and independent` (`test/moderation-filters.test.js:95`). | Reuse |
| Anti-Spam | WORKING | Opt-in repeated-message rate filter: `src/moderation/messageFilters.js:18-35`; `opt-in anti-spam flags repeated rapid messages from the same member` (`test/moderation-filters.test.js:117`). | Reuse |
| Anti-Caps | WORKING | Opt-in caps filter: `src/moderation/messageFilters.js:50-52`; `opt-in word, caps, and mention filters are per-guild and independent` (`test/moderation-filters.test.js:95`). | Reuse |
| Anti-Mention Spam | WORKING | Opt-in mention-count filter: `src/moderation/messageFilters.js:53-55`; `opt-in word, caps, and mention filters are per-guild and independent` (`test/moderation-filters.test.js:95`). | Reuse |
| Anti-Invite | WORKING | Opt-in invite filter: `src/moderation/messageFilters.js:56-57`; `opt-in auto moderation quarantines violating messages and audits/alerts moderators` (`test/moderation-filters.test.js:54`). | Reuse |
| Moderation logs | WORKING | Actions write to `auditLog` and create moderation cases (`src/tools/router.js:991-1010`); tested in `existing ban, unban, and purge actions still call Discord with their original arguments` (`test/moderation-actions.test.js:101`) and `/moderation case review is permission-gated, guild-scoped, and audited` (`test/moderation-commands.test.js:62`). | Reuse |
| Case management | WORKING | Guild-scoped case storage and `/moderation` review workflow: `src/db/brain.js:303-384`, `src/moderation/commands.js:51-98`; tested in `moderation cases and temporary punishments survive a brain reconnect and stay guild-scoped` and `/moderation case review is permission-gated, guild-scoped, and audited` (`test/moderation-store.test.js:89`, `test/moderation-commands.test.js:62`). | Reuse |
| Appeals | WORKING | Guild-scoped appeal intake and review: `src/moderation/commands.js:29-98`; tests `/appeal is disabled by default and creates a guild-scoped appeal when enabled` and `appeals are limited to the punished member and cannot cross guild boundaries` (`test/moderation-commands.test.js:36`, `test/moderation-store.test.js:119`). | Reuse |
| Temporary punishments | WORKING | Timeouts and opt-in temporary bans are persisted (`src/tools/router.js:802-925`, `src/db/brain.js:387-460`) and resumed by `src/moderation/expiry.js`; tests `existing timeout keeps its response and persists its expiry before calling Discord`, `temporary ban is off unless enabled and persists its expiry before banning`, and both restart expiry tests (`test/moderation-actions.test.js:133,183`, `test/moderation-expiry.test.js:5,37`). | Reuse |

## B. AI Security

Section B fixed only the PARTIAL/MISSING rows. The existing pipeline (`src/security/*`) is unchanged; the additions are an opt-in layer next to it (`src/features/securityPlus.js`, Add-ons → Security+, `feature_settings.security`). AI and heuristic results only raise staff alerts; the one automatic action is deleting a message with a confirmed scam link, when switched on. Tests: `test/section-b-security-plus.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| AI ScamShield | WORKING | Existing deterministic processing unchanged, plus an opt-in per-message AI second opinion for links the rule scanner rates safe: existing provider, untrusted-data wrapper, strict JSON (`validateScanVerdict`), 30 scans/hour/server, alerts only at >= 70% confidence, never deletes; test `AI ScamShield: second opinion only for links the rules call safe, alert only, rate-limited, sure answers only`. | Done (Section B) |
| Phishing detection | WORKING | `src/security/detectors/scamDetector.js`; test `end-to-end phishing link is quarantined` and `classifyUrl flags obvious phishing and safe URLs` (`test/security-intelligence.test.js`). | Reuse |
| Malicious URL detection | WORKING | Existing homoglyph/shortener classifier unchanged, plus reputation from the opt-in shared scam-link list (punycode decoded and look-alike letters folded before hashing); tests `link hashes: same link with any scheme, www, query or look-alike letters gives one hash`, `shared scam list: ...`. Redirect-chain following stays BLOCKED by design: the bot never opens reported or suspicious links, and no isolated fetch service exists. | Done (Section B) |
| AI BehaviourGuard | WORKING | Per-server configurable baselines (messages per 10 s, duplicate messages per minute), one alert per burst, review flag only; test `BehaviourGuard: configurable burst and duplicate baselines, one alert per burst, no action`. Private DM signals are not observable and not inferred. | Done (Section B) |
| Anti-Raid | WORKING | Join-rate and cross-member repeated-message signals: `src/security/integration.js:50-73,181-205`; test `end-to-end raid joins with identical messages are escalated`. No temporary verification mode. | Reuse |
| Anti-Nuke | WORKING | Audit-log event engine, bounded processing, alerts, optional containment: `src/antinuke/engine.js`, `src/antinuke/monitor.js:31-46,119-205`; tests `2. a rapid destructive burst is CRITICAL, and needs the burst (window-based)`, `role hierarchy, managed roles and missing permissions are respected`. | Reuse |
| Impersonation detection | WORKING | Display names checked on join and on nickname change against the owner, staff (Administrator/Manage Server) and the bot: NFKC, homoglyph and leetspeak folding, one edit away or contained; exact own name not flagged; tests `look-alike names: ...`, `joins: impersonators and risky new accounts are flagged for review; staff and normal members are not`. | Done (Section B) |
| Suspicious account detection | WORKING | Join risk score with reasons (account age vs a configurable days limit, no avatar, number-suffixed name) and a configurable threshold; flagged for review, never auto-actioned; tests `account risk: ...`, `joins: ...`. | Done (Section B) |
| Coordinated attack detection | WORKING | Repeated text across users plus join bursts: `src/security/integration.js:50-73,181-205`; test `end-to-end raid joins with identical messages are escalated`. | Reuse |
| Threat scoring | WORKING | Multi-signal scoring and correlated-signal penalty: `src/security/scoring/threatScoring.js`, `src/security/core/processor.js:21-47`; test `scoreThreatAssessment explains each risk signal without double counting`. | Reuse |
| Security incident management | WORKING | Guild-scoped incidents: `src/security/core/incidentManager.js`; tests `end-to-end phishing link is quarantined`, `adversarial cross-guild access is isolated`, and `duplicate audit entry IDs are processed once across correlated and gateway events`. | Reuse |
| AI Security Copilot | WORKING | Existing `/security status|report|why` unchanged; new `/security suspicious` (flagged members), `admins` (sensitive audit-log actions), `recommend` (deterministic server hardening checks), `reporturl`, with the same authorization (`isSecurityCommandAuthorized`) and audit; tests `/security new subcommands: same authorization as the existing ones, audited`, `/security suspicious, admins, recommend and reporturl`. | Done (Section B) |
| Security reports | WORKING | Guild-scoped incident report and `why` retrieval: `src/security/commands.js`; tests `configured security role can run scoped reports even when the AI provider fails`, `/security status and /security why are private and guild-scoped`. | Reuse |
| Cross-server threat intelligence | WORKING | Opt-in shared list: only SHA-256 hashes of normalised links plus hashed server ids; a link counts as confirmed after 2 distinct servers (or this server's own report), so one server cannot poison it; optional quarantine; test `shared scam list: one server is not enough, two confirmations are; only hashes are shared`. | Done (Section B) |
| Prompt injection protection | WORKING | User-role data is marked untrusted in `src/ai/client.js:148-190`; tests `end-to-end prompt injection is flagged without emergency lockdown`, `chat messages and intent inputs stay separate from the system prompt as untrusted data`, `prompt injection in the conversation cannot plant facts or privileges`. | Reuse |
| AI output validation | PARTIAL | Unchanged and accepted by design: structured outputs (security assistant, intents, summaries, tickets, and the new Section B/D tools) are schema-validated; normal conversational replies are free text, filtered by the existing `moderateReplyText`/`reviewReply`. No change made, to keep existing chat behaviour. | PARTIAL |

## C. Community Management

All Section C features are off by default and enabled per server in the dashboard (Add-ons → Community, `zb_guild_configs.feature_settings.community`). Migration: `supabase/migrations/20261114000000_zigbot_features_community.sql`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| Welcome messages | WORKING | Opt-in per-member welcome with `{user}`/`{server}`/`{memberCount}` in the existing `GuildMemberAdd` listener: `src/features/community.js` (`onMemberAdd`); test `welcome: message with the member tagged once, image card, auto-role (bots skipped), milestone once` (`test/section-c-community.test.js`). The bot-join setup welcome is unchanged. | Done (Section C) |
| Goodbye messages | WORKING | Opt-in `GuildMemberRemove` goodbye that names but never pings: `src/features/community.js` (`onMemberRemove`); test `goodbye names the member without pinging; the count channel is renamed at most once per 10 minutes`. | Done (Section C) |
| Welcome images | WORKING | `@napi-rs/canvas` card (`src/features/welcomeImage.js`), attached when `welcome_image_enabled`; tests `welcome image is a real PNG of the expected size` and the welcome test above. | Done (Section C) |
| Auto-role | WORKING | Opt-in join roles, bots skipped, staff/managed/above-bot roles refused and audited: `src/features/community.js`, `src/features/common.js` (`roleProblem`); test `welcome: message with the member tagged once, image card, auto-role (bots skipped), milestone once`. | Done (Section C) |
| Reaction roles | WORKING | `/roles type:reactions` panel, persisted in `zb_feature_records`, mapped number emoji toggle the role: `src/features/community.js`; test `reaction panels add and remove the mapped role; a role that became unsafe is refused`. | Done (Section C) |
| Button roles | WORKING | `/roles type:buttons`: only roles stored for that panel can be toggled; test `button and dropdown panels toggle only the panel's own roles, and are persisted`. | Done (Section C) |
| Dropdown roles | WORKING | `/roles type:dropdown`: values outside the panel ignored; same test as button roles. | Done (Section C) |
| Member milestones | WORKING | Every N members (default 100), posted once per count via a once-only record: `src/features/community.js`; welcome test above. | Done (Section C) |
| Birthday announcements | WORKING | `/community birthday` stores day+month only; one daily post per server in its timezone (default Asia/Kolkata), only for members still present: `src/features/community.js` (`birthdayPosts`, `localDate`); tests `birthdays: day and month only, posted once per local day, only for members still here`, `templates, local dates and birthdays`. | Done (Section C) |
| Server statistics | WORKING | `/community stats` (members, text/voice channels, roles, boosts); test `/community stats works for everyone and reports real counts`. Historical analytics are Section L. | Done (Section C) |
| Member count | WORKING | Unchanged `get_server_info`, plus an opt-in member-count voice channel renamed at most once per 10 minutes; test `goodbye names the member without pinging; the count channel is renamed at most once per 10 minutes`. | Done (Section C) |
| Starboard | WORKING | ⭐ threshold (default 3), author/bot stars ignored, once per message, never from the starboard channel: `src/features/community.js`; test `starboard: 3 stars from other humans, once per message, never for bots or from its own channel`. | Done (Section C) |
| Suggestions | WORKING | `/suggest` with vote buttons (one vote per member, atomic `mutate`) and staff (Manage Messages) approve/deny; tests `/suggest: one vote per member, staff-only decisions, closed suggestions stay closed`, `suggestion votes are not lost when many members vote at once`. | Done (Section C) |
| Polls | WORKING | `/community poll` uses Discord native polls (one vote per member enforced by Discord), staff-only; test `polls, announcements and reminders are staff-only and never ping`. | Done (Section C) |
| Announcements | WORKING | `/community announce` staff-only, no pings; same test. Scheduled greetings unchanged. | Done (Section C) |
| Community reminders | WORKING | `/community remind` on the shared persistent scheduler (`src/features/scheduler.js`: claimed once, survives restarts, 3 bounded retries); tests `reminder: stored, posted when due (also after a restart), and dropped if the feature was switched off`, `scheduler: a job runs once when due, survives a restart, and repeats when asked`. | Done (Section C) |

## D. AI Chatbot

Section D fixed only the PARTIAL/MISSING rows. New tools are off by default (Add-ons → AI tools, `feature_settings.ai`), use the existing provider (`ai.client`/`ai.model`) and the existing `untrustedUserData` wrapper, have a 15 s timeout and token caps, validate output, and are advisory only. Tests: `test/section-d-ai.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| AI conversations | WORKING (UNTESTED) | Message handler builds provider-backed replies in `src/index.js:636-702,790-900`; no full live Discord/provider end-to-end test. | Add tests |
| AI personalities | WORKING | Persona/role routing in `src/ai/client.js`, `src/ai/roleDetector.js`; tests `every persona path carries the answer rules` (`test/responseQuality.test.js`), `configured pronoun roles select gender while other roles and names do not` (`test/autoReply.test.js`). | Reuse |
| Custom server personas | WORKING | Guild editor exposes prompt/instructions/rules: `dashboard/components/GuildEditor.js:436-438`; runtime config is guild-scoped; tests `reply prompt: legacy path unchanged, multi path layered and identity-safe` (`test/multiServerBot.test.js`), `the editor shows the cards in the custom persona card, accessible and reduced-motion aware` (`test/personaTemplates.test.js`). | Reuse |
| User-specific preferences | WORKING | Per-guild/member memory preferences and role-based response settings: `src/db/brain.js:180-184`; test `off persists across a restart and blocks retrieval; on re-enables it` (`test/memoryCommands.test.js`). | Reuse |
| Conversation context | WORKING | Bounded per-channel conversation history: `src/ai/memory.js`; test `ConversationMemory buffers and limits sliding history window` (`test/autoReply.test.js`). | Reuse |
| Optional long-term memory | WORKING | Opt-in memory store and `/memory` controls: `src/db/brain.js`, `src/memory/commands.js`; tests `remember stores content with guild, user, type, and created_at`, `off persists across a restart and blocks retrieval; on re-enables it`. | Reuse |
| AI FAQ assistant | WORKING | Admin FAQ list (max 25) in the dashboard; `/ai faq` answers only from it (`NO_ANSWER` otherwise) and falls back to a keyword match when the AI is down or over its limit: `src/features/aiTools.js` (`matchFaq`); test `FAQ: answers come from the FAQ; without the AI it falls back to a keyword match`. | Done (Section D) |
| AI translation | WORKING | `/ai translate text to` through the existing provider with the untrusted-data wrapper; target language validated; output cleaned of pings: `src/features/aiTools.js`; tests `translate: uses the provider with the untrusted-data wrapper, a timeout and a token cap`, `AI output is cleaned: no pings, no empty replies; the AI being down is said plainly`. | Done (Section D) |
| AI summarization | WORKING | Opt-in conversation/channel summarization: `src/memory/summaries.js`; plus on-demand private channel summaries `/ai summarize` (Section D, test `summarize: only human messages, oldest first, sent as untrusted data; the reply is private`); tests `batches run after 12 messages, or after 10 idle minutes with at least 4`, `invalid summariser output is discarded whole`, `prompt injection in the conversation cannot plant facts or privileges`. | Reuse |
| AI image understanding | BLOCKED | The configured chat model (`AI_MODEL`, default `openai/gpt-oss-20b` on NVIDIA/Groq) is text-only, and `src/ai/providers.js` deliberately excludes vision models (`NON_CHAT` filter). Needs a vision-capable model configured before it can be built and tested. | BLOCKED |
| AI moderation assistant | WORKING | `/ai modreview member situation` (Moderate Members): warning history + description → strict JSON `{verdict, reason}` with an allowlisted verdict, shown as advisory only, audited: `src/features/aiTools.js` (`validateModAdvice`); test `modreview: staff only, strict JSON, advisory only, audited; bad AI output is rejected`. | Done (Section D) |
| AI command assistance | WORKING | Structured intent classification maps messages to an allowlisted action catalog: `src/ai/client.js:401-430`, `src/tools/router.js:68-110`; tests `slash commands map to canonical router actions` (`test/p3.test.js`), `normalizeAction canonicalizes aliases and rejects unknown actions`. | Reuse |
| Per-channel configuration | WORKING | Per-channel AI off switch (threads inherit the parent) plus per-server and per-channel daily AI reply limits, checked right after the existing chat gate in `src/index.js` (`features.allowAiReply`), counted atomically: `src/features/aiTools.js`; tests `per-channel AI switch and daily limits (server-wide and per channel); off means unlimited`, `parallel replies cannot slip past the daily limit`, `src/index.js checks the AI limits right after the existing chat gate, and passes the existing provider`. | Done (Section D) |
| Usage limits | WORKING | Per-user AI rate limiting and per-member/guild/global summary caps: `src/ai/rateLimiter.js`, `src/memory/summaries.js`; tests `rate limiter allows up to max then blocks within the window` (`test/p3.test.js`), `per-member call cap holds, and survives a restart`. | Reuse |

## E. AFK and Utilities

| Feature | Status | Proof | Action |
|---|---|---|---|
| AFK detection | WORKING | Message pipeline invokes AFK handler before AI: `src/index.js:674`; test `workflow: afk -> mentioned -> returns, fully automatic` (`test/afk.test.js`). | Reuse |
| AFK reason | WORKING | Reason parser/cleaner and announcement card: `src/afk/afk.js:22-52`; tests `cleanReason: no pings, no slurs, short, never empty`, `workflow: afk -> mentioned -> returns, fully automatic`. | Reuse |
| AFK duration | WORKING | Stored start time and duration formatting: `src/afk/afk.js:51-64,95-114`; test `welcome back card: tags once, report with left/returned/total`. | Reuse |
| AFK mention notifications | WORKING | Mention cards with cooldown and per-message cap: `src/afk/handler.js:94-111`; test `mentions: no spam from repeated pings, at most 3 cards per message, never for bots or yourself`. | Reuse |
| Automatic AFK removal | WORKING | Returning message clears status and restores unchanged original nickname: `src/afk/handler.js:87-92`; tests `workflow: afk -> mentioned -> returns, fully automatic`, `return: restores a custom original nickname, but never overwrites one the user changed meanwhile`. | Reuse |
| Avatar command | WORKING | Message-triggered avatar viewer: `src/avatar/avatar.js:21-34`, `src/avatar/handler.js`; test `handler: "av @user" replies with the avatar card` (`test/avatar.test.js`). | Reuse |
| Profile picture command | WORKING | Same avatar feature handles `pfp`, `profile pic`, and `profile picture`: `src/avatar/avatar.js:21-34`; test `every keyword works, in any case`. | Reuse |
| User information | WORKING | `get_member_info` returns display name, ID and join date: `src/tools/router.js:394-398`; test `member information returns display name, ID, and join date` (`test/utilities.test.js:54`). | Reuse |
| Server information | WORKING | `get_server_info` returns member/channel counts and creation time: `src/tools/router.js:391-393`; test `read-only info action works without owner authorization` (`test/router.test.js`). | Reuse |
| Banner information | WORKING | `get_member_profile` fetches the member's banner URL and reports absent/failed lookups: `src/tools/router.js:400-423`; tests `member profile includes account creation date and fetched banner URL`, `member profile reports when no banner is set`, and `member profile reports banner lookup failures explicitly` (`test/utilities.test.js:74,97,106`). | Reuse |
| Bot information | WORKING | `get_bot_info` reports bot identity, uptime, guild count, and gateway ping: `src/tools/router.js:433-442`; tests `bot information reports identity, uptime, server count, and gateway ping` and `intent schema exposes the new utility actions` (`test/utilities.test.js:127,137`). | Reuse |
| Member join date | WORKING | `get_member_info` renders the exact Discord `joinedTimestamp`: `src/tools/router.js:394-398`; test `member join date uses the exact Discord joined timestamp` (`test/utilities.test.js:65`). | Reuse |
| Account creation date | WORKING | `get_member_profile` renders the Discord account creation timestamp: `src/tools/router.js:404-423`; test `member profile includes account creation date and fetched banner URL` (`test/utilities.test.js:74`). | Reuse |
| Permissions information | WORKING | `get_member_permissions` reports effective guild permissions without granting actions: `src/tools/router.js:424-432`; test `member permissions reports effective server permissions` (`test/utilities.test.js:117`). | Reuse |
| Custom utility commands | WORKING | Optional per-guild `utility_commands` config defaults empty, is validated/persisted, and runs on the existing message listener: `dashboard/lib/shared/defaults.js:72`, `dashboard/lib/shared/validate.js:132-180,241,350`, `src/utilities/customCommands.js`, `src/index.js:677`; tests `custom utility commands default to none and validate unique safe names and bounded replies`, `configured custom utility commands respond only to exact prefix invocations without pinging`, and `custom utility commands use the existing message listener after AFK and avatar handling` (`test/utilityCommandConfig.test.js:7`, `test/utilities.test.js:167,186`). | Reuse |

## F. Tickets and Support

| Feature | Status | Proof | Action |
|---|---|---|---|
| Ticket creation | WORKING | `/ticket` has the requested seven subcommands (`src/slash.js:187-204`); category selection creates a private guild-scoped channel and record (`src/tickets/commands.js:275-340`, `src/tickets/store.js:53-89`); test `opening a ticket creates a private category channel and enforces one open ticket per user/category` (`test/ticketing.test.js:278`). | Reuse |
| Ticket categories | WORKING | Guild-owned categories are configurable and default empty/off (`dashboard/lib/shared/defaults.js:73-77`, `dashboard/lib/shared/validate.js:242-292`); panel and picker expose the configured category menu (`src/tickets/commands.js:211-272`); tests `ticket settings default off and validate guild-owned categories, staff roles, senior role, and log channel`, `ticket panels require Manage Server, show an Open ticket button, then offer configured categories ephemerally` (`test/ticketing.test.js:225,256`). | Reuse |
| Ticket claiming | WORKING | Staff claim uses guild-scoped atomic `claimed_by is null` update (`src/tickets/commands.js:382-395`, `src/tickets/store.js:109-124`); tests `claiming stores the staff member and returns validated AI classification, summary, and suggestion`, `a ticket claim lost to a concurrent staff member is not overwritten`, `ticket claiming atomically updates only an unclaimed ticket in its guild` (`test/ticketing.test.js:333,389,505`). | Reuse |
| Ticket closing | WORKING | Opener/staff close transition, transcript delivery, persisted closed state and 10-second channel deletion (`src/tickets/commands.js:506-550`); test `closing creates a text transcript, sends it to the log and opener with rating buttons, then deletes in 10 seconds` (`test/ticketing.test.js:434`). | Reuse |
| Ticket transcripts | WORKING | Transcript generation escapes mentions/control characters and sorts messages; sends `.txt` attachments to log channel and opener (`src/tickets/commands.js:47-64,516-529`); tests `transcript preserves chronological order and escapes mentions/control characters`, `closing creates a text transcript, sends it to the log and opener with rating buttons, then deletes in 10 seconds` (`test/ticketing.test.js:434,471`). | Reuse |
| Ticket ratings | WORKING | Closed tickets DM five rating buttons; opener-only, one-time 1–5 ratings are persisted with guild scope (`src/tickets/commands.js:494-503,582-609`, `src/tickets/store.js:148-166`); test `ratings are 1-5, opener-only, one-time, and persisted in guild scope` (`test/ticketing.test.js:454`). | Reuse |
| Staff permissions | WORKING | Configured staff roles, actor/bot permissions and role hierarchy are checked before actions; ticket reads/writes include `guild_id` (`src/tickets/commands.js:121-169,382-457`, `src/tickets/store.js:91-166`); tests `opening tickets refuses missing ManageChannels, unconfigured categories, and unsafe configured role hierarchy`, `staff-only actions require a configured staff role and every denied ticket action is audited`, `staff can add and remove members only below the bot role, with the change audited`, `Supabase ticket reads and writes always constrain guild_id and database migration has RLS plus one-open uniqueness` (`test/ticketing.test.js:293,313,398,481`). | Reuse |
| Ticket priority | WORKING | Staff-only priority accepts only low/normal/high/urgent and persists the value (`src/tickets/commands.js:473-481`, `src/tickets/store.js:127-136`); test `priority accepts only low/normal/high/urgent and escalation pings only the configured senior role` (`test/ticketing.test.js:417`). | Reuse |
| Ticket escalation | WORKING | Staff escalation pings only the configured senior role with restricted allowed mentions (`src/tickets/commands.js:483-491`); test `priority accepts only low/normal/high/urgent and escalation pings only the configured senior role` (`test/ticketing.test.js:417`). | Reuse |
| AI ticket classification | WORKING | Ticket content is wrapped as untrusted user data; output must be exact JSON with an allowed classification before being shown to staff (`src/tickets/commands.js:17-30,351-379`); tests `claiming stores the staff member and returns validated AI classification, summary, and suggestion`, `ticket prompt injection stays in the untrusted user-data wrapper, not the system prompt`, `AI advice is strict and invalid AI JSON is rejected`, `AI provider failure does not block claiming or the normal ticket workflow` (`test/ticketing.test.js:333,356,370,379`). | Reuse |
| AI summaries | WORKING | Validated AI summary is persisted on the ticket and shown ephemerally to staff only (`src/tickets/commands.js:351-379,382-405`); tests `claiming stores the staff member and returns validated AI classification, summary, and suggestion`, `AI provider failure does not block claiming or the normal ticket workflow` (`test/ticketing.test.js:333,379`). | Reuse |
| AI suggested replies | WORKING | Validated advisory reply is persisted and returned privately to configured staff; provider failure leaves ticket workflow available (`src/tickets/commands.js:17-30,351-405`); tests `claiming stores the staff member and returns validated AI classification, summary, and suggestion`, `AI advice is strict and invalid AI JSON is rejected`, `AI provider failure does not block claiming or the normal ticket workflow` (`test/ticketing.test.js:333,370,379`). | Reuse |

## G. Community Engagement

All Section G features are off by default and enabled per server in the dashboard (Add-ons → Engagement, `feature_settings.engagement`). Coins are virtual only: no purchase, cash-out or betting. Member records are guild-scoped in `zb_feature_records` (kind `member`), changed only through versioned `mutate`. Tests: `test/section-g-engagement.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| XP system | WORKING | 15-25 XP per message, 60 s cooldown (also across workers), none in ignored channels or for bots, from the existing message listener: `src/features/engagement.js` (`onMessage`); tests `XP: 15-25 per message, once a minute, not in ignored channels, level-up announced once`, `XP cooldown holds across two workers (no double count)`. | Done (Section G) |
| Leveling | WORKING | Level formula 5*l^2+50*l+100 (`src/features/engagementRules.js`); level-ups announced in the configured channel; test `level formula 5l²+50l+100, with exact level boundaries`. | Done (Section G) |
| Rank cards | WORKING | `/level rank` with an `@napi-rs/canvas` image (`src/features/rankCard.js`); test `rank card and paginated leaderboard`. | Done (Section G) |
| Leaderboards | WORKING | `/level leaderboard` paginated by 10; same test. | Done (Section G) |
| Daily rewards | WORKING | `/eco daily`, 24 h cooldown, streak kept within 48 h; test `daily: once per 24 h, streak grows within 48 h and resets after, achievements unlock`. | Done (Section G) |
| Achievements | WORKING | Level, message and streak milestones (`ACHIEVEMENTS` in `src/features/engagementRules.js`), `/eco achievements`; daily test above. | Done (Section G) |
| Virtual currency | WORKING | Virtual coins with a cap, no real value; `/eco balance`; tests `shop: ...`, `concurrent purchases never spend coins twice`. | Done (Section G) |
| Inventory | WORKING | `/eco inventory`; test `shop: buying needs enough coins, adds to the inventory, and never hands out a staff role`. | Done (Section G) |
| Collectibles | WORKING | Admin-defined shop items (max 25, optional safe role) as collectibles; same shop test. | Done (Section G) |
| Trading | WORKING | `/eco trade` + Accept/Decline buttons: only the other member accepts, claimed once, 5-minute expiry, both sides checked and moved together or refunded; tests `trading: only the other member can accept, both sides move together, or nothing moves`, `trading: a side that can no longer pay rolls everything back; offers expire`. | Done (Section G) |
| Games | WORKING | `/games coinflip` and `/games rps`, no betting; test `coinflip and rps answer without betting anything`. | Done (Section G) |
| Trivia | WORKING | `/games trivia`: 25-question bank, 30 s, one answer per member, first right answer wins virtual coins; tests `trivia: one answer per member, first right answer wins virtual coins, late clicks refused`, `trivia rounds keep the right answer findable after shuffling; rps rules`. | Done (Section G) |
| Polls | WORKING | Implemented once in Section C (`/community poll`, Discord native polls), as the matrix asked; test `polls, announcements and reminders are staff-only and never ping` (`test/section-c-community.test.js`). | Done (Section G) |
| Giveaways | WORKING | `/giveaway start|end|reroll` (Manage Server): Enter button, optional required role, end time on the persistent scheduler, fair crypto draw, reroll excludes previous winners; test `giveaways: staff only, required role, toggle entry, ends on schedule after a restart, reroll excludes winners`. | Done (Section G) |
| Events | WORKING | Discord scheduled events via `/automation event-create|events` (Section J) and tournament sign-up lists; tests in `test/section-j-automation.test.js` and `tournaments: ...`. | Done (Section G) |
| Tournaments | WORKING | `/tournament create|start|win|show`: sign-ups to a cap, single-elimination bracket for 2-32 players with byes, champion; tests `tournaments: sign-ups to the cap, bracket on start, winners advance to a champion`, `brackets: 2-32 players, ...`. | Done (Section G) |

## H. Music and Voice

Existing music is untouched. Section H added temporary voice channels (Add-ons → Voice, `feature_settings.voice`, off by default), hooked at the top of the existing `VoiceStateUpdate` listener before the music early-return. No new music sources were added, so nothing here touches platform ToS. Tests: `test/section-h-tempvoice.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| Music playback | WORKING (UNTESTED) | `src/music/player.js`, `src/music/sources.js`, `src/voice/voiceManager.js`; unit tests cover source validation/fallback, not a live Discord voice session (`test/music.test.js`: `music queue accepts HTTPS sources and rejects other protocols`). | Add tests |
| Play and pause | WORKING (UNTESTED) | `/play` and `/pause` definitions (`src/slash.js:59-71`) route to `src/tools/router.js:424-455`; tests exercise routing (`voice path allows playback and info commands`) but not a live player session. | Add tests |
| Skip | WORKING (UNTESTED) | `/skip` and `skip_music` route: `src/slash.js:72`, `src/tools/router.js:443-455`; same routing test, no live playback verification. | Add tests |
| Queue | WORKING | Queue operations: `src/music/player.js`; test `queues are isolated per server; shuffle, remove and clear work` (`test/music.test.js`). | Reuse |
| Shuffle | WORKING | Queue shuffle: `src/music/player.js`; test `queues are isolated per server; shuffle, remove and clear work`. | Reuse |
| Loop | WORKING | Track/queue/off modes: `src/music/player.js`; test `loop cycles off -> song -> queue -> off and rejects bad modes`. | Reuse |
| Volume | WORKING | Bounded volume and per-server defaults: `src/music/player.js`; tests `music volume is bounded`, `per-server default volume applies only at the start of a session`. | Reuse |
| Now playing | WORKING (UNTESTED) | `/nowplaying` route and player state: `src/slash.js:75`, `src/tools/router.js:471-486`; no focused current-track command test found. | Add tests |
| Temporary voice channels | WORKING | "Join to create" hub creates `{user}'s channel` next to it, moves the member in and makes them owner; deleted when the last person leaves; a scheduler sweep removes channels that emptied while the bot was down; one per member, 50 per server, 10 s create cooldown, needs Manage Channels + Move Members: `src/features/tempVoice.js`; tests `joining the hub creates a channel ...`, `the channel is deleted when the last person leaves ...`, `a channel left empty while the bot was down is cleaned up by the sweep`, `no channels without the bot permissions, when switched off, or for hub-hopping spam`. | Done (Section H) |
| Voice permissions | WORKING | Existing DJ/request-channel rules unchanged; temporary channels get owner ACLs and `/tempvoice lock|unlock|limit|rename|permit|reject|claim`, owner-only, audited; test `/tempvoice: only the owner controls the channel; claim works only once the owner left`. | Done (Section H) |
| Voice activity features | PARTIAL | Existing music pause/resume on empty channel unchanged; temporary channels react to joins and leaves (`src/features/tempVoice.js`). Voice-time analytics are not collected (Section L stores message/member aggregates only). | PARTIAL |

## I. Social Media Integration

Section I is off by default (Add-ons → Social, `feature_settings.social`), polled on the shared scheduler at most every `poll_minutes` (minimum 5). User-supplied feed URLs go through an SSRF-safe fetcher (`src/features/net.js`): https only, connect-time address check (blocks private/loopback/link-local/metadata, including DNS rebinding), every redirect re-checked, 10 s timeout, 1 MB cap. New env vars: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` (in `.env.example`). Tests: `test/section-i-social.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| YouTube notifications | WORKING | New-upload notices from the channel's public RSS feed (`feedUrl` type `youtube`, no Data API quota); the existing live-chat module is unchanged and still handles live streams; tests `RSS and Atom parsing: titles decoded, only https links kept`, `feeds: the first poll posts nothing, then only new items, oldest first, at most 3, never pinging`. | Done (Section I) |
| Twitch notifications | WORKING | Official Helix API with client-credentials token (`createTwitchApi`), one alert per stream id, optional configured role ping only; first check (online or offline) records state without alerting; tests `Twitch: one alert per stream, with the configured role ping only, and none on the first check`, `Twitch API client: client-credentials token reused until expiry, official Helix endpoint only`. Live Twitch credentials were not available: NOT VERIFIED against the real API. | Done (Section I) |
| Kick notifications | BLOCKED | Kick has no official free public API for third-party stream notifications; scraping would break their terms. | BLOCKED |
| RSS feeds | WORKING | Up to 10 feeds per server (RSS 2.0 and Atom), SSRF-safe fetch, first poll seeds without posting, max 3 new items per poll, no pings; tests `SSRF: ...` (5 tests), `feeds: ...`, `feeds respect the poll interval (minimum 5 minutes) and survive a failing feed`. | Done (Section I) |
| Reddit feeds | WORKING | Subreddit's public RSS feed (`https://www.reddit.com/r/<name>/new/.rss`), name validated; same feed tests. Not verified against live Reddit (network not used in tests). | Done (Section I) |
| Supported X integrations | BLOCKED | X's API has no free tier for reading posts or streaming notifications; no official free API. | BLOCKED |
| Supported Instagram integrations | BLOCKED | Instagram's Graph API only serves business/creator accounts the app owner manages, after Meta app review; no official free API for following arbitrary accounts. | BLOCKED |
| Creator notifications | WORKING | Multi-creator subscriptions per server: YouTube uploads, Twitch live, Reddit and RSS, each to its own channel; same tests. | Done (Section I) |
| Scheduled announcements | WORKING | Provided once by Section J scheduled messages (`src/features/automation.js`), as instructed (no duplicate scheduler); test `scheduled messages post once per interval, survive a restart, and never ping` (`test/section-j-automation.test.js`). | Done (Section I) |

## J. Automation

All Section J features are off by default and enabled per server in the dashboard (Add-ons → Automation, `feature_settings.automation`). They share the one persistent scheduler from Section C (`src/features/scheduler.js`). No new table: records go in `zb_feature_records` (migration `20261114000000_zigbot_features_community.sql`).

| Feature | Status | Proof | Action |
|---|---|---|---|
| Scheduled messages | WORKING | Dashboard list (max 10) of channel + message + interval, posted by the shared scheduler and claimed per interval through a versioned record, so a restart or a second worker never double-posts: `src/features/automation.js` (`runScheduled`, `claimInterval`); test `scheduled messages post once per interval, survive a restart, and never ping` (`test/section-j-automation.test.js`). Scheduled greetings unchanged. | Done (Section J) |
| Custom commands | WORKING | Reused from Section E as instructed (no duplicate): per-guild `utility_commands` in `src/utilities/customCommands.js`; tests `custom utility commands default to none and validate unique safe names and bounded replies`, `configured custom utility commands respond only to exact prefix invocations without pinging` (`test/utilityCommandConfig.test.js`, `test/utilities.test.js`). | Done (Section J) |
| Auto-purge | WORKING | Per-channel age cutoff and interval (max 5 channels); pinned and 14-day-old messages are kept (Discord bulk-delete limit); needs Manage Messages, audited: `src/features/automation.js`; test `auto-purge deletes only unpinned messages older than the cutoff and younger than 14 days`. | Done (Section J) |
| Auto-role rules | WORKING | Join auto-role reused from Section C (`src/features/community.js`), plus conditional role rules (WHEN join/message/reaction THEN add/remove role) that refuse staff, managed and above-bot roles; tests `welcome: message with the member tagged once, image card, auto-role (bots skipped), milestone once` (Section C), `rules never touch staff roles, never react to bots, and are rate-limited against floods`. | Done (Section J) |
| Scheduled events | WORKING | `/automation event-create` creates a Discord scheduled event (external, guild-only) when both the member and the bot have Manage Events; `/automation events` lists them: `src/features/automation.js`; test `/automation event-create needs Manage Events from both sides; /automation events lists them`. | Done (Section J) |
| Reminders | WORKING | Personal `/automation remind` (pings only the asker, max 10 waiting per member) and staff `/community remind` (Section C), both on the persistent scheduler; tests `/automation remind: only pings the member, max 10 waiting per member, survives a restart`, `reminder: stored, posted when due (also after a restart), and dropped if the feature was switched off`. | Done (Section J) |
| Automatic announcements | WORKING | Recurring announcements are scheduled messages with an interval; staff one-off announcements are `/community announce` (Section C). Same tests as scheduled messages and Section C announcements. | Done (Section J) |
| Workflow builder | WORKING | Dashboard form (no drag-and-drop, as instructed): Add-ons → Automation renders the rule list from the same field schema the server validates with (`dashboard/components/AddonsTab.js`, `dashboard/lib/shared/features.js`); test `settings: automation is off by default and its lists are validated entry by entry`. The form itself was built (`next build`) but not exercised in a browser test. | Done (Section J) |
| Trigger-based automation | WORKING | Rules WHEN join / message keyword / reaction run from the existing listeners (`src/index.js` → `features.onMessage`, `onMemberAdd`, `onReaction`), max 25 per server, 10 s per-rule per-channel cooldown, bots ignored: `src/features/automation.js`; tests `rules: WHEN join / message / reaction, IF role and channel, THEN message or role`, `src/index.js forwards messages to features inside the existing message listener, after the channel checks`. | Done (Section J) |
| Conditional automation | WORKING | IF member has role / IF in channel (or its parent) conditions on every rule; same rules test. | Done (Section J) |

## K. Dashboard and SaaS

| Feature | Status | Proof | Action |
|---|---|---|---|
| Discord OAuth2 | WORKING | Supabase Auth Discord identity and session verification: `dashboard/lib/auth.js:12-28`; test `Discord id comes only from Supabase identities, never editable user_metadata` (`test/dashboardAccess.test.js`). | Reuse |
| Server selection | WORKING | Authenticated user guild list and access decision: `dashboard/lib/discord.js` (`getUserGuilds`), `dashboard/lib/auth.js:33-53`; test `access decision: managers allowed, helpers and strangers denied, bot-missing reported`. | Reuse |
| Multi-server management | WORKING | Guild-scoped config and context: `src/guildConfig/store.js`, `dashboard/app/dashboard/[guildId]/page.js`; tests `store: each server gets its own config; changing A never affects B`, `authorization: a context for another guild is never honoured (no cross-server leakage)`. | Reuse |
| Moderation configuration | PARTIAL | Anti-Nuke settings UI/route exists (`dashboard/components/AntiNukeTab.js`, `dashboard/app/api/guilds/[guildId]/antinuke/route.js`); no general Discord AutoMod/word-filter configuration. Test `dashboard validation: real ids only, sane thresholds, no switch that stops monitoring` (`test/antinuke.test.js`). | Improve |
| Security configuration | WORKING | Per-guild Anti-Nuke settings, statuses and events: `dashboard/components/AntiNukeTab.js:62-86`, `dashboard/app/api/guilds/[guildId]/antinuke/route.js:46-103`; tests `settings persist, survive a restart, and bad stored values fall back safely`, `dashboard validation: real ids only, sane thresholds, no switch that stops monitoring`. | Reuse |
| AI configuration | WORKING | Guild editor configures custom prompts, instructions and rules: `dashboard/components/GuildEditor.js:436-438`; test `reply prompt: legacy path unchanged, multi path layered and identity-safe` (`test/multiServerBot.test.js`). | Reuse |
| Role management | PARTIAL | Dashboard fetches assignable roles and configures role mappings (`dashboard/lib/discord.js:59-68`, `dashboard/components/GuildEditor.js`); does not create/delete Discord roles. Test `bad voice and setup values are rejected` is unrelated; no direct role-editor integration test found. | Improve |
| Ticket management | MISSING | Ticket-term repository search found no ticket workflow, dashboard page/API or schema. | Implement |
| Giveaway management | MISSING | Search `giveaway|winner selection` across `src/`, `dashboard/`, `supabase/`, `test/`: no giveaway page/API/schema found. | Implement |
| Analytics | PARTIAL | Admin SaaS analytics are available (`dashboard/app/admin/analytics/page.js`, `dashboard/lib/adminData.js:53-99`); no guild member/message analytics suite. | Improve |
| Audit logs | WORKING | Anti-Nuke event history and guild configuration audit routes: `dashboard/app/api/guilds/[guildId]/audit/route.js`, `dashboard/lib/adminData.js:318-351`; tests `an incident is recorded, alerted, and falls back to an owner DM when no channel works`, `the admin audit log is append-only, even for the service role; browsers get nothing`. | Reuse |
| Subscription management | WORKING | Per-guild Razorpay checkout/sync/cancel/verify routes and UI: `dashboard/app/api/guilds/[guildId]/billing/`, `dashboard/components/GuildEditor.js`; tests in `test/premium.test.js`, `test/purchaseThanks.test.js`. | Reuse |
| Premium feature management | WORKING | Shared plan/feature gates: `dashboard/lib/shared/premium.js`, `dashboard/lib/shared/resolve.js`; tests `free plan: custom persona is ignored and only the top role mappings apply`, `free plan: voice and music are off even if a role mapping allows them` (`test/premium.test.js`). | Reuse |
| Staff permissions | PARTIAL | Guild admin requests verify Discord owner/Admin/Manage Server (`dashboard/lib/auth.js:33-53`); no configurable staff permission matrix. Test `access decision: managers allowed, helpers and strangers denied`. | Improve |
| Health monitoring | PARTIAL | Dashboard API health route and Anti-Nuke permission/status reporting exist (`dashboard/app/api/health/route.js`, `src/antinuke/monitor.js:167-178`); not a complete service/dependency monitor. | Improve |

## L. Analytics

Section L is off by default (Add-ons → Analytics). It stores only aggregated daily counts per server (`zb_feature_records`, kind `analytics`, key = the day in the server timezone), never message content or member ids; distinct active members are counted in memory and only the number is saved. Records older than 400 days are deleted. Dashboard: 📊 Analytics tab (SVG charts) and `GET /api/guilds/[guildId]/analytics` (JSON or `format=csv`, admin-verified). Tests: `test/section-l-analytics.test.js`.

| Feature | Status | Proof | Action |
|---|---|---|---|
| Member growth | WORKING | Daily joins/leaves and net growth from the existing member listeners; tests `daily counts: messages per channel, joins, leaves, distinct active members; never content or ids`, `summary maths: net growth, leave rate, busiest channels`. | Done (Section L) |
| Active members | WORKING | Distinct active members per day as a count only (lower bound if the bot restarts mid-day); same daily-counts test and `counts add up across flushes, active members never go down, and two workers do not double count`. | Done (Section L) |
| Message activity | WORKING | Messages per day, counted first thing in the existing message listener (`features.observeMessage`), bots excluded; tests above and `src/index.js counts messages first thing in the existing message listener`. | Done (Section L) |
| Channel activity | WORKING | Messages per channel per day (threads count to their parent, max 200 channels/day), busiest channels in summaries, CSV and charts; daily-counts test. | Done (Section L) |
| Retention | PARTIAL | Leave rate (leaves / joins) and net growth over a period are reported; true cohort retention would need stored member ids, which this section deliberately does not keep. | PARTIAL |
| Join and leave statistics | WORKING | Daily joins and leaves, with totals, net and leave rate in `/analytics summary`, CSV and charts; tests above. | Done (Section L) |
| Moderation statistics | WORKING | Daily moderation case count read from the existing case store (`brain.listModerationCases`) at an hourly snapshot; daily-counts test (`moderation` field). | Done (Section L) |
| Security statistics | WORKING | Daily security incident count from the existing security integration (`getIncidents`) at the snapshot, plus the unchanged Anti-Nuke API counts; daily-counts test (`security` field). | Done (Section L) |
| Ticket statistics | WORKING | Daily tickets opened via a new read-only, guild-scoped `SupabaseTicketStore.countTicketsSince`; tests `ticket counting is guild-scoped and read-only`, daily-counts test (`tickets` field). | Done (Section L) |
| Event participation | WORKING | Daily participants of giveaways and tournaments (Section G records) as a count; snapshot in `src/features/analytics.js`, included in summaries and CSV. | Done (Section L) |
| AI-generated reports | WORKING | `/analytics report` (Manage Server): the existing provider gets aggregate numbers only (no content, ids or channel ids) in the untrusted-data wrapper; output cleaned of pings; exact numbers shown even if the AI fails; test `/analytics: off says so, needs Manage Server, AI report gets aggregates only`. | Done (Section L) |
| CSV export | WORKING | Community analytics CSV from the dashboard (`format=csv`), using the existing formula-injection-safe `toCsv`; test `CSV export: numbers only, oldest first, formula-safe; bad rows ignored`. | Done (Section L) |

## M. Developer Tools

| Feature | Status | Proof | Action |
|---|---|---|---|
| Bot health | WORKING (UNTESTED) | `src/health.js:3-9` exposes a plain liveness response; it does not probe Discord/database dependencies. No direct health test found. | Add tests |
| API health | WORKING (UNTESTED) | Dashboard has `dashboard/app/api/health/route.js`; no focused endpoint health test found. | Add tests |
| Database health | PARTIAL | Mongo memory status is exposed in `src/tools/router.js:615-650`; dashboard admin overview reports data-source errors (`dashboard/lib/adminData.js:53-99`). No unified readiness endpoint. | Improve |
| Worker health | MISSING | Search `worker health|worker status|scheduler health|queue health` across `src/`, `dashboard/`, `supabase/`, `test/`: no health registry for background workers found. | Implement |
| Shard monitoring where applicable | BLOCKED | No `ShardingManager`/cluster integration found; current `src/index.js` creates one Discord client. Shard state is not applicable until deployment is sharded. | Skip (blocked) |
| Error reporting | PARTIAL | Runtime errors are written to `console` and audit logs, e.g. `src/index.js`, `src/antinuke/monitor.js`; no external error reporting/aggregation service found. | Improve |
| Debug logging | PARTIAL | Prefixed `console.log/error` calls exist; no configurable structured debug logger. `src/antinuke/monitor.js:33-35`. | Improve |
| Feature flags | WORKING | Environment/config flags include `SECURITY_ENABLED`, memory summaries, custom identity, and guild feature gates: `src/config/settings.js:149-164`; test `security settings load the emergency switch, command role and AI rate window` (`test/settingsProviders.test.js`). | Reuse |
| Configuration import/export | MISSING | Search `config(uration)?.*(import|export)|settings export|settings import` across `src/`, `dashboard/`, `supabase/`, `test/`: memory and admin-data exports exist, but no guild configuration import/export. | Implement |
| Backup and recovery | MISSING | Search `backup|restore database|recovery snapshot` across `src/`, `dashboard/`, `supabase/`, `test/`: no database backup/recovery workflow found. | Implement |
| Maintenance mode | MISSING | Search `maintenance mode|maintenanceMode|read.only mode` across `src/`, `dashboard/`, `supabase/`, `test/`: no operational maintenance switch found. | Implement |
| Emergency shutdown | MISSING | Search `emergency shutdown|graceful shutdown|SIGTERM|client.destroy` across `src/`, `dashboard/`, `test/`: no controlled operator shutdown command/workflow found. | Implement |

## Verification notes

- `WORKING` labels above name the direct tests in their proof cells. `WORKING
  (UNTESTED)` identifies implemented code for which repository tests do not
  exercise the advertised operation end-to-end.
- OAuth, Discord gateway behavior, provider availability, YouTube API quota,
  actual voice streaming, and deployed Supabase migrations were not exercised
  against production credentials/services by this audit.
- Feature references intentionally describe the current workspace, including
  its pre-existing uncommitted changes. This audit added only this matrix file.
- `npm test` was run once after matrix creation: 848 tests, 847 passed, 0
  failed, 1 skipped; process exit code 0.
