# ZiGBoT Multi-Server + Dashboard — Setup & Deployment

ZiGBoT now works in any Discord server. Each server has its own isolated settings: AI personality, response rules, role behaviour, channels and features. Admins edit them in a web dashboard.

```
 Discord ──gateway──►  Bot worker (Render, always on)  ──service role──►  Supabase (Postgres + RLS)
                         src/index.js                                        ▲
                         reads config per guild (30 s cache)                 │ user JWT (RLS) + service role
                                                                             │
 Browser ──HTTPS──►  Dashboard (Vercel, Next.js)  ──bot token──► Discord REST (live permission checks)
```

* **Bot = always-on worker.** A Discord gateway connection is a long-lived WebSocket and cannot run in Vercel serverless functions. Keep the bot on Render (or any always-on host).
* **Dashboard = Vercel.** Pages and API routes only.
* **MongoDB stays as-is** for memories, warnings, behaviour and YouTube state. Nothing is migrated, so no existing data is at risk. Supabase holds only the per-server configuration.
* **Backward compatible.** Without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` the bot runs in *legacy mode*, exactly as before. Your home server is seeded with `legacy_role_rules = true`, so its env-driven gentle/savage/pronoun roles keep working.

---

## 1. Supabase

1. Create a project (or reuse an existing one: every object is prefixed `zb_` and the migration is additive and re-runnable, so it never touches other tables).
2. **SQL Editor →** paste and run `supabase/migrations/20261016000000_zigbot_multiserver.sql`.
   With the CLI instead: `supabase link --project-ref <ref>` then `supabase db push`.
3. **Authentication → Providers → Discord:** enable it and paste your Discord app's *Client ID* and *Client Secret*.
4. **Authentication → URL Configuration:**
   * Site URL: `https://<your-dashboard>.vercel.app`
   * Redirect URLs: `https://<your-dashboard>.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`
5. **Project Settings → API:** copy the *Project URL*, the *anon public* key and the *service_role* key. The service_role key is secret.

## 2. Discord Developer Portal (manual — cannot be automated)

1. **Bot → Public Bot: ON.** If this is off, only you can invite the bot. That is a likely cause of "works only in my server".
2. **Bot → Privileged Gateway Intents:** keep **Server Members** and **Message Content** on, because the bot already uses both. Once the bot is in 100+ servers, Discord requires verification for these intents.
3. **OAuth2 → Redirects:** add `https://<your-project-ref>.supabase.co/auth/v1/callback` (Supabase handles the Discord login).
4. Copy the **Application ID** (`DISCORD_CLIENT_ID`). The dashboard builds invite links with exactly the permissions ZiGBoT uses, never Administrator.

## 3. Bot worker (Render)

Add these environment variables to your existing Render service. Everything else stays as it is.

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (**secret**) |
| `HOME_GUILD_IDS` | your server's ID (optional; a server owned by `SERVER_OWNER_ID` is detected automatically) |
| `BOT_CREATOR_ID` | optional; defaults to `SERVER_OWNER_ID` |
| `SLASH_COMMAND_GUILD_IDS` | **leave empty** so slash commands register globally for every server |

Build: `npm install`. Start: `npm start`. When it starts, the log shows `Per-server config mode: multi`. On startup and on every `guildCreate`, the bot creates a config row with safe defaults and sends a heartbeat every 60 s, which the dashboard shows as "Bot online".

## 4. Dashboard (Vercel)

1. Vercel → **Add New Project** → import the repo → **Root Directory: `dashboard`**. Framework: Next.js (auto-detected). Build command `next build`, install `npm install`.
2. Environment variables (Production and Preview):

| Variable | Public? | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | constrained by RLS |
| `NEXT_PUBLIC_SITE_URL` | public | e.g. `https://zigbot-dashboard.vercel.app`; used for OAuth redirects and the CSRF check |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | |
| `DISCORD_BOT_TOKEN` | **secret** | used server-side to verify membership and roles live |
| `DISCORD_CLIENT_ID` | server | invite links |
| `NVIDIA_API_KEY` | **secret** | optional; enables the Test tab |
| `AI_MODEL` | server | optional, default `openai/gpt-oss-20b` |
| `HOME_GUILD_IDS`, `BOT_CREATOR_ID` | server | optional, same meaning as on the bot |

3. Deploy, then put the final URL into `NEXT_PUBLIC_SITE_URL` and the Supabase redirect list (step 1.4), and redeploy.
4. Check: `https://<dashboard>/api/health` should return `{"ok":true,"configured":true,...}`.

## 5. Local development

