# ZiGBoT Studio: master spec (condensed copy)

Condensed from the owner's master prompt pasted in chat on 2026-11-13 (the
original file was not in the repo). The phase defaults and global rules the
owner sent with it take priority where they are more specific.

**Product:** ZiGBoT Studio ("Create. Customize. Code. Deploy."): users create,
customize, program, test and (later) host their own Discord bots. Three
logically separate products: ZiGBoT (the bot), Studio (builder), Cloud (hosting).
A user's bot must never affect ZiGBoT or another customer.

## Non-negotiable rules
1. Audit before implementing; check before creating; reuse before rebuilding; fix before replacing.
2. Never duplicate endpoints, models or pages; never replace working auth; preserve all ZiGBoT features.
3. Never execute customer code in the main backend. Never expose customer secrets. No cross-customer access.
4. Never deploy unreviewed AI code. Never claim unsupported frameworks. No placeholders as features.
5. Test before declaring complete; never fabricate results. Non-functional = INCOMPLETE / NOT VERIFIED.

## Audit (first)
Classify every feature: working / needs improvement / partial / broken / missing / duplicated / blocked.
Docs: ZIGBOT_STUDIO_AUDIT, _FEATURE_MATRIX (kept updated), _IMPLEMENTATION_PLAN; later _ARCHITECTURE,
_DATABASE, _API, _SECURITY, _TEST_REPORT, _DEPLOYMENT, _USER_GUIDE (all under docs/).

## Dashboard
Nav: Overview, My Bots, Create New Bot, Templates, Visual Builder, Code Editor, AI Assistant,
Integrations, Deployments, Logs & Monitoring, Documentation, Marketplace, Account Settings, Billing & Usage.
Overview metrics from real backend data only (bots, running/stopped, deployments, errors, usage).
Dark-first, responsive, accessible, loading/empty/error states, confirmations, toasts, search/filters;
use the existing design system.

## Creation wizard (5 steps)
1 Identity (project name, bot name, description, avatar, visibility, language; safe naming).
2 Framework: discord.js (JS), discord.js (TS), discord.py. Only list what has a working, tested generator.
3 Template: Blank, Moderation, Gaming, Community, AI Assistant, Security, Ticket Support, Music, Custom:
  real project structures.
4 Discord application guidance (Developer Portal, token, intents, commands, install). Tokens never in
  frontend code or URLs; never ask for account passwords; validate token without exposing it.
5 Generate: entry point, commands/, events/, config, dependency file, .env.example, README, tests, error handling.

## Customization
Name/description, avatar guidance, activity/status/presence, slash + prefix commands, language, timezone,
embed colours, welcome/goodbye/error messages, default server settings, live preview. Label what must be
done in the Discord Developer Portal; promise nothing unsupported.

## Visual builder (React Flow)
Triggers: member join/leave, message create/update/delete, reaction added, button clicked, slash command,
schedule, voice state. Conditions: role, channel, permissions, content, account age, user/server id,
time/date, variables. Actions: send message/embed, add/remove role, create/delete channel, create thread,
timeout, notify moderator, add reaction. AI blocks: classify, spam, suspicious links, summarize, translate,
generate, image. Logic: if/else, switch, delay, variables, bounded loop, transform, error handling.
Integrations: webhooks, approved HTTP, external APIs, database.
Functions: drag/drop, connect, edit, duplicate, delete, undo/redo, save/load, import/export, validate,
unreachable + cycle detection, test node/workflow, execution history and errors.
Safety: no arbitrary code, timeouts, no infinite loops, input validation, restricted network, per-user limits.

## Code editor (Monaco)
File tree, tabs, highlighting, autocomplete, diagnostics, formatting; create/edit/delete/rename files and
directories; project search; lint/type check; version history + diff; env var management; export (never
with real credentials); terminal/test/build output panels; AI assistant panel.

## AI bot creator
Understand request, inspect project, find reusable/missing parts, plan, generate/modify code, validate,
show diffs, require approval. Explain, debug, refactor, document, generate tests/workflows/templates.
Safety: untrusted input, prompt-injection protection, no key exposure, no unrestricted shell, tool
allowlists, limits, approval for destructive changes, audit logs, per-customer context isolation.

## Integrations
Discord API, AI providers, GitHub, webhooks, Sheets, REST, databases, monitoring: secure connect,
encrypted credentials, status, disconnect, scopes, errors, usage. Secrets never reach the frontend.

## Testing environment
Validate config, dependencies, missing env vars, lint, type check, unit/integration tests, Discord event
simulation (join, leave, message, slash, button, reaction, role change), reports. Simulation is not proof
of production connectivity.

## Deployment and hosting
Start/stop/restart/deploy/rollback, logs, CPU/memory/uptime, env vars, resource limits, history.
Isolated runtimes only (containers/workers, quotas, no Docker socket, no privileged). If secure hosting is
not available: build the interface + provider abstraction and mark hosting NOT AVAILABLE.

## Marketplace
Browse/search/filter/preview/install/clone/customize/publish/update/unpublish. Security scan + review on
publish. Installing never executes code. Future: paid templates, profiles, ratings, versions.

## Logs and monitoring
Status, runtime/error logs, command activity, deployments, resources, restarts; search, filters, date
range, pagination, levels, export. Never log tokens or credentials.

## Accounts and projects
My Bots; create/rename/delete (confirm)/duplicate/archive; ownership, sharing, permissions, version
history, quotas. Server-side authorization on every operation; prevent IDOR.

