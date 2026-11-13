# Deployment Guide

## Environment Variables

- `DISCORD_TOKEN`
- `GROQ_API_KEY` and/or `NVIDIA_API_KEY` for chat and advisory security explanations
- `SECURITY_ENABLED` (`true` by default; set `false` to disable security intelligence event checks; Anti-Nuke remains enabled)
- `SECURITY_ADMIN_ROLE_ID` (optional role allowed to use `/security`; Administrator is always allowed)
- `SECURITY_AI_RATE_LIMIT_MAX` and `SECURITY_AI_RATE_LIMIT_WINDOW_SECONDS` (optional; defaults to 8 per 60 seconds per guild)
- Supabase and Mongo configuration as required by the dashboard and bot

## Setup

1. Install dependencies with `npm install`.
2. Configure required bot and provider environment variables.
3. Run `npm test` to validate the security intelligence layer.
4. Start the bot with `npm start`.

## Recovery

- Restore server configuration from dashboard or Mongo-backed state.
- Review guild-scoped security incidents with `/security report`.
- Set `SECURITY_ENABLED=false` to turn off the security intelligence layer during an incident. The existing Anti-Nuke monitoring continues independently.

## Production Recommendation

Keep deterministic policy enforcement separate from AI analysis and require moderator review for severe or critical threats. AI explanations are supplementary; provider failures, timeouts, rate limits, and invalid schema output do not change deterministic detection or reports.
