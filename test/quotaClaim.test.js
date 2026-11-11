// ZIGBOT-003 regression: the dashboard preview quota must hold under
// concurrent requests. Count-then-insert lets N parallel requests all read
// count=0 and all pass; claim-then-count bounds the winners to the limit.
const test = require('node:test');
const assert = require('node:assert/strict');
const { claimQuota } = require('../dashboard/lib/shared/quota');

// A shared store whose every call yields to the event loop, so parallel
// claims interleave the way real network round trips do.
function fakeStore() {
    const rows = [];
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    return {
        rows,
        insert: async () => { await tick(); rows.push(Date.now()); },
        count: async () => { await tick(); return rows.length; }
    };
}

test('claimQuota allows requests up to the limit', async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i += 1) assert.equal(await claimQuota({ ...store, limit: 3 }), true);
    assert.equal(await claimQuota({ ...store, limit: 3 }), false);
});

test('claimQuota never lets concurrent requests past the limit', async () => {
    const store = fakeStore();
    const results = await Promise.all(Array.from({ length: 40 }, () => claimQuota({ ...store, limit: 10 })));
    const allowed = results.filter(Boolean).length;
    assert.ok(allowed <= 10, `${allowed} requests passed a limit of 10`);
});

test('claimQuota fails closed when the store errors', async () => {
    await assert.rejects(claimQuota({ insert: async () => { throw new Error('db down'); }, count: async () => 0, limit: 10 }), /db down/);
    await assert.rejects(claimQuota({ insert: async () => {}, count: async () => { throw new Error('db down'); }, limit: 10 }), /db down/);
});

test('claimQuota rejects a non-numeric count instead of allowing', async () => {
    assert.equal(await claimQuota({ insert: async () => {}, count: async () => null, limit: 10 }), false);
    assert.equal(await claimQuota({ insert: async () => {}, count: async () => Number.NaN, limit: 10 }), false);
});

// The old order, kept here to show the race the fix closes.
test('documented race: count-then-insert lets concurrent requests through', async () => {
    const store = fakeStore();
    const naive = async () => { const n = await store.count(); if (n >= 10) return false; await store.insert(); return true; };
    const results = await Promise.all(Array.from({ length: 40 }, naive));
    assert.ok(results.filter(Boolean).length > 10);
});