## Database
Check existing schemas first. Entities: projects, files, versions, bot configs, framework templates,
workflow definitions/executions, deployments, runtime instances, secrets, integrations, collaborators,
usage, marketplace templates, audit events. Ownership, isolation, validation, indexes, migrations,
retention, atomic updates; no plain-text credentials.

## API
Per endpoint: authenticate, authorize owner, validate, rate limit, handle errors, block cross-user access,
log security events. No duplicates.

## Security testing
Auth/authz bypass, IDOR, XSS, CSRF, SQL/NoSQL injection, SSRF, path traversal, file access, command
injection, malicious dependencies, env/token leakage, isolation, cross-user leakage, prompt injection,
AI tool abuse, infinite loops, resource exhaustion, rate-limit bypass. Each: reproduce, document, root
cause, fix, regression test, retest.

## TDD scenarios
1 JS bot: create, generate, validate, export. 2 Python bot generates a valid project. 3 Member-join
workflow: build, save, validate, test-run. 4 AI moderation command: review, approve, test. 5 Other user's
project: rejected. 6 Credentials never reach the frontend. 7 Customer bot crash is logged and ZiGBoT keeps
running. 8 Invalid deploy fails and the previous version stays.

## Billing
Plans Free / Developer / Premium / Hosting as proposals. No fake payments or subscription status; limits
enforced on the backend.

## Phases
1 Audit + foundation + wizard. 2 Framework generators, templates, export. 3 Customization. 4 Code Studio.
5 Visual builder. 6 AI creator. 7 Deployment foundation. 8 Marketplace + billing. Test each before the next.

## Final report
Audit, reused/improved/new functionality, frameworks, pages, modules, DB/API changes, files, vulnerabilities
found/fixed, real test + build results, incomplete items, deployment instructions.

---

# Owner's build instructions (sent with the spec, 2026-11-13). These win over the spec.

Work Phase 1 → 8. Do not ask questions; missing infrastructure = NOT AVAILABLE / BLOCKED with the reason.

## Global rules
1. The bot (src/) keeps working exactly as today. Nothing in src/ imports Studio code. Studio never touches ZiGBoT's tables, commands or listeners.
2. Studio lives in the existing dashboard: pages dashboard/app/studio/*, APIs dashboard/app/api/studio/*. Reuse the Discord OAuth login and design system.
3. Database: new Supabase migrations, tables prefixed studio_, RLS so users reach only their own projects (owner_id = auth user); every API also checks ownership server-side.
4. Customer code never runs in the dashboard or bot process: no shell, eval or child_process on customer code.
5. Tokens/secrets: AES-256-GCM with env STUDIO_SECRETS_KEY; never returned to the frontend (only "configured ✓" + last 4); never logged; never exported.
6. TDD. No existing test changes except command-count/catalog tests if truly required.

## Phase defaults
- P1: docs/ZIGBOT_STUDIO_AUDIT.md, _FEATURE_MATRIX.md, _IMPLEMENTATION_PLAN.md; projects CRUD (create/rename/duplicate/archive/delete with confirmation); 5-step wizard; free plan limit 3 projects, enforced on the backend.
- P2: generators for discord.js JS, discord.js TS, discord.py: entry point, commands/, events/, config, package.json or requirements.txt, .env.example, README, basic tests, error handling. Templates: Blank, Moderation, Community, AI Assistant, Ticket Support (others later). Export .zip. Generator tests syntax-check every generated file (node --check / tsc --noEmit / python -m py_compile in CI only).
- P3: presence/status/activity, embed colours, messages, timezone, slash command list, live preview; label Developer Portal settings; token validated server-side via Discord GET /users/@me only.
- P4: @monaco-editor/react; file tree create/rename/delete/search; version history (snapshot on save, max 50) + diff; encrypted env var manager. No terminal: a "Checks" panel with fixed static-analysis actions (validate structure, lint, syntax check); running tests / npm install = NOT AVAILABLE until a Phase 7 sandbox exists. Block ../ traversal and files > 500 KB.
- P5: @xyflow/react; blocks from the spec; workflows as validated JSON; validator finds cycles, unreachable nodes, bad inputs; loops max 50 iterations, 5 s timeout; "Test run" only in a mocked Discord simulator; HTTP block allowlist + SSRF protection (no private IPs/localhost); export workflow to generated code in the project.
- P6: reuse the AI provider and untrusted-data wrapper; AI returns plan + file diffs; user must Approve before any write; never auto-deploy; per-user daily AI limit; context isolated per project.
- P7: runtime provider interface (start/stop/restart/deploy/rollback/logs/metrics) with MockProvider in tests. Real hosting NOT AVAILABLE: build UI + abstraction, show "Hosting coming soon", run no customer containers here. Deployment history + rollback tested with MockProvider.
- P8: publish/unpublish/clone templates; static scan on publish (token patterns, eval, child_process, obfuscation) + "pending review"; installing never executes code. Plans Free/Developer/Premium as flags with backend limits; payments BLOCKED (no provider).

## Checkpoint after each phase
npm test (whole repo) + npm --prefix dashboard run build. Pass: update the Studio matrix, commit "Studio Phase N: <name>" (no push). Fail after 2 fix attempts: revert that phase's files, mark BROKEN, continue. Print phase status, test summary + exit code, build result, commit hash.

## Required security tests
IDOR (user B cannot read/edit/export A's project); token never in any API response, log or export; path traversal rejected; workflow infinite loop stopped; prompt injection in project files cannot write without approval; SSRF to 127.0.0.1 / 169.254.169.254 blocked.

## Final report
Per-phase status, commits, migrations in order, new env vars, NOT AVAILABLE/BLOCKED list, security test results, final npm test summary + exit code, dashboard build result.
