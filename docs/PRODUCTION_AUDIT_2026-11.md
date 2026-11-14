# ZiGBoT production audit (November 2026)

Scope: the "Full Website Audit, Correction & Production Readiness" brief, run on 2026-11-14 against `master` and the live site https://www.zigbot.in.

Statuses:
- **PASS:** verified working.
- **FIXED:** corrected and tested.
- **FAILED:** a test failed.
- **NOT IMPLEMENTED:** the feature does not exist.
- **NEEDS MANUAL VERIFICATION:** needs an external account, credentials or a browser.

Earlier audits this builds on:
- `audit-reports/` (2026-11-11 QA and security audit, git-ignored)
- `docs/ZIGBOT_FEATURE_MATRIX.md` (bot features)
- `docs/ZIGBOT_STUDIO_FEATURE_MATRIX.md` (Studio)
- `docs/PLATFORM_DELIVERY_REPORT.md` (platform phases)

## 1. Architecture (Phase 1)

| Part | Stack | Hosting |
|---|---|---|
| Discord bot | Node.js (discord.js 14), `src/` | Render |
| Website, dashboard, Studio, admin | Next.js 15 App Router, `dashboard/` | Vercel |
| Database | Supabase Postgres with row-level security (RLS) | Supabase |
| Bot memory and records | MongoDB | Atlas |
| Payments | Razorpay subscriptions (monthly / yearly) | Razorpay |
| Login | Discord OAuth through Supabase | — |
| Customer bots (Studio) | Self-hosted runner on the owner's machine | Owner |

## 2. Findings and status

| # | Area | Finding | Severity | Status | Where |
|---|---|---|---|---|---|
| 1 | SEO / product | No product landing pages for Discord Bot, AI Memory, Anti-Nuke, Studio, Automation or Pricing; only 4 public pages (also hurts AdSense approval) | High | **FIXED** (`a403ed3`) | `lib/productPages.js`, `app/features/*`, `app/pricing` |
| 2 | Positioning | Homepage did not state who ZiGBoT is for | Medium | **FIXED** | `lib/landing.js` (intro) |
| 3 | Accessibility | Landing page had no `<main>` landmark; mascot button name did not start with its visible text | Medium | **FIXED** (`5b5638e`) | `app/page.js`, `HeroOrb.js` |
| 4 | Performance | Oversized demo avatar; legacy polyfills shipped to modern browsers | Low | **FIXED** (`5b5638e`) | `ChatDemo.js`, `package.json` browserslist |
| 5 | Performance | About 2.2 s Total Blocking Time, mostly from AdSense | Medium | **NOT IMPLEMENTED (deliberate)**: deferring the ad script could fail the pending AdSense approval check; do it after approval | `components/AdSense.js` |
| 6 | Errors | No error or not-found pages | Medium | **FIXED** (`1f2fe61`) | `app/error.js`, `app/not-found.js` |
| 7 | Studio | Built-in AI model returned 404 | High | **FIXED** (`b6ede57`): prompts use the user's own key | `.../workflows/generate`, `.../ai` |
| 8 | Payments | Refunds are not handled in code; a refund changes access only if Razorpay also cancels the subscription | Medium | **NOT IMPLEMENTED**: handle refunds by cancelling in Razorpay | `api/billing/razorpay/webhook` |
| 9 | Automation | No automatic retry of failed workflow actions | Low | **NOT IMPLEMENTED**: errors can be caught with the "Handle errors" block | `lib/studio/workflows.js` |
| 10 | Anti-Nuke | No automatic recovery (re-creating deleted channels or roles) | Low | **NOT IMPLEMENTED**: alerts and optional containment only | `lib/shared/antinuke.js` |
| 11 | Studio | Running tests and `npm install` in the browser need a sandbox | Low | **NOT IMPLEMENTED (by design)**: never run customer code on our servers | `lib/studio/checks.js` |
| 12 | Dependencies | `npm audit`: Next.js / PostCSS (build-time; the fix needs Next 16), `tar` through `@discordjs/opus` (install-time, no fix available) | Medium | **NOT IMPLEMENTED**: plan the Next 16 upgrade after PR #1 | `package.json` |

## 3. Payments (Phase 6): verified on code and tests

| Check | Status | Evidence |
|---|---|---|
| Monthly and yearly subscriptions | PASS | `lib/razorpay.js createSubscription`; plan IDs from environment variables |
| Payment verification on the backend | PASS | `billing/verify`: HMAC of payment ID and subscription ID, then the subscription is re-fetched from Razorpay and pinned to the expected server |
| Webhook signature validation | PASS | HMAC of the raw body; the body's claims are never trusted (re-fetch); test `Razorpay webhook: only a valid HMAC…` |
| Repeated webhooks / old events | PASS | Each event syncs to Razorpay's current state; test `an unpaid checkout or a late old event never replaces a running Premium` |
| Cancellation keeps paid access | PASS | `billing/cancel` sets cancel-at-period-end; `isPremiumActive` keeps cancelled plans until `current_period_end`; tested |
| Failed or halted payments | PASS | `halted` and other statuses are never Premium; tested |
| Expiry | PASS | Server-side check on every request (bot, dashboard and Studio entitlements) |
| Entitlements | PASS | Per server, plus Studio through `getEffectivePlan`; never from the browser |
| Full lifecycle in Razorpay test mode | **NEEDS MANUAL VERIFICATION** | Needs Razorpay test-mode keys and a browser |
| New ₹599 monthly plan | **NEEDS MANUAL VERIFICATION** | Create the plan in Razorpay, then set `RAZORPAY_PLAN_MONTHLY` and `PREMIUM_PRICE_MONTHLY` on Vercel |

