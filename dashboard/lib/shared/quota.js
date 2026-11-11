/**
 * Race-safe usage quota: record the use FIRST, then count, and allow only
 * if the count (which includes this use) is within the limit.
 *
 * Counting first and inserting after lets N parallel requests all read the
 * same count and all pass. With claim-then-count, the k-th claim always sees
 * a count of at least k, so no more than `limit` claims can ever pass in a
 * window. A rejected claim still counts, which only makes abuse cost more.
 * Store errors propagate (fail closed). CommonJS so the tests can run it.
 *
 * insert(): records one use. count(): uses in the window, this one included.
 */
async function claimQuota({ insert, count, limit }) {
    await insert();
    const used = await count();
    return Number.isFinite(used) && used <= limit;
}

/**
 * The same idea for a cap on stored rows (e.g. greetings per server), where
 * the new row itself is the claim: insert it, count, and if the count went
 * over the limit remove that row again. Parallel creates can then never
 * leave more than `limit` rows; under a burst they may all back off, which
 * is the safe side. A broken count counts as over the limit.
 *
 * insert() -> the stored row; count() -> rows now, this one included;
 * release(row) -> deletes the row insert() returned.
 * Returns { ok: true, value: row } or { ok: false }.
 */
async function claimSlot({ insert, count, release, limit }) {
    const value = await insert();
    let used;
    try {
        used = await count();
    } catch (error) {
        await release(value);
        throw error;
    }
    if (Number.isFinite(used) && used <= limit) return { ok: true, value };
    await release(value);
    return { ok: false };
}

module.exports = { claimQuota, claimSlot };
