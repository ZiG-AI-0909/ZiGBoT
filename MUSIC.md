# ZiGBoT Music

Music plays inside the existing bot process (Render), not on Vercel: a Discord
voice connection needs an always-on process. The dashboard (Vercel) shows the
live state and saves settings through Supabase.

```
/play ─► bot (Render) ─► yt-dlp ─► YouTube / SoundCloud ─► ffmpeg ─► Discord voice
                │
                └─► Supabase: zb_music_state / zb_music_health ─► dashboard Music tab (read-only)
dashboard settings ─► zb_guild_configs ─► bot (picked up within ~30 s)
```

## How songs are found and played

* **Song name** (`/play faded`): best match, searched on `MUSIC_SOURCE` first
  (YouTube by default), then the other source if nothing is found.
* **`/search faded`**: the top 5 results (title, artist, length, thumbnail) in a
  pick list; only the person who searched can pick, within 2 minutes.
* **Links**: YouTube (`youtube.com`, `youtu.be`, `music.youtube.com`),
  SoundCloud, or a direct `https://…mp3` file. Spotify links are refused with a
  hint to send the song name. Live streams and tracks over 3 hours are refused.
* **YouTube refuses audio to many cloud servers** (Render, AWS, …) even when
  search works. When that happens ZiGBoT plays the same song from **SoundCloud**
  and says so in the channel; it does not try to get around YouTube's block.
  Unavailable, private, deleted or age-restricted videos are reported as such.
  On a host where YouTube never works, set `MUSIC_SOURCE=soundcloud`.

## Commands

| Command | What it does | Who |
|---|---|---|
| `/play <song or link>` | Join your voice channel and play / queue | anyone with music |
| `/search <song>` | Pick from 5 results | anyone with music |
| `/pause` `/resume` `/skip` `/stop` | Playback | DJs* |
| `/queue` `/nowplaying` | Show the queue / current song | anyone |
| `/volume <1-100>` `/loop <track\|queue\|off>` `/shuffle` | Playback options | DJs* |
| `/remove <position>` `/clearqueue` | Edit the queue | DJs* |
| `/leave` | Disconnect | DJs* while music plays |

\* Only when DJ roles are set in the dashboard. Server managers, the owner, the
requester of the current song (for `/skip`) and a member alone with the bot can
always control playback. Controls also require being in the bot's voice channel.
Every song posts a **music panel** with the same controls as buttons.

Music is a **Premium** feature (always on in your own servers).

## Dashboard → 🎵 Music tab

* Music on/off, starting volume, inactivity disconnect (minutes), request
  channel, DJ roles — saved per server, admin-only (Discord-verified, RLS).
* Live "Now playing" + queue (refreshes every 10 s) from what the bot publishes.
* Service status: bot online, yt-dlp/ffmpeg ready, preferred source, active
  players, last playback error.

## Setup / deploy

1. **Supabase → SQL Editor**: run, in order (skip any already run):
   `supabase/migrations/20261019000000_zigbot_server_setup.sql`, then
   `supabase/migrations/20261019010000_zigbot_music.sql`.
   Run them **before** deploying: the bot and dashboard read the new columns.
2. **Render (bot)**: build command `npm install` (downloads yt-dlp into `bin/`;
   check the build log for `[yt-dlp] Installed yt-dlp_linux`), start command
   `npm start`. Optional env: `MUSIC_SOURCE`, `YTDLP_PATH`, `YTDLP_COOKIES_FILE`.
3. **Vercel (dashboard)**: redeploy; no new env vars.
4. **Discord Developer Portal → Bot**: no new privileged intents are needed
   (Server Members + Message Content are already on; voice states are not
   privileged). The bot needs **Connect** and **Speak** in voice channels and
   **Send Messages / Embed Links** where the panel is posted — the dashboard's
   invite link already requests these.
5. **Slash commands** register automatically when the bot starts (globally, or
   per server when `SLASH_COMMAND_GUILD_IDS` is set). Global commands can take
   a few minutes to appear in Discord.
6. Update yt-dlp without redeploying code: `npm run update-ytdlp` (each Render
   deploy already fetches the latest).

## Limits

* Audio from YouTube depends on YouTube accepting the host's IP; the SoundCloud
  fallback covers most popular songs but not every upload.
* One queue per server, up to 50 songs; state lives in the bot's memory, so a
  bot restart clears queues (the dashboard then shows "nothing playing").
* The dashboard shows state and settings; playback is controlled in Discord.
