# ZiGBoT platform transformation: delivery report

Date: 2026-11-14. Branch: `master`. Scope: the 9-phase "AI bot platform transformation" prompt.
Every status below was checked against the code and tests in this repository. "Not verified" means the code exists and is tested offline, but nobody has exercised it in a browser or against the live service.

## 1. Phases

| Phase | Status | Commits |
|---|---|---|
| 1 Dashboard redesign and sidebar navigation | Done | `567b3ab`, `8ca89c7`, `e05b6ba` |
| 2 Futuristic Studio experience | Done: neon / glass theme, Studio hero, IDE workspace with an AI assistant pane and status bar, execution console | `ec92008` |
| 3 Automation creation and Premium monetization | Done, including live execution through the owner's runner | `57492b3`, `c0f47c3` |
| 4 Homepage, branding and SEO | Done | `7291813` |
| 5 Server-owner announcements and dashboard recheck | **Skipped by the owner.** The dashboard was rechecked in Phase 9 instead. | none |
| 6 Personalized "Create New Bot" | Done | `91d0162` |
| 7 AI coding agent integration | Done (Claude + OpenAI; Copilot and the command-line agents are not available) | `6aba337` |
| 8 AI workflow automation builder | Done | `b22e29c` |
| 9 Final integration, testing and polish | Done (this report) | see section 9 |

Owner-requested changes in between:
- `4a84c04`: the project .zip download was removed and the self-hosted runner added.
- `374dfe2`: an admin page that shows users' agent API keys (full-key reveal, audited).

## 2. Features implemented

- **Dashboard (Phase 1)**
  - A collapsible sidebar for `/dashboard` and `/studio`; it becomes a drawer on phones.
  - Icons, an active-page indicator, per-project and per-server context links, a skip link and reduced-motion support.
  - The server settings tabs (AI behaviour ... History) live in the sidebar, with `#section` links.
- **Premium automations (Phase 3)**
  - Designing, saving and previewing workflows is free. Activating and executing them is Premium.
  - Premium is checked on the server on every request, from stored data only, and any failure counts as "not Premium". It comes from: a Premium server the user manages, an unexpired Studio plan, a home server, or the bot owner.
  - Expiry pauses active workflows. An edit that breaks a workflow deactivates it.
  - An upgrade screen opens on HTTP 402.
- **Homepage and SEO (Phase 4)**
  - Positioning: "Build. Automate. Create. All with AI." / "Your AI-Powered Discord Command Center".
  - New sections: product introduction, three ZiGBoT Studio cards, "What's new", a pricing anchor and Studio FAQ answers.
  - The feature grid shows 6 cards, with "show all" for the rest.
  - Titles, descriptions, Open Graph image, structured data and robots updated; `/studio` is no longer indexed. The sitemap lists public pages only.
  - No "first", "best" or "#1" claims; a test enforces this.
- **Specialization onboarding (Phase 6)**
  - "What do you want your AI to build?" with three animated, keyboard-accessible cards: AI Coding, Workflow Automation and Prompt Engineering.
  - Each card lists only what actually works; the rest is marked "coming later".
  - The choice is stored on the project. It opens the matching workspace and themes the project dashboard (accent colour, tool order, a getting-started guide). It also sets the AI creator's context.
- **Coding agents (Phase 7)**
  - Claude through the official Anthropic SDK (streaming, adaptive thinking, server-side fallback if the model declines) and OpenAI through the official SDK (Responses API). Users bring their own keys, encrypted per user and provider.
  - The flow: prompt → plan and diffs → syntax and lint checks → Approve writes the files.
  - Cancel aborts the call; usage is tracked; each user has a daily limit.
- **AI workflow generation (Phase 8)**
  - "Describe the automation you want to create."
  - The AI may only use the builder's validated block schema, and there are no code blocks. Anything invented is dropped and reported.
  - The result is laid out automatically and saved as an editable draft. Generation can use ZiGBoT AI or the user's own agent.
- **Self-hosted runner**
  - Users run `public/runner/zigbot-runner.mjs` (Node 18 or later, no dependencies) on their own machine and pair it with a one-time code.
  - From the Deployments page they can deploy, start, stop and restart it, and read its logs.
  - Bundles are sent only during a deploy the owner started. The runner only runs commands from a fixed allow-list, refuses paths outside its folder and redacts secrets from its logs.
