// ZiGBoT Studio Phase 5: visual builder (validation, simulator, SSRF, code export).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wf = require('../dashboard/lib/studio/workflows');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', '[projectId]', 'workflows');
const ROLE = '444444444444444444';
const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}-${sourceHandle || ''}`, source, target, sourceHandle });
const messages = (...rest) => ({ nodes: [node('t', 'trigger.message_create'), ...rest.filter((r) => r.type)], edges: rest.filter((r) => r.source) });

test('validation: a good workflow has no problems', () => {
    const g = messages(
        node('c', 'cond.content', { op: 'contains', value: 'hello' }),
        node('a', 'action.send_message', { content: 'Hi {{user.name}}!' }),
        node('r', 'action.add_role', { roleId: ROLE }),
        edge('t', 'c'), edge('c', 'a', 'true'), edge('c', 'r', 'false')
    );
    assert.deepEqual(wf.validateWorkflow(g).problems, []);
});

test('validation: cycles, unreachable blocks, bad inputs, unknown blocks and trigger inputs are caught', () => {
    const cyc = messages(node('a', 'logic.set_var', { name: 'x', value: '1' }), node('b', 'logic.set_var', { name: 'y', value: '2' }), edge('t', 'a'), edge('a', 'b'), edge('b', 'a'));
    assert.ok(wf.validateWorkflow(cyc).problems.some((p) => /cycle/.test(p.message)));
    const lonely = messages(node('x', 'action.send_message', { content: 'never' }));
    assert.ok(wf.validateWorkflow(lonely).problems.some((p) => p.nodeId === 'x' && /never run/.test(p.message)));
    const bad = messages(node('r', 'action.add_role', { roleId: 'not-an-id' }), node('l', 'logic.loop', { times: 51 }), node('m', 'action.send_message', { content: 'hi @everyone' }), edge('t', 'r'), edge('r', 'l'), edge('l', 'm', 'body'));
    const msgs = wf.validateWorkflow(bad).problems.map((p) => p.message).join('\n');
    assert.match(msgs, /Discord ID/);
    assert.match(msgs, /1 to 50/);
    assert.match(msgs, /@everyone/);
    assert.ok(wf.validateWorkflow(messages(node('e', 'js.eval', { code: 'process.exit()' }), edge('t', 'e'))).problems.some((p) => /Unknown block/.test(p.message)), 'no arbitrary-code block exists');
    assert.ok(wf.validateWorkflow(messages(node('a', 'action.add_reaction', { emoji: 'x', script: 'evil' }), edge('t', 'a'))).problems.some((p) => /unknown setting/.test(p.message)));
    assert.ok(wf.validateWorkflow({ nodes: [node('t', 'trigger.member_join'), node('u', 'trigger.member_leave')], edges: [edge('t', 'u')] }).problems.some((p) => /Triggers cannot have inputs/.test(p.message)));
    assert.ok(wf.validateWorkflow({ nodes: [], edges: [] }).problems.some((p) => /trigger/.test(p.message)));
    assert.match(wf.validateWorkflow({ nodes: Array.from({ length: 201 }, (_, i) => node(`n${i}`, 'trigger.member_join')), edges: [] }).problems[0].message, /At most 200/);
});

test('simulator: follows conditions on a mocked Discord and fills {{variables}} without evaluating them', () => {
    const g = messages(
        node('c', 'cond.content', { op: 'contains', value: 'hello' }),
        node('a', 'action.send_message', { content: 'Hi {{user.name}} {{constructor}} {{process.env}}' }),
        node('b', 'action.add_role', { roleId: ROLE }),
        edge('t', 'c'), edge('c', 'a', 'true'), edge('c', 'b', 'false')
    );
    const r = wf.simulate(g);
    assert.equal(r.ok, true);
    assert.deepEqual(r.actions.map((a) => a.nodeId), ['a']);
    assert.equal(r.actions[0].content, 'Hi tester  ', 'unknown placeholders become empty');
    const other = wf.simulate(g, { event: { message: { content: 'bye' } } });
    assert.deepEqual(other.actions.map((a) => a.nodeId), ['b']);
});

test('simulator: loops are capped at 50 and runs stop at the step and time budgets (no infinite loop)', () => {
    const loop = messages(node('l', 'logic.loop', { times: 50 }), node('s', 'action.add_reaction', { emoji: '👍' }), edge('t', 'l'), edge('l', 's', 'body'));
    assert.equal(wf.simulate(loop).actions.length, 50);
    const nested = messages(node('l1', 'logic.loop', { times: 50 }), node('l2', 'logic.loop', { times: 50 }), node('s', 'logic.set_var', { name: 'x', value: '1' }), edge('t', 'l1'), edge('l1', 'l2', 'body'), edge('l2', 's', 'body'));
    const started = Date.now();
    const r = wf.simulate(nested);
    assert.equal(r.ok, false);
    assert.match(r.error, /Stopped after 1000 steps/);
    assert.ok(Date.now() - started < 2000);
    let t = 0;
    const slow = wf.simulate(loop, { now: () => (t += 200) });
    assert.equal(slow.ok, false);
    assert.match(slow.error, /Stopped after 5 seconds/);
    // A cycle is refused before running at all.
    const cyc = messages(node('a', 'logic.set_var', { name: 'x', value: '1' }), edge('t', 'a'), edge('a', 'a'));
    assert.equal(wf.simulate(cyc).ok, false);
});

test('simulator: error handling, switch, variables, AI blocks are simulated (no model call)', () => {
    const g = messages(
        node('try', 'logic.try'), node('ai', 'ai.spam', { into: 'verdict' }), node('fail', 'logic.fail', { message: 'boom {{verdict}}' }),
        node('note', 'action.send_message', { content: 'caught: {{error}}' }),
        edge('t', 'try'), edge('try', 'ai', 'try'), edge('ai', 'fail'), edge('try', 'note', 'catch')
    );
    const r = wf.simulate(g, { event: { message: { content: 'free nitro here' } } });
    assert.equal(r.ok, true);
    assert.equal(r.actions[0].content, 'caught: boom spam');
    const sw = messages(node('s', 'logic.switch', { value: '{{message.content}}', cases: 'a, b, c' }), node('x', 'action.add_reaction', { emoji: 'b' }), node('d', 'action.add_reaction', { emoji: 'd' }), edge('t', 's'), edge('s', 'x', 'case2'), edge('s', 'd', 'default'));
    assert.equal(wf.simulate(sw, { event: { message: { content: 'b' } } }).actions[0].nodeId, 'x');
    assert.equal(wf.simulate(sw).actions[0].nodeId, 'd');
});

test('HTTP block: allowlist and SSRF protection (127.0.0.1, 169.254.169.254, private DNS answers)', async () => {
    for (const url of ['https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'http://api.github.com/', 'https://localhost/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f000001/', 'https://user:pw@api.github.com/', 'https://api.github.com:8443/', 'https://evil.example.com/', 'https://metadata.google.internal/', 'file:///etc/passwd']) {
        assert.ok(wf.checkUrlShape(url), url);
    }
    assert.equal(wf.checkUrlShape('https://api.github.com/repos'), null);
    const lookup = (ip) => async () => [{ address: ip }];
    assert.equal((await wf.checkHttpTarget('https://api.github.com/', { lookup: lookup('127.0.0.1') })).ok, false, 'DNS rebinding to loopback');
    assert.equal((await wf.checkHttpTarget('https://api.github.com/', { lookup: lookup('169.254.169.254') })).ok, false, 'cloud metadata');
    assert.equal((await wf.checkHttpTarget('https://api.github.com/', { lookup: lookup('::ffff:10.0.0.1') })).ok, false);
    assert.equal((await wf.checkHttpTarget('https://api.github.com/', { lookup: async () => [{ address: '140.82.112.6' }, { address: '192.168.1.1' }] })).ok, false, 'every answer must be public');
    assert.equal((await wf.checkHttpTarget('https://api.github.com/', { lookup: lookup('140.82.112.6') })).ok, true);
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.0.1', '100.64.0.1', '0.0.0.0', 'fd00::1', 'fe80::1']) assert.equal(wf.privateAddress(ip), true, ip);
    const g = messages(node('h', 'integration.http', { method: 'GET', url: 'https://169.254.169.254/' }), edge('t', 'h'));
    assert.ok(wf.validateWorkflow(g).problems.some((p) => /IP addresses/.test(p.message)));
    const ok = messages(node('h', 'integration.http', { method: 'GET', url: 'https://api.github.com/zen', into: 'zen' }), edge('t', 'h'));
    const r = wf.simulate(ok);
    assert.match(r.actions[0].did, /not sent in the simulator/);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'dashboard', 'lib', 'studio', 'workflows.js'), 'utf8').split('// ---------------------------------------------------------------- export as code')[0], /\bfetch\(/, 'the simulator never makes requests');
});

test('export: valid workflows become readable discord.js code that compiles; values cannot break out', () => {
    const g = messages(
        node('c', 'cond.content', { op: 'contains', value: '"); process.exit(1); ("' }),
        node('a', 'action.send_message', { content: 'Welcome `${process.env.TOKEN}` {{user.name}}' }),
        node('l', 'logic.loop', { times: 3 }), node('r', 'action.add_reaction', { emoji: '👋' }),
        edge('t', 'c'), edge('c', 'a', 'true'), edge('a', 'l'), edge('l', 'r', 'body')
    );
    const out = wf.exportCode(g, { name: 'Greeter flow' });
    assert.equal(out.path, 'src/workflows/greeter_flow.js');
    assert.doesNotThrow(() => new vm.Script(out.content), 'compiles (not run)');
    assert.match(out.content, /Events\.MessageCreate/);
    assert.match(out.content, /for \(let i = 0; i < 3; i \+= 1\)/);
    assert.match(out.content, /allowedMentions: SAFE/);
    assert.doesNotMatch(out.content, /\beval\(|new Function|child_process/);
    assert.ok(out.content.includes(JSON.stringify('"); process.exit(1); ("')), 'user text is JSON-quoted');
    for (const type of Object.keys(wf.BLOCKS).filter((k) => wf.BLOCKS[k].kind === 'trigger')) {
        const data = type === 'trigger.slash_command' ? { name: 'hi' } : type === 'trigger.button' ? { customId: 'b' } : type === 'trigger.schedule' ? { everyMinutes: 60 } : {};
        const code = wf.exportCode({ nodes: [node('t', type, data), node('a', 'action.add_reaction', { emoji: 'x' })], edges: [edge('t', 'a')] });
        assert.doesNotThrow(() => new vm.Script(code.content), type);
    }
    assert.ok(wf.exportCode(messages(node('x', 'action.send_message', {}))).error);
});

test('catalog covers the spec families and is plain data', () => {
    const kinds = new Set(wf.catalog().map((b) => b.kind));
    for (const k of ['trigger', 'condition', 'action', 'ai', 'logic', 'integration']) assert.ok(kinds.has(k), k);
    assert.doesNotThrow(() => JSON.stringify(wf.catalog()));
    assert.equal(wf.LIMITS.loopMax, 50);
    assert.equal(wf.LIMITS.timeoutMs, 5000);
});

test('routes: owner-only, simulator rate-limited, nothing executed', () => {
    const files = ['route.js', '[workflowId]/route.js', '[workflowId]/simulate/route.js', '[workflowId]/export/route.js'].map((f) => fs.readFileSync(path.join(API, f), 'utf8'));
    assert.match(files[0], /getOwnedProject/);
    for (const f of files.slice(1)) assert.match(f, /ownedWorkflow/);
    const shared = fs.readFileSync(path.join(ROOT, 'dashboard', 'lib', 'studio', 'workflowServer.js'), 'utf8');
    assert.match(shared, /\.eq\('owner_id', ownerId\)/);
    assert.match(shared, /\.eq\('project_id', project\.id\)/);
    assert.match(files[2], /runsPerDay/);
    for (const f of files) assert.doesNotMatch(f, /child_process|\beval\(|new Function|fetch\(/);
});
