/**
 * The one persistent scheduler for the optional features: reminders,
 * scheduled messages, giveaway ends, auto-purge and so on.
 *
 * A job is a feature record (kind "job") with a due time, so it survives a
 * restart: whatever is due when the bot comes back simply runs then.
 *  - register(type, handler): handler(job) may return { repeatAt } to run again.
 *  - schedule(guildId, type, payload, dueAt): returns the job key.
 *  - every(fn): fn(now) is called on each tick (for daily checks).
 * Safety: a job is claimed (its due time pushed 5 minutes ahead through a
 * version check) before it runs, so two workers or overlapping ticks never
 * run it twice; a failing job is retried with backoff at most 3 times, then
 * dropped; unknown job types are dropped. Nothing here throws.
 */
const crypto = require('node:crypto');

const KIND = 'job';
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_PER_GUILD = 200;

function createScheduler({ store, now = () => Date.now(), logger = console, intervalMs = 30_000 }) {
    const handlers = new Map();
    const hooks = [];
    let timer = null;
    let running = false;
    const stats = { lastTickAt: null, ran: 0, failed: 0 };

    async function schedule(guildId, type, payload, dueAt, { key = crypto.randomUUID() } = {}) {
        if (!handlers.has(type)) throw new Error(`Unknown job type: ${type}`);
        if (!Number.isFinite(dueAt)) throw new Error('A job needs a due time.');
        const existing = await store.list(guildId, KIND, { limit: MAX_PER_GUILD + 1 });
        if (existing.length >= MAX_PER_GUILD) throw new Error(`This server already has ${MAX_PER_GUILD} scheduled items.`);
        await store.put(guildId, KIND, key, { type, payload, attempts: 0 }, { dueAt });
        return key;
    }

    const cancel = (guildId, key) => store.remove(guildId, KIND, key);
    const list = async (guildId, type = null) => (await store.list(guildId, KIND, { limit: MAX_PER_GUILD }))
        .filter((job) => !type || job.data.type === type);

    async function runJob(job) {
        const t = now();
        // Claim: only one worker gets the version bump.
        const claimed = await store.update(job.guildId, KIND, job.key, job.version, job.data, { dueAt: t + LEASE_MS });
        if (!claimed) return;
        const handler = handlers.get(job.data.type);
        if (!handler) {
            await store.remove(job.guildId, KIND, job.key);
            return;
        }
        try {
            const result = await handler({ guildId: job.guildId, key: job.key, payload: job.data.payload });
            stats.ran += 1;
            if (result && Number.isFinite(result.repeatAt)) {
                await store.update(job.guildId, KIND, job.key, claimed.version, { ...job.data, payload: result.payload ?? job.data.payload, attempts: 0 }, { dueAt: result.repeatAt });
            } else {
                await store.remove(job.guildId, KIND, job.key);
            }
        } catch (error) {
            stats.failed += 1;
            const attempts = (job.data.attempts || 0) + 1;
            logger.error?.(`[ZiGBoT SCHEDULER] ${job.data.type} failed (attempt ${attempts}): ${error?.message || error}`);
            if (attempts >= MAX_ATTEMPTS) await store.remove(job.guildId, KIND, job.key);
            else await store.update(job.guildId, KIND, job.key, claimed.version, { ...job.data, attempts }, { dueAt: t + attempts * 60_000 });
        }
    }

    async function tick() {
        if (running) return;
        running = true;
        try {
            const t = now();
            stats.lastTickAt = t;
            const due = (await store.due(t, { limit: 50 })).filter((record) => record.kind === KIND);
            for (const job of due) await runJob(job).catch((error) => logger.error?.(`[ZiGBoT SCHEDULER] ${error?.message || error}`));
            for (const hook of hooks) await Promise.resolve(hook(t)).catch((error) => logger.error?.(`[ZiGBoT SCHEDULER] hook failed: ${error?.message || error}`));
        } catch (error) {
            logger.error?.(`[ZiGBoT SCHEDULER] tick failed: ${error?.message || error}`);
        } finally {
            running = false;
        }
    }

    return {
        register: (type, handler) => handlers.set(type, handler),
        every: (fn) => hooks.push(fn),
        schedule,
        cancel,
        list,
        tick,
        start() {
            if (timer) return;
            timer = setInterval(tick, intervalMs);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        status: () => ({ ...stats, running: Boolean(timer), types: [...handlers.keys()] })
    };
}

module.exports = { createScheduler, MAX_PER_GUILD };
