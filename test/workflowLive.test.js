// Platform Phase 3 (completed): active workflows run live inside the owner's bot via their runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const deploy = require('../dashboard/lib/studio/workflowDeploy');
const { generateProject } = require('../dashboard/lib/studio/generators');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, 'dashboard', ...p), 'utf8');
const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const greet = { nodes: [node('t', 'trigger.member_join'), node('a', 'action.send_message', { content: 'Hi {{user.name}}' })], edges: [{ id: 'e', source: 't', target: 'a' }] };
const tick = { nodes: [node('s', 'trigger.schedule', { everyMinutes: 5 }), node('b', 'logic.set_var', { name: 'x', value: '1' })], edges: [{ id: 'e', source: 's', target: 'b' }] };

test('only active, valid workflows are bundled, with one loader in src/events; JS projects only', () => {
    const out = deploy.buildWorkflowFiles([
        { id: '1', name: 'Greeter', graph: greet, active: true },
        { id: '2', name: 'Draft', graph: greet, active: false },
        { id: '3', name: 'Broken', graph: { nodes: [node('x', 'action.add_role')], edges: [] }, active: true },
        { id: '4', name: 'Greeter', graph: tick, active: true }
    ], { framework: 'discordjs' });
    assert.deepEqual(out.included.map((w) => w.id), ['1', '4']);
    assert.deepEqual(out.skipped.map((s) => s.name), ['Broken']);
    assert.deepEqual(out.files.map((f) => f.path), ['src/workflows/greeter.js', 'src/workflows/greeter_2.js', deploy.LOADER_PATH], 'same names never overwrite each other');
    assert.deepEqual(out.intents, ['GuildMembers']);
    for (const f of out.files) assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${f.content}\n})`), f.path);
    const py = deploy.buildWorkflowFiles([{ id: '1', name: 'G', graph: greet, active: true }], { framework: 'discordpy' });
    assert.equal(py.files.length, 0);
    assert.match(py.skipped[0].reason, /discord\.js \(JavaScript\)/);
    assert.equal(deploy.buildWorkflowFiles([], { framework: 'discordjs' }).files.length, 0, 'no loader without workflows');
});

test('end to end: the generated bot loads the loader, which registers the workflows on a mocked Discord client', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-live-'));
    const project = generateProject({ framework: 'discordjs', template: 'blank', name: 'Live bot', botName: 'Live' });
    const files = [...project, ...deploy.buildWorkflowFiles([{ id: '1', name: 'Greeter', graph: greet, active: true }, { id: '2', name: 'Ticker', graph: tick, active: true }], { framework: 'discordjs' }).files];
    for (const f of files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content); }
    // Mock discord.js just enough for the loader + workflow modules.
    const handlers = {}; const intervals = [];
    const Events = { ClientReady: 'ready', GuildMemberAdd: 'guildMemberAdd', InteractionCreate: 'interactionCreate' };
    const client = { on: (n, f) => { (handlers[n] ||= []).push(f); }, once: (n, f) => { (handlers[n] ||= []).push(f); }, isReady: () => true };
    const fakeRequire = (id) => (id === 'discord.js' ? { Events } : require(id));
    const load = (file) => { const m = { exports: {} }; new vm.Script(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, 'utf8')}\n})`).runInThisContext()(m.exports, (id) => (id.startsWith('.') || path.isAbsolute(id) ? load(path.resolve(path.dirname(file), id.endsWith('.js') ? id : `${id}.js`)) : fakeRequire(id)), m, file, path.dirname(file)); return m.exports; };
    const realSetInterval = global.setInterval; global.setInterval = (fn, ms) => { intervals.push(ms); return 0; };
    const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));
    try {
        const loader = load(path.join(dir, deploy.LOADER_PATH));
        assert.equal(loader.name, 'ready');
        loader.execute(client);
    } finally { global.setInterval = realSetInterval; console.log = realLog; }
    assert.equal(handlers.guildMemberAdd?.length, 1, 'member-join workflow registered');
    assert.deepEqual(intervals, [300000], 'schedule starts even though the bot was already ready');
    assert.equal(logs.filter((l) => /workflow active/.test(l)).length, 2);
});

test('Premium gates live runs at deploy time and on expiry; execute queues a runner deploy', () => {
    const bundle = read('app', 'api', 'runner', 'bundle', 'route.js');
    assert.match(bundle, /\.eq\('active', true\)/);
    assert.ok(bundle.indexOf('getEntitlementForOwner') < bundle.indexOf('buildWorkflowFiles'), 'Premium re-checked before code is added');
    assert.match(bundle, /Premium is not active: workflows stay off\./);
    const poll = read('app', 'api', 'runner', 'poll', 'route.js');
    assert.match(poll, /RECHECK_MS = 10 \* 60_000/);
    assert.match(poll, /if \(!entitlement\.premium && !entitlement\.error\)/, 'lapsed Premium queues one redeploy without workflows');
    const exec = read('app', 'api', 'studio', 'projects', '[projectId]', 'workflows', '[workflowId]', 'execute', 'route.js');
    assert.ok(exec.indexOf('getAutomationEntitlement') < exec.indexOf("action: 'deploy'"));
    assert.match(exec, /code: 'no_runner'/);
    const server = read('lib', 'studio', 'entitlementServer.js');
    assert.match(server, /export async function getEntitlementForOwner\(ownerId\)/);
    assert.match(server, /\.eq\('user_id', ownerId\)\.eq\('can_manage', true\)/, 'only that owner\'s own servers');
    assert.match(read('components', 'studio', 'WorkflowBuilder.js'), /▶ Run live now/);
});
