# Security Features

## Implemented

- Phishing/scam URL, behavior, and raid-signal detection with deterministic scoring and policy decisions.
- Message quarantine is limited to message deletion and moderator alerts; the security engine does not automatically ban or kick members.
- Security incidents are kept in process memory and scoped to their guild.
- `/security status`, `/security report`, and `/security why user` are ephemeral and require Administrator or the configured `SECURITY_ADMIN_ROLE_ID`.
- Access denials for `/security` are written to the audit log.
- AI explanations are advisory only. Security analysis uses a separate system instruction and an explicitly serialized untrusted-data user turn, validates exact JSON-schema output, has a 10-second timeout, and is rate-limited per guild. Invalid output, timeouts, or provider failures are ignored; deterministic detection and reporting continue.
- Main chat and intent-classifier user turns and conversation history are serialized in untrusted user-role data, separate from system prompts. Structured tool intents are requested and validated against a strict JSON schema before routing.

## Configuration

- `SECURITY_ENABLED=false` is the emergency off switch for the new security intelligence checks; the existing Anti-Nuke system runs independently.
- `SECURITY_ADMIN_ROLE_ID` optionally grants `/security` access to one configured Discord role. Administrator permission is always accepted.
- `SECURITY_AI_RATE_LIMIT_MAX` and `SECURITY_AI_RATE_LIMIT_WINDOW_SECONDS` configure per-guild security AI limits (defaults: 8 requests per 60 seconds).

Incident history is currently ephemeral and resets when the process restarts. AI output never changes a deterministic score, policy, or enforcement action.
