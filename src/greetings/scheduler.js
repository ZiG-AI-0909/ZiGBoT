/**
 * Scheduled greetings (bot worker). Runs every 30 seconds while the bot is
 * online, independent of the dashboard, and reads everything from Supabase,
 * so schedules survive restarts.
 *
 * Each due schedule is CLAIMED first with one conditional UPDATE
 * (id + version + enabled = true) that moves next_run_at to the next future
 * time and bumps version. Only one claim can win, so a retry, a restart or
 * a second worker never sends the same occurrence twice. A crash between
 * the claim and the send loses that one occurrence (at most once, never twice).
 *
 * Missed times (the bot was offline): an occurrence up to 15 minutes late is
 * still sent; older ones are skipped and recorded as "missed", and the
 * schedule continues from its next future time. Backlogs are never sent.
 */
const { PermissionFlagsBits } = require('discord.js');
const { nextOccurrence, buildGreetingMessage, GREETING_LIMITS } = require('../../dashboard/lib/shared/greetings');

const TICK_MS = 30_000;
const BATCH = 25;
const SEND_ATTEMPTS = 3;
const iso = (ms) => new Date(ms).toISOString();
const code = (error) => String(error?.code || error?.status || error?.name || 'Error').slice(0, 40);

function createGreetingScheduler({ client, guildStore, logger = console, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tickMs = TICK_MS }) {
    const enabled = Boolean(guildStore?.enabled);
    const request = (path, options) => guildStore.request(path, options);
    const log = (message) => logger.log?.(`[ZiGBoT GREETING] ${message}`);
    const warn = (message) => logger.error?.(`[ZiGBoT GREETING] ${message}`);
    let running = false;
    let timer = null;

    async function dueSchedules(t) {
        const rows = await request(`zb_greeting_schedules?enabled=eq.true&next_run_at=lte.${encodeURIComponent(iso(t))}&select=*&order=next_run_at.asc&limit=${BATCH}`);
        return Array.isArray(rows) ? rows : [];
    }

    /** Atomically take this occurrence. null when another worker or an edit got there first. */
    async function claim(row, t) {
        const next = nextOccurrence(row, t);
        const rows = await request(`zb_greeting_schedules?id=eq.${encodeURIComponent(row.id)}&version=eq.${Number(row.version)}&enabled=eq.true`, {
            method: 'PATCH',
            prefer: 'return=representation',
            body: { next_run_at: next === null ? null : iso(next), enabled: next !== null, version: Number(row.version) + 1, last_attempt_at: iso(t), last_status: 'sending', updated_at: iso(t) }
        });
        return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    }

    async function finish(row, t, status, { error = null, pause = false } = {}) {
        const body = {
            last_status: status,
            last_error: error ? String(error).slice(0, 200) : null,
            recent_runs: [{ at: iso(t), status }, ...(Array.isArray(row.recent_runs) ? row.recent_runs : [])].slice(0, GREETING_LIMITS.recentRuns)
        };
        if (status === 'sent') body.last_sent_at = iso(t);
        if (pause) {
            body.enabled = false;
            body.next_run_at = null;
        }
        await request(`zb_greeting_schedules?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body })
            .catch((e) => warn(`Status update failed for ${row.id}: ${code(e)}`));
        return status;
    }

    /** 'sent' | 'channel_missing' | 'no_permission' | 'failed' (+ error code). */
    async function send(guild, row, t) {
        const channel = guild.channels?.cache?.get(row.channel_id) || await guild.channels?.fetch?.(row.channel_id).catch(() => null);
        if (!channel || !channel.isTextBased?.()) return { status: 'channel_missing' };
        const me = guild.members?.me;
        if (!me || !channel.permissionsFor?.(me)?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return { status: 'no_permission' };
        // Pings only the schedule's chosen target (if any); nothing typed in the message pings.
        const { content, allowedMentions } = buildGreetingMessage(row, { serverName: guild.name, now: t });
        for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
            try {
                await channel.send({ content, allowedMentions });
                return { status: 'sent' };
            } catch (error) {
                if (error?.code === 10003) return { status: 'channel_missing' };
                if (error?.code === 50001 || error?.code === 50013) return { status: 'no_permission' };
                const transient = !error?.status || error.status >= 500;
                if (!transient || attempt === SEND_ATTEMPTS) return { status: 'failed', error: code(error) };
                await sleep(2000 * 2 ** (attempt - 1));
            }
        }
        return { status: 'failed' };
    }

    async function runOne(row) {
        const t = now();
        const guild = client.guilds?.cache?.get(String(row.guild_id));
        const claimed = await claim(row, t);
        if (!claimed) return 'not_claimed';
        if (!guild) return finish(claimed, t, 'bot_not_in_server', { pause: true });
        const late = t - Date.parse(row.next_run_at);
        if (late > GREETING_LIMITS.missedGraceMinutes * 60_000) {
            log(`Skipped a greeting in ${row.guild_id} that was ${Math.round(late / 60_000)} min late (the bot was offline); next: ${claimed.next_run_at || 'none'}.`);
            return finish(claimed, t, 'missed');
        }
        const result = await send(guild, claimed, t);
        // A deleted channel never comes back: pause instead of failing forever.
        return finish(claimed, t, result.status, { error: result.error, pause: result.status === 'channel_missing' });
    }

    /** One pass over due schedules. Never overlaps itself. */
    async function tick() {
        if (!enabled || running || !client.isReady?.()) return [];
        running = true;
        const results = [];
        try {
            for (const row of await dueSchedules(now())) {
                try {
                    results.push(await runOne(row));
                } catch (error) {
                    warn(`Greeting ${row.id} failed: ${code(error)}`);
                    results.push('error');
                }
            }
        } catch (error) {
            warn(`Could not read due greetings: ${code(error)}`);
        } finally {
            running = false;
        }
        return results;
    }

    function start() {
        if (!enabled) {
            log('OFF (needs the Supabase config store).');
            return null;
        }
        void tick();
        timer = setInterval(() => void tick(), tickMs);
        timer.unref?.();
        log(`Scheduler running (every ${tickMs / 1000} s).`);
        return timer;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { tick, start, stop, runOne, claim, enabled };
}

module.exports = { createGreetingScheduler, TICK_MS, SEND_ATTEMPTS };