## 4. Security (Phase 4)

| Check | Status | Evidence |
|---|---|---|
| Admin endpoints | PASS | Every `/api/admin` route: Super Admin check (server-side), rate limit, audit log; test `superAdmin` |
| IDOR on Studio data | PASS | Row-level security tests on every Studio table (`studio-phase1`) and owner filters in every route |
| CSRF | PASS | Same-origin check on every cookie-authenticated write (`lib/http.js`) |
| SSRF | PASS | Workflow HTTP block: approved hosts only, IP literals refused, private DNS answers refused (`studio-phase5`) |
| XSS | PASS | React escaping; structured-data output escaped (`jsonLdScript`); no `dangerouslySetInnerHTML` with user data |
| Discord OAuth / session | PASS | Supabase `getUser()` verified on the server per request; live Discord permission checks for server admins |
| Webhooks (Discord, Razorpay, votes) | PASS | Ed25519, HMAC or shared secret on every webhook |
| Secrets | PASS | Bot tokens, variables and agent keys encrypted with AES-256-GCM; never in responses or logs; gitleaks in CI |
| Admin view of agent keys | PASS (owner's decision) | Full-key reveal is Super Admin only, rate-limited, audited, and disclosed in the Privacy Policy |
| Rate limiting | PASS | AI quotas, simulator / agent / runner limits, admin rate limit |
| Anti-Nuke (mass bans and kicks, deletions, escalation, bots, webhooks, raids) | PASS | Configurable thresholds; containment off by default; incident log |
| Security headers (live) | PASS | HSTS preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, CSP |
| Strict nonce CSP on private pages | NEEDS MANUAL VERIFICATION | PR #1 (`harden/csp-nonce`) waits for your merge |

## 5. Production readiness (Phase 9)

| Check | Status |
|---|---|
| HTTPS, domain (`zigbot.in` → `www`), security headers | PASS (live) |
| Health check `/api/health?deep=1` | PASS (live: `{"ok":true,"configured":true,"database":"ok"}`) |
| ads.txt | PASS (live; AdSense status updates on its own) |
| Studio migrations `20261115*` and `20261116*` applied | NEEDS MANUAL VERIFICATION (Supabase) |
| `STUDIO_SECRETS_KEY`, `NEXT_PUBLIC_SITE_URL` on Vercel | NEEDS MANUAL VERIFICATION |
| Database backups | NEEDS MANUAL VERIFICATION: Supabase daily backups (plan-dependent) and MongoDB Atlas snapshots |
| Error monitoring | NOT IMPLEMENTED: logs only (Vercel and Render); add an error tracker such as Sentry if wanted |

## 6. Tests (Phase 7)

- **Unit, integration and security (`npm test`):** 1163 tests, **1162 pass, 0 fail**, 1 skipped (existing). Includes PGlite database tests with the real migrations and row-level security.
- **Build (`npm --prefix dashboard run build`):** passes.
- **End to end (Playwright):** **NEEDS MANUAL VERIFICATION.** The suite lives on PR #1 and needs a browser plus a Discord test login.
- **Flaky test:** once during this audit a single test failed and passed on two re-runs. It looks like a timing issue and should be monitored.
- **Runner end-to-end:** PASS (earlier, against a mock API).
- **Coding-agent SDK request shapes:** PASS (earlier, against a mock).

## 7. What changed in this audit

**Commits:**
- `fb5068b`: footer social links
- `5b5638e`: Lighthouse fixes
- `a403ed3`: product pages and pricing
- This report

**New files:**
- `dashboard/lib/productPages.js`, `dashboard/components/ProductPage.js`
- `dashboard/app/features/{discord-bot,ai-memory,anti-nuke,studio,automation}/page.js`, `dashboard/app/pricing/page.js`
- `test/productPages.test.js`

**Dependencies:** none added. **Database:** no changes.

## 8. Deployment

1. Run `git push`, then wait for the Vercel deploy.
2. In Search Console, request indexing for the new pages, or resubmit `sitemap.xml` (it now lists 10 URLs).
3. Do the manual items above: migrations, Vercel environment variables, the ₹599 Razorpay plan.

## 9. Recommended next priorities

1. Merge PR #1 (strict CSP, Playwright end-to-end tests), then upgrade to Next 16, which clears the build-time advisory.
2. Once AdSense is approved: load ads after the page is idle (TBT).
3. Handle refunds: cancel the subscription when Razorpay sends `refund.processed`.
4. Add error monitoring.
5. ZiGBoT-hosted runtime for Studio bots (a paid tier).
6. More content pages (setup guides) for SEO.
