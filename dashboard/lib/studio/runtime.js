/**
 * ZiGBoT Studio, Phase 7: deployment foundation.
 *
 * A runtime provider runs a bot somewhere ELSE (never in the dashboard or
 * ZiGBoT process). Interface:
 *   start(deployment) / stop(deployment) / restart(deployment)
 *   deploy({ project, version, files, env }) -> { ref }
 *   rollback({ from, to }) -> { ref }
 *   logs(deployment, { limit }) -> [{ at, level, line }]
 *   metrics(deployment) -> { cpu, memoryMb, uptimeSeconds, restarts }
 *
 * There is no real hosting yet: `NotAvailableProvider` refuses everything
 * ("Hosting coming soon"). `MockProvider` keeps state in memory for tests.
 * The deployment service records history (newest 10 per project), and
 * rollback re-deploys an earlier successful version's stored files.
 * Secrets: the files saved with a deployment are the exportable ones
 * (no .env/keys); environment values are handed to the provider at deploy
 * time and never stored in history.
 */
const crypto = require('node:crypto');
const projectFiles = require('./files');

const METHODS = ['start', 'stop', 'restart', 'deploy', 'rollback', 'logs', 'metrics'];
const HISTORY = 10;
const STATUSES = ['live', 'stopped', 'failed', 'superseded', 'rolled_back'];

class RuntimeNotAvailable extends Error {
    constructor() { super('Hosting coming soon: Studio cannot run bots yet. Export your project and host it yourself for now.'); this.code = 'runtime_not_available'; }
}

function assertProvider(p) {
    for (const m of METHODS) if (typeof p?.[m] !== 'function') throw new TypeError(`Runtime provider is missing ${m}()`);
    return p;
}

class NotAvailableProvider {
    constructor() { this.name = 'none'; this.available = false; }
    async start() { throw new RuntimeNotAvailable(); }
    async stop() { throw new RuntimeNotAvailable(); }
    async restart() { throw new RuntimeNotAvailable(); }
    async deploy() { throw new RuntimeNotAvailable(); }
    async rollback() { throw new RuntimeNotAvailable(); }
    async logs() { throw new RuntimeNotAvailable(); }
    async metrics() { throw new RuntimeNotAvailable(); }
}

/** In-memory provider for tests: records calls, can be told to fail. */
class MockProvider {
    constructor({ failDeploy = false } = {}) { this.name = 'mock'; this.available = true; this.calls = []; this.running = new Map(); this.failDeploy = failDeploy; this.seq = 0; }
    log(ref, line) { const r = this.running.get(ref); if (r) r.logs.push({ at: new Date(0 + this.seq++ * 1000).toISOString(), level: 'info', line }); }
    async deploy({ project, version, files, env }) {
        this.calls.push(['deploy', project.id, version, Object.keys(env || {}).sort()]);
        if (this.failDeploy) throw new Error('mock deploy failed');
        const ref = `mock-${project.id}-v${version}`;
        this.running.set(ref, { state: 'running', files: files.map((f) => f.path), logs: [], restarts: 0 });
        this.log(ref, `deployed v${version} (${files.length} files)`);
        return { ref };
    }
    async start(d) { this.calls.push(['start', d.ref]); const r = this.running.get(d.ref); if (!r) throw new Error('unknown deployment'); r.state = 'running'; this.log(d.ref, 'started'); }
    async stop(d) { this.calls.push(['stop', d.ref]); const r = this.running.get(d.ref); if (!r) throw new Error('unknown deployment'); r.state = 'stopped'; this.log(d.ref, 'stopped'); }
    async restart(d) { this.calls.push(['restart', d.ref]); const r = this.running.get(d.ref); if (!r) throw new Error('unknown deployment'); r.state = 'running'; r.restarts += 1; this.log(d.ref, 'restarted'); }
    async rollback({ from, to }) { this.calls.push(['rollback', from?.ref, to.version]); if (from && this.running.get(from.ref)) this.running.get(from.ref).state = 'stopped'; return this.deploy({ project: { id: to.project_id }, version: to.version, files: to.files, env: {} }); }
    async logs(d, { limit = 100 } = {}) { return (this.running.get(d.ref)?.logs || []).slice(-limit); }
    async metrics(d) { const r = this.running.get(d.ref); return r ? { cpu: 0.1, memoryMb: 64, uptimeSeconds: 60, restarts: r.restarts, state: r.state } : null; }
}

