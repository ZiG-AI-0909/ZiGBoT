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

module.exports = { claimQuota };
