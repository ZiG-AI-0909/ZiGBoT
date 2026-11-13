// ZiGBoT Studio Phase 7: deployment foundation (provider interface, history, rollback).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../dashboard/lib/studio/runtime');

const ROOT = path.join(__dirname, '..');
const project = { id: 'p1', owner_id: 'u1' };
const files = (v) => [{ path: 'src/index.js', content: `v${v}` }, { path: '.env', content: 'DISCORD_TOKEN=secret' }, { path: 'key.pem', content: 'k' }];

function memoryStore() {
    const rows = [];
    let n = 0;
    return {
        rows,
        list: async (pid) => rows.filter((r) => r.project_id === pid).sort((a, b) => b.version - a.version),
        insert: async (row) => { const r = { id: `d${++n}`, created_at: new Date().toISOString(), ...row }; rows.push(r); return r; },
        update: async (id, patch) => { Object.assign(rows.find((r) => r.id === id), patch); },
        prune: async (pid, keep) => { const mine = rows.filter((r) => r.project_id === pid).sort((a, b) => b.version - a.version); for (const r of mine.slice(keep)) rows.splice(rows.indexOf(r), 1); }
    };
}

test('provider interface: start/stop/restart/deploy/rollback/logs/metrics; incomplete providers are refused', () => {
    assert.deepEqual(runtime.METHODS, ['start', 'stop', 'restart', 'deploy', 'rollback', 'logs', 'metrics']);
    assert.doesNotThrow(() => runtime.assertProvider(new runtime.MockProvider()));
    assert.doesNotThrow(() => runtime.assertProvider(new runtime.NotAvailableProvider()));
    assert.throws(() => runtime.assertProvider({ start() {} }), /missing stop/);
});

test('real hosting is NOT AVAILABLE: every action says "Hosting coming soon"', async () => {
    const p = runtime.getProvider();
    assert.equal(p.available, false);
    for (const m of runtime.METHODS) await assert.rejects(p[m]({}), /Hosting coming soon/);
});

test('deploy history with MockProvider: versions, superseded, failures, no secrets stored, newest 10', async () => {
    const store = memoryStore(); const provider = new runtime.MockProvider();
    const svc = runtime.createDeployments({ store, provider });
    const d1 = await svc.deploy({ project, files: files(1), env: { DISCORD_TOKEN: 'secret' } });
    assert.equal(d1.version, 1); assert.equal(d1.status, 'live');
    assert.deepEqual(d1.files.map((f) => f.path), ['src/index.js'], '.env and keys are never deployed or stored');
    assert.ok(!JSON.stringify(store.rows).includes('secret'), 'env values never stored in history');
    assert.deepEqual(provider.calls[0][3], ['DISCORD_TOKEN'], 'env goes to the provider only');
    const d2 = await svc.deploy({ project, files: files(2) });
    assert.equal(d2.version, 2);
    assert.equal(store.rows.find((r) => r.id === d1.id).status, 'superseded');
    provider.failDeploy = true;
    const d3 = await svc.deploy({ project, files: files(3) });
    assert.equal(d3.status, 'failed'); assert.match(d3.error, /mock deploy failed/);
    assert.equal((await svc.live(project.id)).id, d2.id, 'a failed deploy leaves the live one alone');
    provider.failDeploy = false;
    for (let i = 0; i < 12; i += 1) await svc.deploy({ project, files: files(10 + i) });
    assert.equal((await store.list(project.id)).length, 10);
    const pub = runtime.publicDeployment(d2);
    assert.ok(!('files' in pub && Array.isArray(pub.files)), 'browsers never get stored files');
});

test('rollback with MockProvider: re-deploys the previous working version; start/stop/restart/logs/metrics', async () => {
    const store = memoryStore(); const provider = new runtime.MockProvider();
    const svc = runtime.createDeployments({ store, provider });
    await assert.rejects(svc.rollback({ project }), /no earlier working version/);
    const d1 = await svc.deploy({ project, files: files(1) });
    const d2 = await svc.deploy({ project, files: files(2) });
    const r = await svc.rollback({ project });
    assert.equal(r.version, 3); assert.equal(r.status, 'live'); assert.equal(r.source_version, 1);
    assert.deepEqual(r.files, d1.files);
    assert.equal(store.rows.find((x) => x.id === d2.id).status, 'rolled_back');
    await assert.rejects(svc.rollback({ project, toId: r.id }), /already live/);
    await svc.control({ project, action: 'stop' });
    assert.equal((await store.list(project.id))[0].status, 'stopped');
    await svc.control({ project, action: 'start' });
    await svc.control({ project, action: 'restart' });
    assert.equal((await svc.metrics(project)).restarts, 1);
    assert.ok((await svc.logs(project)).some((l) => /restarted/.test(l.line)));
    await assert.rejects(svc.control({ project, action: 'exec' }), /Unknown action/);
});

test('routes and table: owner-only, writes refused without hosting, nothing runs here', () => {
    const route = fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'deployments', 'route.js'), 'utf8');
    assert.match(route, /getOwnedProject/);
    assert.match(route, /runtime_not_available/);
    assert.doesNotMatch(route + fs.readFileSync(path.join(ROOT, 'dashboard', 'lib', 'studio', 'runtime.js'), 'utf8'), /child_process|\beval\(|new Function|require\('vm'\)|docker/i);
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261115000006_studio_deployments.sql'), 'utf8');
    assert.match(sql, /grant select \(id, project_id/, 'browsers cannot read the stored files column');
    assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*to authenticated/);
});
