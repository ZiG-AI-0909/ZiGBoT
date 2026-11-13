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

## Later phases

| Phase | Status |
|---|---|
| 3 Customization, token validation | MISSING |
| 4 Code Studio | MISSING |
| 5 Visual builder | MISSING |
| 6 AI bot creator | MISSING |
| 7 Deployment foundation | MISSING (real hosting NOT AVAILABLE) |
| 8 Marketplace and billing | MISSING (payments BLOCKED) |