```bash
# bot
cp .env.example .env            # fill in values
npm install
npm test                        # 250 tests, incl. the RLS tests against a real Postgres (PGlite)
npm start

# dashboard
cd dashboard
cp .env.example .env.local      # fill in values; NEXT_PUBLIC_SITE_URL=http://localhost:3000
npm install
npm run dev                     # http://localhost:3000
npm run build                   # production build check
```

---

## How it works

### Per-server isolation
* Every Discord event loads the config for **that event's guild ID** (`src/guildConfig/store.js`). The cache is keyed by guild ID, and a DB row whose `guild_id` doesn't match is rejected.
* Per-guild values (chat channels, cooldown, log channel, persona) are applied on a fresh settings object for each event. The audit log never posts into a log channel that belongs to a different server.
* If Supabase is unreachable the bot falls back to a fresh cache, then a stale cache, then safe defaults. It never crashes.

### AI prompt layering (`dashboard/lib/shared/prompt.js`)
1. **Platform safety rules.** Set in code, identical everywhere, and they can't be overridden.
2. **Base persona.** ZiGBoT gentle, savage or neutral, or the server's own persona when "Replace persona" is on.
3. **Server customisation.** The admin's text is fenced and labelled as lower priority.
4. **Role behaviour.** Pronouns and instructions from the member's role mappings.
5. **Platform reminder.**

Crisis detection and the output moderation filter are also enforced in code, so no prompt can turn them off. Validation rejects prompts that try to disable the safety rules, try to "grant permissions", or contain tokens or keys. AI replies can never `@everyone`, `@here` or ping roles.

### Roles and permissions
* **Mappings:** each role can have a tier (admin, moderator, member or custom), a priority, a tone, pronouns, instructions, and features set to allow or deny.
* **Precedence:** the highest-priority mapping sets tone and pronouns (ties go to the higher Discord role, then the role ID). **Deny beats allow** for features. Server-wide toggles remove features for everyone.
* **Admin tools in the bot:** the real Discord owner and Administrators are always allowed. Anyone else needs **both** the mapped feature (`moderation` / `admin_tools`) **and** the real Discord permission for that action (Kick Members for kick, and so on), plus the bot's own permission. Mappings can only restrict; they never grant.
* **Home server:** the original `SERVER_OWNER_ID` rules are unchanged.

### Dashboard security
* **Login:** Discord OAuth through Supabase (PKCE, scopes `identify guilds`). The Discord ID is read only from `identities`; `user_metadata` is user-editable, so it is never trusted.
* **Every privileged request** re-verifies the user live: Supabase `getUser()`, then a bot-token fetch of the guild and member, then computed permissions (owner, Administrator or Manage Server). Server IDs in URLs and role or channel IDs in request bodies are checked against live Discord data.
* After verification the server writes a short-lived `zb_guild_admins` row (valid 15 minutes). Writes then go through the **user's** RLS-scoped client, so the database enforces the same rule again.
* **Secrets:** the service-role key, bot token and NVIDIA key exist only server-side. `lib/env.js` imports `server-only`, so a client import fails the build. A build scan confirmed no secrets in the browser bundles.
* **Other protections:** same-origin checks on every mutating request, CSP, HSTS, `X-Frame-Options: DENY`, optimistic locking on saves (`version`), an append-only audit log written by a DB trigger, and a preview rate limit (10 per 10 minutes, enforced through RLS).

### Database (`zb_*` tables)
`zb_profiles`, `zb_guilds`, `zb_user_guilds` (OAuth server list), `zb_guild_admins` (verification proofs), `zb_guild_configs`, `zb_role_mappings`, `zb_config_audit_log`, `zb_bot_heartbeat`, `zb_preview_usage`. All have RLS enabled and anon has no grants. Browser users can only read and write servers they were verified for in the last 15 minutes.

## ZiGBoT Premium (Razorpay)

Premium is **per server**, sold as a Razorpay subscription (monthly or yearly). Buyers pay on Razorpay's hosted page with UPI Autopay, cards (Indian and international) or netbanking. It unlocks:

| Perk | Free server | Premium server |
|---|---|---|
| AI reply limit per member | `AI_RATE_LIMIT_MAX` (8/min) | `AI_RATE_LIMIT_PREMIUM_MAX` (30/min) |
| Custom persona / replace persona | locked | yes |
| Role mappings | 3 (highest priority) | up to 50 |
| Voice chat and music | off | yes |

**Servers you own are always Premium, for free.** Any server whose Discord owner is you (`SERVER_OWNER_ID` on the bot, `BOT_CREATOR_ID` on the dashboard) or that is listed in `HOME_GUILD_IDS` gets every Premium feature without paying. Legacy mode (no Supabase) has no plans, so everything works as before.

