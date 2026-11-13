# ZiGBoT Studio: feature matrix

Status: WORKING (a named test exercises it), PARTIAL, MISSING, NOT AVAILABLE (needs infrastructure that does not exist), BLOCKED (external reason). Updated at every phase checkpoint.

## Phase 1: Audit and foundation

| Feature | Status | Proof |
|---|---|---|
| Repository audit | WORKING | `docs/ZIGBOT_STUDIO_AUDIT.md` |
| Reuse existing Discord login | WORKING | Studio routes call `requireStudioUser()` → `requireUser()` (`dashboard/lib/studio/server.js`); test `every Studio API route uses the existing login and filters by the session owner` |
| Project storage with owner-only access | WORKING | `supabase/migrations/20261115000000_studio_projects.sql` (RLS `owner_id = auth.uid()`); tests `IDOR: user B cannot read, change or delete user A's project; anon sees nothing`, `a user cannot move their project to someone else` |
| Create project | WORKING | `POST /api/studio/projects`; owner from the session only; test `new project: valid wizard input becomes a clean row; owner_id never comes from the request` |
| Rename / archive / unarchive | WORKING | `PATCH /api/studio/projects/[id]` (only name, description, status, visibility); test `patches: only name, description, status and visibility can change` |
| Duplicate | WORKING | `POST /api/studio/projects/[id]/duplicate`, counts towards the limit; test `duplicate names: "copy", then numbered, within 40 characters` |
| Delete with confirmation | WORKING | `DELETE /api/studio/projects/[id]` requires the exact project name; UI asks for it (`components/studio/StudioProjects.js`) |
| 5-step creation wizard | WORKING | `components/studio/StudioWizard.js` (identity, framework, template, Discord application guidance, create), same validation as the server; test `the wizard has the 5 steps; frameworks and templates are the ones with generators`. Built (`next build`), not browser-tested |
| Free plan: 3 projects, enforced on the backend | WORKING | Database trigger with a per-owner advisory lock (race-safe), archived projects count; users cannot change their plan; test `plans: free allows 3 projects (archived ones count), ...` |
| Search and filter (My bots) | WORKING | Client-side search and active/archived filter in `StudioProjects.js` (not browser-tested) |
| Separation from ZiGBoT | WORKING | test `ZiGBoT and Studio stay separate: nothing in src/ imports Studio code` |
| Payments for plans | BLOCKED | No Studio payment provider; plans are flags set by the service role only |

## Phase 2: Framework support

| Feature | Status | Proof |
|---|---|---|
| discord.js (JavaScript) generator | WORKING | `dashboard/lib/studio/generators/js.js`: entry point, `src/commands/`, `src/events/`, config (fails only when connecting, not on import), `settings.json`, `package.json`, `.env.example`, README, tests, error handling. All 5 templates compile (`vm.Script`, nothing executed) and their own tests passed locally (17 tests over 5 projects) |
| discord.js (TypeScript, strict) generator | WORKING | `generators/ts.js` with typed `settings.ts` and a command registry; all 5 templates passed `tsc --noEmit`, build and their own tests locally against discord.js 14.28.1. Also checked in CI (`studio-generators` job) |
| discord.py generator | WORKING | `generators/py.js`: `bot.py`, `commands/`, `events/`, `config.py`, `requirements.txt`, tests; all 5 templates passed `py_compile` and `python -m unittest` locally (53 files). Also checked in CI |
| Templates: Blank, Moderation, Community, AI Assistant, Ticket Support | WORKING | test `every framework x template generates the required project structure`; moderation commands check the moderator's role hierarchy; no generated mass pings (test `generated bots handle errors, never mass-ping, ...`) |
| Templates: Gaming, Security, Music, Custom | MISSING | Deferred to a later phase by the owner's Phase 2 defaults ("others = later") |
| Files stored per project | WORKING | `supabase/migrations/20261115000001_studio_files.sql`: owner-only RLS, a file can only be added to a project the user owns, path traversal and > 500 KB refused in the database; test `files: owner-only, cannot be planted in someone else's project, no traversal paths, 500 KB cap` |
| Generate on create, copy on duplicate | WORKING | Create stores the generated files or rolls the project back; duplicate copies files; route test `routes: export and file list are owner-only; create stores the generated files or rolls back` |
| Export as .zip | WORKING | `GET /api/studio/projects/[id]/export` (owner-only) with a dependency-free zip writer (`lib/studio/zip.js`, CRC-32 verified); `.env`, keys and `.pem` files are never exported; test `zip export: valid archive with every file intact, secrets left out` |
| Generated-project syntax checks in CI | WORKING (CI) | `.github/workflows/ci.yml` job `studio-generators`: `tsc --noEmit`, `python -m py_compile`, and each project's own tests. Not yet run on GitHub (commits are not pushed): NOT VERIFIED there |