- **Admin: agent API keys**
  - Masked list with 30-day usage. A Super Admin can reveal one full key at a time: rate-limited, hidden again after 30 seconds, and written to the audit log.
  - Users are told on the key form and in the Privacy Policy.
- **Polish (Phase 9):** site-wide error and not-found pages that never show internal error details.

## 3. Screenshots

**Not available.** This environment has no browser, and the dashboard needs a Discord login. Please capture before/after screenshots on staging; the pages to check are listed in section 11.

## 4. Modified files

71 files, about 3,400 lines added (`git diff --stat 99b4fe3~1..HEAD`). The main ones:

- **App shell:** `dashboard/components/AppShell.js`, `GuildEditor.js`, `app/dashboard/layout.js`, `app/studio/layout.js`, `app/globals.css`, `app/error.js`, `app/not-found.js`
- **Studio library:** `dashboard/lib/studio/{entitlements,entitlementServer,runner,runnerServer,specializations,agents,agentProviders,workflowGen}.js`
- **Studio UI:** `dashboard/components/studio/{PremiumPaywall,SpecializationPicker,AgentBuilder,AiWorkspace,Deployments,WorkflowBuilder,StudioWizard}.js`
- **Admin UI:** `dashboard/components/admin/{RevealKey,AdminNav}.js`
- **API routes:**
  - `app/api/runner/{pair,poll,bundle,report}`
  - `app/api/studio/agents/keys`
  - `app/api/studio/projects/[projectId]/{runners,agent,workflows/generate,workflows/[workflowId]/{activate,execute}}`
  - `app/api/admin/agent-keys/[ownerId]`
- **Pages:** `app/page.js`, `lib/landing.js`, `lib/seo.js`, `app/opengraph-image.js`, `app/privacy/page.js`, `app/admin/agent-keys/page.js`, `app/studio/[projectId]/page.js`
- **Tests:** `test/{appShell,automationPremium,selfHostedRunner,specializations,codingAgents,workflowGen}.test.js`, plus additions to `studio-phase1`, `landingContent` and `seo`

## 5. New dependencies (dashboard)

Exact versions:
- `@monaco-editor/react` 4.7.0, `monaco-editor` 0.52.2, `@xyflow/react` 12.3.6, `typescript` 5.6.3 (Studio editors and syntax checks)
- `@anthropic-ai/sdk` 1.8.0, `openai` 7.56.0 (Phase 7)

The pinned dependency list in `test/landingMascot.test.js` was updated to match; no other assertion in that test changed.

## 6. Database changes

Run these in order. They are additive and can be re-run.

| Migration | Adds |
|---|---|
| `20261115000000_studio_projects` … `20261115000007_studio_marketplace` | ZiGBoT Studio core: projects, files, secrets, versions, workflows, AI, deployments, marketplace |
| `20261116000000_automation_premium` | `studio_accounts.plan_expires_at`; `studio_workflows.active` / `activated_at`; browsers can no longer write the activation columns |
| `20261116000001_studio_runners` | `studio_runners`, `studio_runner_commands`, `studio_runner_logs` (hashed tokens; owners can read, only the server writes) |
| `20261116000002_studio_specialization` | `studio_projects.specialization` (coding / workflow / prompt) |
| `20261116000003_studio_agents` | `studio_agent_keys` (service role only), `studio_agent_runs`, `studio_ai_proposals.agent` / `model` |

## 7. Environment variables

| Name | Needed for |
|---|---|
| `STUDIO_SECRETS_KEY` (32 bytes, base64 or hex) | Encrypted bot tokens, environment variables and agent keys; sending variables to runners; revealing keys in the admin page |
| `NEXT_PUBLIC_SITE_URL` | Correct copy-paste commands for the runner |
| `NVIDIA_API_KEY`, `AI_MODEL` (existing) | ZiGBoT AI: AI creator and workflow generation |
| `PREMIUM_PRICE_MONTHLY`, `PREMIUM_PRICE_YEARLY`, Razorpay settings (existing) | Prices and checkout on the upgrade screen |
| `SUPER_ADMIN_DISCORD_IDS` (existing) | Admin key page and template review |

## 8. API integrations that need credentials

