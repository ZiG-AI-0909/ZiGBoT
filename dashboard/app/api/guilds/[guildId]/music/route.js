import { handler, json } from '@/lib/http';
import { requireGuildAdmin } from '@/lib/auth';
import { loadBotStatus } from '@/lib/guildData';

export const dynamic = 'force-dynamic';

// A state row older than this is not trusted as "playing" (the bot may have restarted).
const STATE_FRESH_MS = 10 * 60 * 1000;
const HEALTH_FRESH_MS = 3 * 60 * 1000;

// GET: real music state for THIS guild, as published by the bot (RLS-scoped
// read: only this server's verified admins), plus music health and bot status.
// Read-only — playback is controlled from Discord, never from the browser.
export const GET = handler(async (_request, { params }) => {
    const { guildId } = await params;
    const { supabase } = await requireGuildAdmin(guildId);
    const [stateResult, healthResult, bot] = await Promise.all([
        supabase.from('zb_music_state').select('status, current_track, upcoming, queue_length, volume, loop_mode, updated_at').eq('guild_id', String(guildId)).maybeSingle(),
        supabase.from('zb_music_health').select('ready, ytdlp_version, ffmpeg_ready, preferred_source, active_players, last_error, last_error_at, updated_at').eq('id', 'main').maybeSingle(),
        loadBotStatus()
    ]);
    // A missing table means the music migration has not been applied yet.
    const migrationMissing = [stateResult.error, healthResult.error].some((e) => e && /relation|does not exist|schema cache/i.test(e.message || ''));
    if (!migrationMissing && (stateResult.error || healthResult.error)) {
        throw new Error(`Music status read failed: ${(stateResult.error || healthResult.error).message}`);
    }

    const now = Date.now();
    const state = stateResult.data || null;
    const stale = !state || !bot.online || now - new Date(state.updated_at).getTime() > STATE_FRESH_MS;
    const health = healthResult.data || null;
    return json({
        migrationMissing,
        bot,
        health: health ? { ...health, fresh: now - new Date(health.updated_at).getTime() < HEALTH_FRESH_MS } : null,
        state: state && !(stale && state.status !== 'idle')
            ? state
            : { status: 'idle', current_track: null, upcoming: [], queue_length: 0, volume: state?.volume ?? null, loop_mode: 'off', updated_at: state?.updated_at || null }
    });
});