## Phase 3: Customization

| Feature | Status | Proof |
|---|---|---|
| Presence, status and activity | WORKING | `dashboard/lib/studio/customize.js` `validateSettings` (online/idle/dnd/invisible; Playing/Listening/Watching/Competing; 128 characters); used by the generated bots at startup |
| Embed colour, welcome/goodbye/error messages, timezone | WORKING | Same validator: `#RRGGBB`, IANA timezone check, 1-500 characters, no @everyone/@here; test `settings: presence, colour, timezone, messages and commands validated; ...` |
| Slash command list (turn commands off) | WORKING | `disabledCommands`, only the template's commands and at least one stays on; honoured by every generator at load and registration |
| Saving rewrites only settings.json | WORKING | `PUT /api/studio/projects/[id]/settings`; test `saved settings change only settings.json of the generated project` |
| Live preview | WORKING | `customize.preview` rendered by `components/studio/StudioCustomize.js`; test `live preview follows the same placeholders as the generated bot` (UI not browser-tested) |
| Developer Portal-only settings labelled | WORKING | `PORTAL_ONLY` list shown on the Customize page (username, avatar/banner, description, privileged intents, install link, token) |
| Token validated server-side via Discord GET /users/@me only | WORKING | `lib/studio/discordToken.js`; tests `token check: one GET /users/@me with the bot token, nothing else; ...`, `token check: bad format, revoked token, user token, rate limit and network errors are refused plainly`. Not run against the real Discord API: NOT VERIFIED there |
| Token encrypted with AES-256-GCM (STUDIO_SECRETS_KEY), never returned, never logged | WORKING | `lib/studio/secrets.js` (random IV, auth tag, project-bound AAD); `studio_secrets` unreachable from browser sessions (no grant, no policy); responses carry only configured + last 4 + bot name; tests `AES-256-GCM: ...` (2), `status and redaction never expose a secret`, `routes: the token is never returned, ...`, `secrets: no browser access at all; ...` |
| Token excluded from exports | WORKING | the export route never reads `studio_secrets`; same routes test |

## Phase 4: Code Studio

| Feature | Status | Proof |
|---|---|---|
| Monaco editor | WORKING | `components/studio/CodeStudio.js` with `@monaco-editor/react`; Monaco served from this site (`scripts/copy-monaco.js` → `/monaco/vs`, CSP `worker-src 'self' blob:`); page `/studio/[id]/code` (owner check). Built, not browser-tested |
| File tree: create, rename, delete | WORKING | `/api/studio/projects/[id]/file` (POST/PATCH/DELETE), max 300 files, owner-only |
| Search | WORKING | `/api/studio/projects/[id]/search`; test `search: names and lines, capped, short queries ignored` |
| Path traversal and > 500 KB blocked | WORKING | `validateFileWrite` + database check constraints; test `file writes: traversal, absolute paths, secrets and >500 KB are refused` |
| Version history (snapshot on save, 50 per project) with diff | WORKING | `supabase/migrations/20261115000003_studio_versions.sql` (prune trigger, owner-only RLS), `lib/studio/diff.js`; tests `versions: owner-only RLS and pruned to the newest 50 per project`, `diff: added, removed and unchanged lines` |
| Encrypted environment variables | WORKING | `/api/studio/projects/[id]/env`: AES-256-GCM like the token, answers name + last 4 only, DISCORD_TOKEN reserved; test `routes: every Phase 4 route checks ownership; env never returns values` |
| Checks: validate structure, syntax check, lint (static only) | WORKING | `lib/studio/checks.js` (TypeScript parser, JSON.parse, text rules; nothing executed); test `checks: generated projects pass; syntax errors and leaks are found without running anything` |
| Run tests / npm install | NOT AVAILABLE | Needs a sandbox to run customer code; shown as not available in the Checks panel |

