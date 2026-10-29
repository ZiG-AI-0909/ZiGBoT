# ZiGBoT Anti-Nuke

Free for every server. Monitoring and alerts are always on; only the optional
automatic containment can be switched off. It runs inside the existing bot
process (Render); the dashboard (Vercel) shows status and history and saves
settings through Supabase.

```
Discord audit log (live) ─► bot: engine ─► incident ─► containment (opt-in) ─► alert channel / owner DM
member joins ───────────┘                     │
                                              └─► Supabase: zb_security_events / zb_security_status ─► dashboard 🛡️ Anti-Nuke tab
dashboard settings ─► zb_security_settings ─► bot (picked up within ~60 s)
```

## What it detects

Counts are per account inside a rolling window (default 60 s); joins are per
server. One deletion, ban or permission change never alerts on its own.

| Rule | Severity | Default trigger |
|---|---|---|
| Mass deletion of channels or roles | CRITICAL | 4 in the window |
| Mass bans, kicks or prune | CRITICAL | 5 in the window (prune counts every removed member) |
| Dangerous permissions followed by deletions | CRITICAL | a grant, then 2 deletions, same account |
| Burst of new channels or roles | HIGH | 8 in the window |
| Administrator granted (role, new role, or member) | HIGH | 1 |
| Repeated role/channel permission changes | HIGH | 6 in the window |
| Bot added with Administrator | HIGH | 1 |
| Burst of webhook changes | HIGH | 3 in the window |
| Join burst (possible raid) | HIGH | 10 joins in 30 s |
| Other dangerous permission granted | MEDIUM | 1 |
| Bot added with other powerful permissions | MEDIUM | 1 |
| Burst of moderation actions | MEDIUM | 3 bans/kicks (below the CRITICAL count) |

Trusted accounts, the server owner and maintenance mode skip HIGH/MEDIUM rules;
a burst three times the CRITICAL threshold still alerts for them. ZiGBoT's own
actions are never judged. All thresholds, the cooldown, trusted accounts and
maintenance mode are set in the dashboard.

## Alerts

* Posted in the security alert channel. When ZiGBoT joins a server and may
  create channels, it creates a private `#zigbot-security` (only admins can see
  it). Existing servers: pick a channel in the dashboard; until then alerts go
  to the owner by DM.
* Pings only: the owner (on by default), the configured staff role (HIGH and
  CRITICAL), and `@everyone` for CRITICAL only if an admin turned that on. The
  actor and affected members are shown but never pinged.
* One alert per incident type and account per cooldown (default 10 min),
  unless it becomes more severe. At most 10 alerts per server per 10 minutes;
  incidents past that are still recorded (`held`).
* Each alert says what happened, why it was flagged, what containment actually
  did (verified), and step-by-step guidance. It never claims anything was
  blocked or restored.

## Optional containment (off by default)

* **Remove dangerous roles from an attacker** (CRITICAL incidents only;
  needs Manage Roles). Removed role IDs are recorded so admins can give them back.
* **Kick bots added with Administrator** by an account that is not the owner or
  trusted (needs Kick Members). Kick, never ban.

Never the server owner, never ZiGBoT itself, never roles above ZiGBoT's highest
role or managed by an integration. Results are checked against Discord
afterwards; failures and partial results are reported as such.

## Requirements

* **Gateway intent:** `GuildModeration` (added in `src/index.js`; not a
  privileged intent, nothing to enable in the Developer Portal). `GuildMembers`
  (already used) gives member joins.
* **Bot permissions:** View Audit Log (baseline — without it ZiGBoT cannot see
  who did what), View Channels, Send Messages; Manage Channels to create the
  alert channel; Manage Roles / Kick Members only for the matching containment
  option. The invite link now asks for View Audit Log. Servers that added
  ZiGBoT earlier: give ZiGBoT's role View Audit Log (the Anti-Nuke tab lists
  exactly what is missing, with a re-invite link).
* **Database:** run `supabase/migrations/20261029000000_zigbot_antinuke.sql` in
  the Supabase SQL Editor (additive, re-runnable). Without it, monitoring and
  alerts still work with default settings, but nothing is stored and the
  dashboard cannot save settings.
* **Optional env (bot):** `DASHBOARD_URL` (default `https://zigbotai.vercel.app`)
  for the link in alerts.

## Limits (honest)

* Discord reports actions after they happen; ZiGBoT detects and alerts within
  seconds but cannot stop an action before Discord carries it out.
* Deleted channels, roles and messages cannot be restored by Discord or ZiGBoT.
* Detection windows live in memory: after a restart they start empty.
  Recorded incidents, settings and status are kept.
* Each server's event queue holds 500 events; past that, events are dropped
  (the burst has already alerted by then).
* Incidents are deleted after 90 days.