/** Which provider this server has. Today always "none" (no hosting infrastructure). */
function getProvider() {
    return new NotAvailableProvider();
}

const manifest = (files) => files.map((f) => ({ path: f.path, sha256: crypto.createHash('sha256').update(f.content || '', 'utf8').digest('hex').slice(0, 16), size: Buffer.byteLength(f.content || '', 'utf8') }));

/**
 * Deployment service over a small store interface (Supabase in routes,
 * in-memory in tests):
 *   store.list(projectId) -> deployments newest first
 *   store.insert(row) -> row with id; store.update(id, patch); store.prune(projectId, keep)
 */
function createDeployments({ store, provider }) {
    assertProvider(provider);
    const live = async (projectId) => (await store.list(projectId)).find((d) => d.status === 'live') || null;

    async function deploy({ project, files, env = {} }) {
        const shipped = projectFiles.exportable(files).map((f) => ({ path: f.path, content: f.content }));
        const history = await store.list(project.id);
        const version = (history[0]?.version || 0) + 1;
        const previous = history.find((d) => d.status === 'live') || null;
        let ref = null; let status = 'live'; let error = null;
        try { ({ ref } = await provider.deploy({ project, version, files: shipped, env })); } catch (e) { status = 'failed'; error = String(e?.message || e).slice(0, 300); }
        const row = await store.insert({ project_id: project.id, owner_id: project.owner_id, version, status, ref, error, provider: provider.name, manifest: manifest(shipped), files: shipped });
        if (status === 'live' && previous) await store.update(previous.id, { status: 'superseded' });
        await store.prune(project.id, HISTORY);
        return row;
    }

    async function rollback({ project, toId }) {
        const history = await store.list(project.id);
        const target = toId ? history.find((d) => d.id === toId) : history.find((d) => d.status === 'superseded' && Array.isArray(d.files));
        if (!target || target.status === 'failed' || !Array.isArray(target.files)) throw Object.assign(new Error('There is no earlier working version to roll back to.'), { code: 'no_target' });
        const current = history.find((d) => d.status === 'live') || null;
        if (current && current.id === target.id) throw Object.assign(new Error('That version is already live.'), { code: 'already_live' });
        const version = (history[0]?.version || 0) + 1;
        let ref = null; let status = 'live'; let error = null;
        try { ({ ref } = await provider.rollback({ from: current, to: target })); } catch (e) { status = 'failed'; error = String(e?.message || e).slice(0, 300); }
        const row = await store.insert({ project_id: project.id, owner_id: project.owner_id, version, status, ref, error, provider: provider.name, manifest: target.manifest, files: target.files, rolled_back_from: current?.version ?? null, source_version: target.version });
        if (status === 'live' && current) await store.update(current.id, { status: 'rolled_back' });
        await store.prune(project.id, HISTORY);
        return row;
    }

    async function control({ project, action }) {
        if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action.');
        const current = (await store.list(project.id)).find((d) => d.status === 'live' || d.status === 'stopped');
        if (!current) throw Object.assign(new Error('Deploy the bot first.'), { code: 'not_deployed' });
        await provider[action](current);
        const status = action === 'stop' ? 'stopped' : 'live';
        await store.update(current.id, { status });
        return { ...current, status };
    }

    return { deploy, rollback, control, live, logs: async (project, opts) => { const d = await live(project.id); return d ? provider.logs(d, opts) : []; }, metrics: async (project) => { const d = await live(project.id); return d ? provider.metrics(d) : null; } };
}

/** Browser view of a history row: never the stored files. */
const publicDeployment = (d) => ({ id: d.id, version: d.version, status: d.status, provider: d.provider, error: d.error || null, files: (d.manifest || []).length, createdAt: d.created_at, sourceVersion: d.source_version ?? null });

module.exports = { METHODS, STATUSES, HISTORY, RuntimeNotAvailable, NotAvailableProvider, MockProvider, assertProvider, getProvider, createDeployments, publicDeployment, manifest };