### How it works
1. An admin clicks **Monthly** or **Yearly** in the dashboard's **Premium** tab. `POST /api/guilds/<id>/billing/checkout` creates a Razorpay subscription with `notes.guild_id = <server id>` from the plan configured on the server (the browser never sends a price), stores its ID, and returns the public key ID and subscription ID.
2. The dashboard loads Razorpay **Standard Checkout** (`checkout.razorpay.com/v1/checkout.js`, only when someone pays) and opens the payment modal. On success Razorpay returns `razorpay_payment_id`, `razorpay_subscription_id` and `razorpay_signature`, which go to `POST /api/guilds/<id>/billing/verify`. That endpoint:
   - requires all three fields (400 otherwise),
   - accepts only a subscription this server started,
   - checks `HMAC-SHA256(payment_id + "|" + subscription_id, RAZORPAY_KEY_SECRET)` in constant time (400 on mismatch; nothing is activated),
   - then re-fetches the subscription from Razorpay and stores it. Premium switches on when Razorpay reports it `active`; until then the tab re-checks every 5 seconds.
   If the Checkout script is blocked (for example by an ad-blocker), the buyer is sent to Razorpay's hosted page (`short_url`) instead.
   The Content-Security-Policy allows only what Checkout needs: scripts from `checkout.razorpay.com`, frames from `api.razorpay.com`/`checkout.razorpay.com`, and Razorpay's API/telemetry hosts.
3. Razorpay also calls `/api/billing/razorpay/webhook` for activation, renewals, failed charges, halts, cancellations and completion. Every delivery must carry a valid `X-Razorpay-Signature` (HMAC-SHA256 of the raw body with our webhook secret). The subscription is then re-fetched from Razorpay; the event body itself is never trusted.
4. Rows live in `zb_guild_subscriptions`. Only the service role can write it; admins can read their own server's row (RLS). An unpaid checkout never replaces a running Premium: it waits in `pending_subscription_id`.
5. The bot reads the plan with the server's config (30 s cache) and enforces it at runtime. When a member of a **free** server hits the AI limit, ZiGBoT replies that the free version is exhausted and points to Premium via the website link in its Discord profile (set that link in the Developer Portal: **General Information → Description**). A lapsed server loses Premium features even if Premium settings are still saved. Those settings are kept, unused, until the server re-subscribes.

**Statuses:** `active` = Premium. `pending` (a renewal failed and Razorpay is retrying) and `cancelled` = Premium until the paid period ends. `created`, `authenticated`, `halted`, `completed`, `expired` and `paused` = free. Cancelling from the dashboard uses `cancel_at_cycle_end`, so Premium stays until the end of the paid period.

### Setup
1. Run `supabase/migrations/20261017000000_zigbot_premium.sql` in the Supabase SQL Editor (or `supabase db push`). It is safe to run again, and upgrades the earlier PayPal draft of the table if you ran that.
2. **dashboard.razorpay.com → Account & Settings → API Keys:** generate keys in **Test Mode** first. Copy the Key ID and Key Secret.
3. **Subscriptions → Plans:** create two plans (monthly and yearly, in INR). Copy the plan IDs (`plan_…`).
4. **Account & Settings → Webhooks → Add new webhook:** URL `https://<dashboard>/api/billing/razorpay/webhook`, a secret you choose, and these events: `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.updated`, `subscription.paused`, `subscription.resumed`.
5. **International payments:** request activation under **Account & Settings → International Payments**. Razorpay reviews this separately. Until it is approved only Indian payment methods work. International cards are charged in INR and converted by the buyer's bank. Ask Razorpay support whether recurring (subscription) charges on international cards are enabled for your account.
6. **Vercel env:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (**secret**), `RAZORPAY_PLAN_MONTHLY`, `RAZORPAY_PLAN_YEARLY`, `RAZORPAY_WEBHOOK_SECRET` (**secret**), plus the display labels `PREMIUM_PRICE_MONTHLY` / `PREMIUM_PRICE_YEARLY`. Checkout appears once the keys and both plans are set. The webhook (renewals, failures, cancellations) needs `RAZORPAY_WEBHOOK_SECRET`; without it `/api/billing/razorpay/webhook` answers 503. Never give the key secret a `NEXT_PUBLIC_` prefix: the public key ID reaches the browser through the checkout response.
7. **Render env (bot):** optionally `AI_RATE_LIMIT_PREMIUM_MAX`.
8. Test the whole flow in Test Mode with Razorpay's test cards and UPI IDs. Then switch to Live keys, recreate the plans and webhook in Live mode, and update the env vars.

## Known limitations
* Config changes reach the bot within about 30 s (cache TTL).
* The server list refreshes at login (Discord's OAuth token is used once and never stored). Every action is still verified live.
* YouTube live-chat features stay owner-only and global; they're tied to your own channel.
* Mongo-backed data (memories, warnings, behaviour) was already keyed per guild; it has not moved to Supabase.
