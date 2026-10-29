# ZiGBoT Super Admin (`/admin`)

A private control panel on the same site (`https://zigbotai.vercel.app/admin`),
for the owner only. Same Next.js app on Vercel, same Supabase, same Discord login.

## Who can open it

* Only Discord accounts listed in **`SUPER_ADMIN_DISCORD_IDS`** (Vercel env,
  comma-separated Discord user IDs). If that is empty, `BOT_CREATOR_ID` is used.
  If neither holds a valid ID, **nobody** can open `/admin` (fails closed).
* Nothing on the website, the API or the database can add an admin. There is no
  admin column or table: the list exists only in server-side configuration.
* Everyone else, signed in or not, gets a plain 404 for `/admin/*` and every
  `/api/admin/*` route.

## How it is protected

1. Login is the existing Discord OAuth through Supabase; its session cookie is
   refreshed by `middleware.js` (now also on `/admin` and `/api/admin`).
2. Every admin page, the admin layout, and every `/api/admin` route call
   `getSuperAdmin()` / `requireSuperAdmin()` themselves (`lib/admin.js`): Supabase
   verifies the session server-side (`getUser()`), then its Discord ID is compared
   with the configured list. Hidden links are not relied on.
3. State-changing admin requests: same-origin check (CSRF) from the shared
   handler, a per-admin rate limit, and an entry in the **append-only** admin audit
   log (a database trigger refuses updates and deletes, even for the service role).
4. All admin data is read with the service role only after that check; browsers
   never get direct table access. `/admin` is `noindex` and kept out of robots/sitemap.

## Initial setup

1. Find your Discord user ID: Discord → Settings → Advanced → Developer Mode, then
   right-click your name → **Copy User ID**.
2. Vercel → your dashboard project → Settings → Environment Variables:
   `SUPER_ADMIN_DISCORD_IDS=<your id>` (Production). Optionally also set
   `BOT_CREATOR_ID` to the same ID (it powers identity review/blocks).
3. Run the Supabase migrations that are not applied yet, in order, in the SQL Editor:
   * `20261029000000_zigbot_antinuke.sql` (Security Center data)
   * `20261030000000_zigbot_scheduled_greetings.sql`
   * `20261031000000_zigbot_premium_feedback.sql` (purchases, feedback)
   * `20261101000000_zigbot_admin_audit.sql` (admin audit log)
4. Redeploy on Vercel. Sign in with Discord, then open `/admin`.

## Sections

| Page | Data |
|---|---|
| Overview | users, servers, active Premium, verified purchases, revenue, feedback, open CRITICAL incidents, bot heartbeat, 6 monthly charts |
| Users | dashboard accounts (search by username or Discord ID), purchases, feedback, visible servers |
| Servers | every server ZiGBoT joined: install state, owner, Premium, Anti-Nuke coverage, incidents; detail shows live member count from Discord |
| Premium & Revenue | Razorpay payments (captured vs pending vs failed vs refunded), verified purchases, subscriptions; CSV export |
| Forms & Responses | first-purchase feedback for ₹399 and ₹3,999: stats, comparison, filters, details, review/unreview, private note, archive, CSV |
| Security | Anti-Nuke coverage gaps, incidents across servers with evidence, containment results, steps; acknowledge/resolve |
| Analytics | the monthly charts |
| Settings & Audit | which integrations are configured, and the admin audit log |

## What it does not do (on purpose)

* No refunds: refund in the Razorpay dashboard. Revenue here is what Razorpay
  reports as captured, minus refunds (latest 300 payments).
* No suspending users: the current login model has no suspension state.
* No changing Premium entitlements: Razorpay is the source of truth.
* No reading private conversations, tokens, emails or payment details.
* No deleting feedback: responses are archived (restorable) and answers are never edited.
* Bot errors, message counts and AI usage are not stored, so they are shown as unavailable.

## Testing access

* As the admin: sign in with the configured Discord account → `/admin` loads.
* As anyone else: sign in with another Discord account → `/admin` is a 404, and
  `curl -i https://zigbotai.vercel.app/api/admin/export?type=feedback` (with or
  without that account's cookies) returns 404.
* Signed out: `/admin` and `/api/admin/*` return 404.
* Log out (sidebar) → `/admin` is a 404 again.
