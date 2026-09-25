# ZiGBoT — The Bot Brain

## 🧠 What is the "Brain"?

The **brain** (`src/db/brain.js`) is ZiGBoT's persistent memory — the single MongoDB-backed module that remembers things about members across restarts. Everything the bot needs to *recall* (user profiles, warning history, long-term conversational memories, sequence counters) flows through this one file. The rest of the codebase is strictly forbidden from talking to MongoDB anywhere else.

```
Discord events → tools/router.js ─┐
AI replies (src/index.js) ────────┼→ db/brain.js → MongoDB Atlas
memory diagnostics (/memory) ─────┘        └─ db: zigbot
```

---

## 1. Why MongoDB? (The backstory)

The brain used to run on **better-sqlite3**. Two problems killed it:

1. **Native binary crashes** — its compiled binary crashed on Render's Node ABI, taking the bot down with it.
2. **Ephemeral disk** — Render's free tier wipes the on-disk file on every restart, so warnings vanished anyway.

MongoDB Atlas (free M0 tier) solves both: no native compilation, and the data lives off-box. The trade-off was rewriting every synchronous SQLite call as async — the old `WarnStore` API's semantics (ids, ordering, fields) were preserved exactly.

---

## 2. Collections (the schema)

The data shape mirrors the old SQLite schema one-to-one. All collections live in the `zigbot` database.

| Collection | Document shape | Purpose |
|---|---|---|
| `users` | `{ userId (unique), warnings: [], xp: 0, notes: {} }` | Per-user profile: XP tracking, warn references, free-form notes |
| `warnings` | `{ id, guildId, userId, reason, issued_by, created_at }` | Full warning records with moderator attribution |
| `counters` | `{ _id: 'warning_id' \| 'memory_id', seq }` | Atomic sequence generator replacing SQLite's AUTOINCREMENT |
| `memories` | `{ id, guildId, userId, content, type, created_at }` | **Persistent long-term memory** — durable facts/preferences about a user, per guild, surviving restarts |

### Indexes (created at connect time)

| Collection | Index | Why |
|---|---|---|
| `users` | `{ userId: 1 }` **unique** | One profile per user, enforced by the DB |
| `warnings` | `{ guildId: 1, userId: 1, created_at: 1 }` | Same lookup pattern as the old `idx_warnings_guild_user` SQLite index |
| `memories` | `{ guildId: 1, userId: 1, created_at: -1 }` | Memory recall: newest-first per user per guild |

`connectBrain()` publishes module state **only after** the connection and every index build succeed — a failed connect can never leave half-initialized collections behind.

---

## 3. API surface

This is the *entire* persistence contract of the bot:

| Function | What it does |
|---|---|
| `connectBrain(uri, opts?)` | Connects from `MONGODB_URI`, wires up collections + indexes. Accepts an injected client for tests. Throws without a URI. |
| `getUser(userId)` | Fetches a profile, or returns a fresh default (`warnings: [], xp: 0, notes: {}`) if none exists. |
| `updateUser(userId, patch)` | `$set` patch with upsert — creates the profile on first touch. |
| `addWarning(guildId, userId, reason, issuedBy)` | Atomically increments the counter, inserts the record, returns `{ id, reason, issuedBy }`. Missing reasons become *"No reason provided"*. |
| `listWarnings(guildId, userId)` | Warnings for a member in one guild, sorted oldest-first. |
| `countWarnings(guildId, userId)` | Fast count for escalation thresholds. |
| `remember(guildId, userId, content, type)` | Persists a long-term memory (`fact` \| `preference` \| `event` \| `context`, max 500 chars). **Refuses passwords, API keys, tokens, and credentials outright.** |
| `recall(guildId, userId, limit)` | Newest memories for a user in a guild (default 5, max 20), returned oldest-first so the AI reads them like a timeline. |
| `countMemories(guildId, userId)` | Count of stored memories, for diagnostics. |
| `deleteMemoryById` / `deleteAllMemories` | Delete one / all of a user's memories; returns the REAL deleted count. |
| `isMemoryAvailable()` | True only when the `memories` handle exists (post-connect). |
| `getMemoryCapabilities()` | The runtime capability object — see §6. |
| `getMemoryStatus()` | Capabilities + `connected`, `collection`, and `lastError` for honest diagnostics. |

Every data function calls `requireBrain()` first — using the brain before `connectBrain()` throws a clear error instead of returning garbage.

---

## 4. How the AI uses the memory layer

- **Before every reply:** `recall()` fetches that user's memories (per guild) and they are injected into the system prompt as **ground truth**, together with the live capability object. If retrieval fails, the prompt says so — the AI never guesses.
- **After a reply:** `shouldRemember()` (in `src/ai/client.js`) picks only durable signals to save — explicit requests ("remember that…"), identity facts ("my name is…", "I live in…"), and preferences ("I love…"). Commands, questions, and transient states are **never** saved blindly.
- **Transparency:** questions like *"What do you remember?"* or *"Do you have persistent memory?"* are answered **deterministically from live MongoDB data** — no LLM fabrication possible. The answer enumerates exactly what is stored, or truthfully says nothing is.
- **Never fake memory:** the AI is prompted (and architecturally constrained) to never claim a memory that is not in the database, never deny memory when it exists, and never announce a save or deletion that did not actually happen. Failed operations are recorded in `lastMemoryError` and reported as failures.

---

## 5. Memory commands & security

| Command | Who | What |
|---|---|---|
| `memory_status` (text intent, `/memory`) | **Owner/admin only** | Live diagnostics: Mongo connected, collection available, retrieval/writes enabled, per-user memory count, last error — all read from real runtime state |
| `forget_memory` | Anyone (self) / admin (others) | Deletes stored memories and reports the true deleted count — including the honest *"nothing was deleted"* case |

Connection strings and credentials are never exposed: the status output contains booleans, counts, and error messages only.

---

## 6. Truthful runtime capability object

`getMemoryCapabilities()` returns values derived from the REAL state (never hard-coded prompt claims):

```js
{
  persistentMemory: true,        // memories collection handle exists
  memoryDatabase: "MongoDB",
  conversationMemory: true,      // in-process sliding window (ai/memory.js)
  memoryRetrieval: true,         // recall() wired into the reply path
  memoryWrite: true              // selective saves enabled
}
```

When MongoDB is down: `persistentMemory/memoryRetrieval/memoryWrite` flip to `false`, the AI is told memory is *temporarily unavailable* (so it stops claiming to remember), saves are skipped with a logged error, and the rest of the bot keeps functioning.

---

## 7. Design rules

- **Single point of access.** No other module may create a Mongo client or query a collection. This keeps the schema auditable in one file and makes the module trivially testable (tests inject a fake client).
- **Fail loudly, fail early.** `connectBrain()` is required at startup: if it fails, the bot exits rather than running in a broken state where warns and memories silently disappear.
- **Atomic ids.** Warning and memory ids come from `findOneAndUpdate` + `$inc` on the `counters` collection — safe under concurrency.
- **Guild-scoped queries.** Warnings and memories are always filtered by both `guildId` and `userId` — data never leaks across servers or users.
- **Secrets never stored.** `remember()` refuses credential-shaped content before it ever reaches the database.
- **Everything else stays in-process.** Conversation memory and music queues intentionally reset on restart; only warns and long-term memories persist.
- **Truth over comfort.** The bot's memory claims must always match its actual MongoDB state — enforced by the capability object, deterministic answers, and the test suite (`test/memory.test.js`).
