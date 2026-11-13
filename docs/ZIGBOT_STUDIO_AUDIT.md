# ZiGBoT Studio: repository audit

Audit done before Studio Phase 1 (2026-11-14), against `ZIGBOT_STUDIO_MASTER.md`.

## What exists and is reused

| Area | Finding | Studio decision |
|---|---|---|
| Frontend | Next.js 15 App Router dashboard (`dashboard/`), React 19, plain CSS design system (`globals.css`: `card`, `btn`, `field`, `stack`, `row`, `pill`) and `TopBar` | Studio pages live in `dashboard/app/studio/*` and use the same components and classes |
| Authentication | Supabase Auth with Discord OAuth (`lib/auth.js` `getCurrentUser`, `requireUser`; Discord id from `identities` only) | Reused as is: no second login |
| API conventions | `lib/http.js` `handler()` (consistent JSON errors, same-origin check on every non-GET), `readJson()` with a size cap | Every Studio route uses `handler()` |
| Database | Supabase Postgres, migrations in `supabase/migrations/`, RLS everywhere, tests that run all migrations in PGlite | New `studio_*` tables with owner-only RLS; tested the same way |
| AI | NVIDIA/Groq via the OpenAI-compatible client, `untrustedUserData` wrapper (`src/ai/client.js`) | Phase 6 reuses the provider settings and the wrapper pattern, without importing bot code into Studio's request path beyond the shared wrapper |
| Billing | Razorpay subscriptions for ZiGBoT Premium per server (`zb_guild_subscriptions`) | Not reused for Studio: Studio plans are per user and payments are BLOCKED (no Studio payment provider) |
| Hosting | ZiGBoT bot runs on Render, dashboard on Vercel. No container runtime, no sandbox | Customer code is never run. Phase 7 builds the provider interface + a MockProvider; real hosting NOT AVAILABLE |
| Security | CSP and security headers (`next.config.mjs`), CSRF same-origin check, RLS, SSRF-safe fetcher (`src/features/net.js`) | Same headers apply to Studio; SSRF checks reused in Phase 5 |
| Tests | `node --test`, 1034 tests before Studio | Studio tests in `test/studio-*.test.js` |

## Searched and not found (MISSING)

Searches across `src/`, `dashboard/`, `supabase/` and `test/` for: bot creation / bot projects, project management, code editor (Monaco), visual builder (React Flow / xyflow), AI code generation, templates/marketplace, deployments, runtime logs, Studio billing. The only match was the phrase "YouTube Studio" in `src/youtube/commands.js` (not related). So every Studio feature starts as MISSING; nothing is duplicated or broken.

## Separation rules (enforced by tests)

- Nothing in `src/` imports Studio code or touches `studio_*` tables (`test/studio-phase1.test.js`).
- Studio never touches ZiGBoT's tables, commands or listeners.
- Customer code never runs inside the dashboard or bot process: no `eval`, no `child_process`, no shell on customer code.

## Blocked or not available on this infrastructure

| Item | Status | Reason |
|---|---|---|
| Hosting customer bots | NOT AVAILABLE | No isolated runtime (containers or sandbox workers); running customer code on Vercel/Render or this machine would break the isolation rule |
| Running tests / `npm install` for customer projects | NOT AVAILABLE | Same reason: needs the Phase 7 sandbox |
| Payments for Studio plans | BLOCKED | No payment provider integrated for Studio; plans are flags only |
| `tsc --noEmit` / `python -m py_compile` on generated projects | CI only | The generated files are syntax-checked in CI, not inside the web app |
