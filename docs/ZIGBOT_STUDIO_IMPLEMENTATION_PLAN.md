# ZiGBoT Studio: implementation plan

Phases follow `ZIGBOT_STUDIO_MASTER.md` and the owner's phase defaults. Each phase ends with `npm test`, `npm --prefix dashboard run build`, a matrix update and a commit `Studio Phase N: <name>` (not pushed).

| Phase | Scope | Key decisions |
|---|---|---|
| 1 Audit + foundation | Audit docs; `studio_accounts` (plan flag) and `studio_projects` with owner-only RLS; projects CRUD (create, rename, duplicate, archive, delete with typed confirmation); 5-step wizard; Free = 3 projects | Limit enforced by a database trigger under a per-owner advisory lock (race-safe); API also filters by owner (IDOR defence in depth) |
| 2 Frameworks | Generators for discord.js JS, discord.js TS, discord.py with templates Blank, Moderation, Community, AI Assistant, Ticket Support; project files stored per project; `.zip` export | Pure generator functions; generated JS checked with `node --check` in tests; TS/Python checks in CI only |
| 3 Customization | Presence/status/activity, embed colour, messages, timezone, slash command list, live preview; token validation via Discord `GET /users/@me` only | Developer Portal-only settings labelled; token encrypted (AES-256-GCM, `STUDIO_SECRETS_KEY`), only "configured ✓ + last 4" shown |
| 4 Code Studio | `@monaco-editor/react`, file tree, search, version history (50 snapshots) + diff, encrypted env vars, static "Checks" panel | No terminal; tests/npm install NOT AVAILABLE; path traversal blocked; 500 KB file cap |
| 5 Visual builder | `@xyflow/react`; validated JSON workflows (cycles, unreachable nodes, inputs); mocked Discord simulator; HTTP block allowlist + SSRF checks; export to code | Loops max 50 iterations, 5 s timeout |
| 6 AI bot creator | Plan + file diffs from the existing AI provider, approval before any write, per-user daily limit, per-project context | Prompt injection in project files cannot write without approval |
| 7 Deployment foundation | Runtime provider interface (start/stop/restart/deploy/rollback/logs/metrics), MockProvider, deployment history + rollback | Real hosting NOT AVAILABLE: UI says "Hosting coming soon"; no customer containers on this machine |
| 8 Marketplace + billing | Publish/unpublish/clone templates, static security scan + "pending review", plans with backend limits | Installing never executes code; payments BLOCKED |