- **Anthropic and OpenAI:** each user supplies their own key in Studio. ZiGBoT holds no platform key for these.
- **NVIDIA:** the existing platform key, used for ZiGBoT AI.
- **Razorpay:** the existing billing setup.
- **Discord:** the existing OAuth login and bot token.
- **GitHub Copilot, Claude Code and Codex CLI:** not integrated, and shown in the app as not available with the reason.

## 9. Tests and actual results

- **`npm test`:** 1142 tests, 1141 pass, 0 fail, 1 skipped. Exit code 0.
- **`npm --prefix dashboard run build`:** exit code 0 (109 routes).
- **End-to-end runner test** (real runner program against a mock Studio API):
  - Wrong pairing code refused; pairing worked.
  - A deploy containing `../escape.txt` failed and wrote nothing outside the folder.
  - A clean deploy installed the bot and started it with its secret.
  - The secret never appeared in any report.
  - Stop shut down the whole process tree.
- **SDK request shapes** (official Anthropic and OpenAI SDKs against a local mock): requests accepted and responses parsed; Cancel raises an abort error.
- **Route audit:** all 65 API routes are protected. The only public ones are the health check and the webhooks, which verify signatures or secrets. Every `/api/studio` route uses the login check and an owner check; `/api/runner` uses a runner token; `/api/admin` uses the Super Admin check, a rate limit and the audit log.
- **Security tests** (all pass):
  - another user can't read or change your data, on every Studio table (real migrations with row-level security);
  - tokens and keys are never in responses, logs or exports;
  - path traversal is blocked;
  - workflows can't loop forever;
  - prompt injection can't write files without approval;
  - SSRF (127.0.0.1 / 169.254.169.254) is blocked;
  - Premium is checked on the server;
  - runner tokens are checked and logs are redacted;
  - key reveals are audited.
- **Not verified:**
  - browser behaviour of every new page (layout, animations, responsiveness);
  - live Anthropic, OpenAI and NVIDIA calls;
  - a live Razorpay upgrade;
  - the runner on a real VPS with a real Discord bot.

## 10. Known limitations

- **No ZiGBoT hosting:** active workflows run live only inside the owner's own bot on their self-hosted runner (discord.js JavaScript projects only).
- **Intents:** triggers need the matching gateway intents, which the bot's template decides (the bundle lists the ones needed). Migration `20261116000004_runner_workflows` is required.
- **Agents not integrated:** GitHub Copilot (no public API) and the Claude Code / Codex command-line agents (they would need a sandbox).
- **Phases 2 and 5** were not done (skipped).
- **Dependency advisories** (`npm audit --omit=dev`):
  - Dashboard: PostCSS through Next.js, used only at build time. The fix needs the Next 16 major upgrade.
  - Bot: `tar` through `@discordjs/opus` (used only to unpack its prebuilt binary at install time). No fix is available yet.
- **Admin key reveal:** Super Admins can view users' full keys by your decision. Users are told, and every view is audited.
- **Error tracking:** the new error page logs only the digest. There is no external error tracker.

## 11. Deployment instructions

1. Run the migrations in section 6 in Supabase, in order.
2. Set `STUDIO_SECRETS_KEY` and `NEXT_PUBLIC_SITE_URL` on the dashboard host, and check the existing variables in section 7.
3. Deploy `master` (`git push`, then wait for the host to build).
4. Smoke test while signed in:
   - `/dashboard`: sidebar, then open a server and check the sections in the sidebar.
   - `/studio/new`: the three specialization cards.
   - Create a project, then:
     - Code: edit and save;
     - Visual builder: generate a workflow from a sentence and test it in the simulator;
     - Activate as a free user: the upgrade screen should appear;
     - AI page: connect a Claude key and generate a small change, then approve it;
     - Deployments: add a runner and pair it on a test machine.
   - `/admin/agent-keys`: reveal a key, then check Settings & Audit.
   - Homepage, `/robots.txt`, `/sitemap.xml`.
5. Update the bot's description in the Discord Developer Portal and on discordbotlist with the new positioning (this can't be done from code).

## 12. Remaining work

- Phase 2 (Studio redesign) and Phase 5 (owner announcements in the dashboard, no mass DMs).
- A hosting runtime, so activated workflows run on live events.
- The Next.js 16 upgrade, once it is tested.
- Browser screenshots and an accessibility pass on staging.