## Phase 5: Visual builder

| Feature | Status | Proof |
|---|---|---|
| React Flow canvas: drag/drop, connect, edit, duplicate, delete, undo/redo | WORKING | `components/studio/WorkflowBuilder.js` (`@xyflow/react` 12.3.6), page `/studio/[id]/builder` (owner check). Built, not browser-tested |
| Blocks: 10 triggers, 9 conditions, 10 actions, 7 AI, 8 logic, 4 integrations | WORKING | Fixed catalog in `lib/studio/workflows.js`; no code block exists; test `catalog covers the spec families and is plain data` |
| Save/load, import/export JSON | WORKING | `supabase/migrations/20261115000004_studio_workflows.sql` (owner-only RLS, 20 per project, 256 KB); routes `workflows`, `workflows/[id]`, `workflows/[id]/export` (GET); test `workflows: owner-only RLS, run history owner-only, 20 per project` |
| Validation: inputs, cycles, unreachable blocks, unknown blocks/settings | WORKING | `validateWorkflow`; tests `validation: ...` (2) |
| Simulator on a mocked Discord (test workflow) | WORKING | `simulate`: no Discord, network or AI calls; tests `simulator: ...` (3) |
| No infinite loops: loops max 50, 1000 steps, 5 s | WORKING | test `simulator: loops are capped at 50 and runs stop at the step and time budgets (no infinite loop)` |
| HTTP block: approved hosts + SSRF protection | WORKING | `checkUrlShape` / `checkHttpTarget` (https only, no IPs/credentials/odd ports, every DNS answer must be public); test `HTTP block: allowlist and SSRF protection (127.0.0.1, 169.254.169.254, private DNS answers)` |
| Execution history and errors | WORKING | `studio_workflow_runs` (20 per workflow), shown in the builder |
| Per-user limits | WORKING | 200 simulator runs per user per day (`simulate` route), 20 workflows per project (database trigger) |
| Export workflow as code | PARTIAL | discord.js (JavaScript) module, compiles (test `export: ...`); written into discord.js JS projects. TypeScript and discord.py projects: download only, not converted |
| AI blocks running for real | NOT AVAILABLE | Simulated in the builder; exported code needs the bot owner's own AI provider (Phase 6 covers Studio's AI creator) |

## Phase 6: AI creator

| Feature | Status | Proof |
|---|---|---|
| Reuses the AI provider | WORKING | `lib/studio/aiProvider.js`: same NVIDIA endpoint, `NVIDIA_API_KEY` and `AI_MODEL` as the dashboard's preview route; 503 when no key. Not run against the real API here: NOT VERIFIED there |
| Reuses the untrusted-data wrapper | WORKING | `lib/studio/aiCreator.js` `untrustedUserData`, identical to `src/ai/client.js` (test `same untrusted wrapper as ZiGBoT; ...`); project files sent as an escaped data block; secret files left out |
| AI returns plan + file diffs | WORKING | `parseProposal` (paths, secrets, 500 KB, max 20 changes checked like the editor); test `proposals: plan + diffs; unsafe paths, secrets, oversize and traversal are refused` |
| Approve before any write; never auto-deploy | WORKING | Generation route stores a `pending` proposal only; `ai/[proposalId]` approve/reject, one decision, files snapshotted, refuses if files changed since; tests `prompt injection cannot write without approval: ...`, `approve: applies only when files are unchanged since the proposal` |
| Per-user daily AI limit | WORKING | 20 per user per day, race-safe `claimQuota` before the AI call (`studio_ai_usage`) |
| Context isolated per project | WORKING | Only this project's files (owner + project filters + RLS); migration `20261115000005_studio_ai.sql`, test `ai: proposals and usage are owner-only; ...` |
| AI creator page | WORKING | `/studio/[id]/ai` (`components/studio/AiCreator.js`). Built, not browser-tested |

## Later phases

| Phase | Status |
|---|---|
| 6 AI bot creator | MISSING |
| 7 Deployment foundation | MISSING (real hosting NOT AVAILABLE) |
| 8 Marketplace and billing | MISSING (payments BLOCKED) |
