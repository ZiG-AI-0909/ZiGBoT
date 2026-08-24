# ZiGBoT

ZiGBoT is a witty, stress-relieving Discord chat companion and auto-reply bot designed to mingle with server members, lighten the mood with dry humor, and offer fun conversation to de-stress. It is built on Node.js with discord.js and LLM integrations (NVIDIA NIM / OpenAI-compatible APIs).

## Features

### 💬 Funny & Stress-Relief Auto-Reply
- **Direct Mentions & Message Replies**: Responds when pinged (`@ZiGBoT`) or when a user directly replies to one of ZiGBoT's messages.
- **Dedicated Chat Channels**: Auto-replies to all messages in specific channels configured in `CHAT_CHANNEL_IDS`.
- **Stress & Mingle Triggers**: Automatically detects when members talk about being *stressed*, *exhausted*, *burnt out*, facing *deadlines*, or asking for *jokes/roasts/cheering up*.
- **Anti-Spam Rate Limiting**: Built-in channel & user cooldowns (`COOLDOWN_SECONDS`) so the bot mingles naturally without flooding the chat.
- **Sliding Multi-Turn Memory**: Keeps recent conversation context per channel so banter feels continuous and organic.

### 🛡️ Security & Administration
- Owner-authorized tools for role/channel management and moderation.
- Bot permission and role-hierarchy checks.
- Audit logging to console and optional `LOG_CHANNEL_ID`.

### 🔊 Voice & Music
- Optional push-to-talk voice capture with local Whisper/Piper STT/TTS executables.
- Compliant direct-HTTPS music queue and playback controls.

---

## Getting Started

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Configure your credentials in `.env`:
   - `DISCORD_TOKEN`: Your Discord Bot token from the Discord Developer Portal.
   - `NVIDIA_API_KEY`: API key for NVIDIA NIM AI inference (or OpenAI-compatible endpoint).
   - `CHAT_CHANNEL_IDS`: (Optional) Comma-separated list of Discord channel IDs where the bot should chat with all messages.
   - `AUTO_REPLY_KEYWORDS`: `true` to enable smart stress and banter triggers.
   - `COOLDOWN_SECONDS`: Anti-spam cooldown in seconds (default: `15`).
   - `SERVER_OWNER_ID`: Discord user ID of the server owner for administrative commands. For ZiG's server, use `1296202178263912448`.
   - `SERVER_OWNER_ROLE_NAME`: Display name of the server owner's role (`꧁༺ ZiG ༻꧂`). This is informational; administrative access still requires the configured owner ID and actual Discord guild ownership.
3. Start the bot:
   ```bash
   npm start
   ```

---

## Validation & Testing

```bash
npm test
npm run check
```
