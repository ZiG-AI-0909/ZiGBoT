# AI Security Audit

## Repository Audit

- Frontend: Next.js dashboard in `dashboard/` using React 19 + Next 15.
- Backend: Node.js/CommonJS Discord bot in `src/` and `index.js`.
- Discord framework: discord.js v14.27.0 with `GatewayIntentBits.GuildModeration`, `GuildMessages`, `GuildMembers`, and `MessageContent`.
- Persistence: MongoDB Atlas via `src/db/brain.js`, with Supabase-backed per-server config and security settings via the dashboard.
- Authentication and authorization: server owner validation plus per-guild admin checks in `src/security/authorization.js` and router-level guardrails in `src/tools/router.js`.
- Moderation: anti-nuke monitoring already exists in `src/antinuke/`.
- Logging: `src/logging/auditLog.js` records console and optional channel logs.
- AI integrations: `src/ai/client.js`, `src/ai/providers.js`, OpenAI-compatible provider routing.
- Security features: owner-only admin actions, confirmation flow, bot permission checks, role hierarchy checks, anti-nuke alerts.
- Gaps: no dedicated AI threat scoring pipeline, no centralized security state model, no URL isolation/SSRF-safe inspection, no security dashboard per server.

## Security Findings

1. `src/security/authorization.js` is present but not integrated into a broader security intelligence framework.
2. Security logic is mostly scattered across `src/antinuke/*`, `src/tools/router.js`, and `src/ai/*` rather than a single policy engine.
3. No database-native threat evidence schema or migration path exists for phishing/scam events.
4. AI outputs are treated as inputs but not yet separated from security policy evaluation.

## Technical Debt

- Hardcoded global configuration remains in `src/config/settings.js`.
- Security domain model is not centralized.
- No retention policy, schema validation, or cross-server isolation layer for incident data.

## Implementation Plan

1. Add a modular security engine under `src/security/`.
2. Build deterministic detection and risk scoring modules.
3. Add policy and response planning.
4. Keep production safety rules outside AI reasoning.
5. Document the architecture and limits.

## Dependencies

- `discord.js`
- `mongodb`
- `openai`/provider clients
- `dotenv`
- Next.js dashboard dependencies
