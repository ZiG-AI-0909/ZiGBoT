/**
 * ZiGBoT Studio, Phase 5: visual builder workflows.
 *
 * A workflow is JSON only ({ version, nodes, edges }, the shape React Flow
 * uses). There is NO arbitrary code: every node is one block from the fixed
 * catalog below, every field is validated, and text fields only support
 * {{variable}} placeholders (plain string replacement, never evaluated).
 *
 * The simulator runs a workflow against a MOCKED Discord: it records what
 * the bot would do and never touches Discord, the network or an AI model.
 * It is bounded: loops run at most 50 times, a run stops after 1000 steps
 * or 5 seconds, and the graph itself may not contain cycles.
 */
const net = require('node:net');

const LIMITS = Object.freeze({ nodes: 200, edges: 400, loopMax: 50, steps: 1000, timeoutMs: 5000, text: 2000, bytes: 256 * 1024, workflowsPerProject: 20, runsPerDay: 200 });
const SNOWFLAKE = /^\d{17,20}$/;
const VAR_NAME = /^[a-z][a-z0-9_]{0,31}$/i;

// Field kinds: text (with {{vars}}), number {min,max}, enum {options}, id (snowflake), url, var.
const T = (required = true, max = LIMITS.text) => ({ kind: 'text', required, max });
const N = (min, max, required = true) => ({ kind: 'number', min, max, required });
const E = (options, required = true) => ({ kind: 'enum', options, required });
const ID = (required = true) => ({ kind: 'id', required });
const V = (required = true) => ({ kind: 'var', required });

const NEXT = ['next'];
const BRANCH = ['true', 'false'];

const BLOCKS = Object.freeze({
    // Triggers (no inputs)
    'trigger.member_join': { kind: 'trigger', label: 'Member joins', fields: {}, outputs: NEXT },
    'trigger.member_leave': { kind: 'trigger', label: 'Member leaves', fields: {}, outputs: NEXT },
    'trigger.message_create': { kind: 'trigger', label: 'Message sent', fields: {}, outputs: NEXT },
    'trigger.message_update': { kind: 'trigger', label: 'Message edited', fields: {}, outputs: NEXT },
    'trigger.message_delete': { kind: 'trigger', label: 'Message deleted', fields: {}, outputs: NEXT },
    'trigger.reaction_add': { kind: 'trigger', label: 'Reaction added', fields: { emoji: T(false, 64) }, outputs: NEXT },
    'trigger.button': { kind: 'trigger', label: 'Button clicked', fields: { customId: T(true, 100) }, outputs: NEXT },
    'trigger.slash_command': { kind: 'trigger', label: 'Slash command', fields: { name: { kind: 'text', required: true, max: 32, pattern: /^[a-z0-9_-]{1,32}$/ } }, outputs: NEXT },
    'trigger.schedule': { kind: 'trigger', label: 'Schedule', fields: { everyMinutes: N(5, 10080) }, outputs: NEXT },
    'trigger.voice_state': { kind: 'trigger', label: 'Voice state changes', fields: {}, outputs: NEXT },
    // Conditions (true / false)
    'cond.has_role': { kind: 'condition', label: 'Has role', fields: { roleId: ID() }, outputs: BRANCH },
    'cond.in_channel': { kind: 'condition', label: 'In channel', fields: { channelId: ID() }, outputs: BRANCH },
    'cond.has_permission': { kind: 'condition', label: 'Has permission', fields: { permission: E(['ManageMessages', 'ManageRoles', 'KickMembers', 'BanMembers', 'Administrator', 'ModerateMembers']) }, outputs: BRANCH },
    'cond.content': { kind: 'condition', label: 'Message content', fields: { op: E(['contains', 'equals', 'starts_with']), value: T(true, 200), caseSensitive: E(['yes', 'no'], false) }, outputs: BRANCH },
    'cond.account_age': { kind: 'condition', label: 'Account age', fields: { minDays: N(0, 3650) }, outputs: BRANCH },
    'cond.user_id': { kind: 'condition', label: 'User is', fields: { userId: ID() }, outputs: BRANCH },
    'cond.server_id': { kind: 'condition', label: 'Server is', fields: { guildId: ID() }, outputs: BRANCH },
    'cond.time': { kind: 'condition', label: 'Time of day (UTC)', fields: { fromHour: N(0, 23), toHour: N(0, 23) }, outputs: BRANCH },
    'cond.variable': { kind: 'condition', label: 'Variable', fields: { name: V(), op: E(['equals', 'not_equals', 'greater', 'less']), value: T(true, 200) }, outputs: BRANCH },
    // Actions
    'action.send_message': { kind: 'action', label: 'Send message', fields: { channelId: ID(false), content: T() }, outputs: NEXT },
    'action.send_embed': { kind: 'action', label: 'Send embed', fields: { channelId: ID(false), title: T(true, 256), description: T(true, 4000), color: { kind: 'text', required: false, max: 7, pattern: /^#[0-9a-f]{6}$/i } }, outputs: NEXT },
    'action.add_role': { kind: 'action', label: 'Add role', fields: { roleId: ID() }, outputs: NEXT },
    'action.remove_role': { kind: 'action', label: 'Remove role', fields: { roleId: ID() }, outputs: NEXT },
    'action.create_channel': { kind: 'action', label: 'Create channel', fields: { name: { kind: 'text', required: true, max: 100, pattern: /^[a-z0-9_-]{1,100}$/ } }, outputs: NEXT },
    'action.delete_channel': { kind: 'action', label: 'Delete channel', fields: { channelId: ID() }, outputs: NEXT },
    'action.create_thread': { kind: 'action', label: 'Create thread', fields: { name: T(true, 100) }, outputs: NEXT },
    'action.timeout': { kind: 'action', label: 'Timeout member', fields: { minutes: N(1, 40320), reason: T(false, 512) }, outputs: NEXT },
    'action.notify_mods': { kind: 'action', label: 'Notify moderators', fields: { channelId: ID(), content: T() }, outputs: NEXT },
    'action.add_reaction': { kind: 'action', label: 'Add reaction', fields: { emoji: T(true, 64) }, outputs: NEXT },
    // AI blocks (Phase 5 simulates them; the generated bot needs its own AI key)
    'ai.classify': { kind: 'ai', label: 'AI: classify', fields: { labels: T(true, 300), into: V() }, outputs: NEXT },
    'ai.spam': { kind: 'ai', label: 'AI: spam check', fields: { into: V() }, outputs: NEXT },
    'ai.links': { kind: 'ai', label: 'AI: suspicious links', fields: { into: V() }, outputs: NEXT },
    'ai.summarize': { kind: 'ai', label: 'AI: summarize', fields: { into: V() }, outputs: NEXT },
    'ai.translate': { kind: 'ai', label: 'AI: translate', fields: { language: T(true, 40), into: V() }, outputs: NEXT },
    'ai.generate': { kind: 'ai', label: 'AI: generate text', fields: { prompt: T(true, 1000), into: V() }, outputs: NEXT },
    'ai.image': { kind: 'ai', label: 'AI: image', fields: { prompt: T(true, 1000), into: V() }, outputs: NEXT },
    // Logic
    'logic.if': { kind: 'logic', label: 'If / else', fields: { left: T(true, 200), op: E(['equals', 'not_equals', 'contains', 'greater', 'less']), right: T(true, 200) }, outputs: BRANCH },
    'logic.switch': { kind: 'logic', label: 'Switch', fields: { value: T(true, 200), cases: T(true, 300) }, outputs: ['case1', 'case2', 'case3', 'default'] },
    'logic.delay': { kind: 'logic', label: 'Delay', fields: { seconds: N(1, 3600) }, outputs: NEXT },
    'logic.set_var': { kind: 'logic', label: 'Set variable', fields: { name: V(), value: T(true, 500) }, outputs: NEXT },
    'logic.loop': { kind: 'logic', label: 'Repeat (max 50)', fields: { times: N(1, LIMITS.loopMax) }, outputs: ['body', 'done'] },
    'logic.transform': { kind: 'logic', label: 'Transform text', fields: { name: V(), op: E(['upper', 'lower', 'trim', 'length']) }, outputs: NEXT },
    'logic.try': { kind: 'logic', label: 'Handle errors', fields: {}, outputs: ['try', 'catch'] },
    'logic.fail': { kind: 'logic', label: 'Raise error', fields: { message: T(true, 200) }, outputs: [] },
    // Integrations
    'integration.webhook': { kind: 'integration', label: 'Discord webhook', fields: { url: { kind: 'url', required: true }, content: T() }, outputs: NEXT },
    'integration.http': { kind: 'integration', label: 'HTTP request (approved hosts)', fields: { method: E(['GET', 'POST']), url: { kind: 'url', required: true }, body: T(false), into: V(false) }, outputs: NEXT },
    'integration.db_get': { kind: 'integration', label: 'Database: read', fields: { key: T(true, 100), into: V() }, outputs: NEXT },
    'integration.db_set': { kind: 'integration', label: 'Database: write', fields: { key: T(true, 100), value: T(true, 500) }, outputs: NEXT }
});

// ---------------------------------------------------------------- network

/** Hosts an HTTP block may call: exact names or "*.example.com". */
const DEFAULT_HTTP_ALLOWLIST = Object.freeze(['api.github.com', 'api.openweathermap.org', 'discord.com', '*.discord.com']);

function privateAddress(ip) {
    const v = net.isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    if (v === 6) {
        const x = ip.toLowerCase().replace(/^\[|\]$/g, '');
        if (x === '::' || x === '::1') return true;
        const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return privateAddress(mapped[1]);
        return /^(fc|fd|fe[89ab]|ff)/.test(x) || /^::ffff:/.test(x) || /^64:ff9b:/.test(x);
    }
    return true; // not an IP at all: refuse
}

const hostAllowed = (host, allowlist) => allowlist.some((rule) => (rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule));

/** Static URL rule used by validation: https, no credentials, port 443, not an IP literal. */
function checkUrlShape(raw, { allowlist = DEFAULT_HTTP_ALLOWLIST, webhook = false } = {}) {
    let u;
    try { u = new URL(String(raw)); } catch { return 'Not a valid URL.'; }
    if (u.protocol !== 'https:') return 'Only https:// URLs are allowed.';
    if (u.username || u.password) return 'URLs may not contain credentials.';
    if (u.port && u.port !== '443') return 'Only the default https port is allowed.';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (net.isIP(host.replace(/^\[|\]$/g, '')) || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return 'IP addresses are not allowed; use an approved host name.';
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return 'Internal hosts are not allowed.';
    if (webhook) return /^(canary\.|ptb\.)?discord(app)?\.com$/.test(host) && /^\/api\/webhooks\/\d{17,20}\/[\w-]{20,}$/.test(u.pathname) ? null : 'Use a Discord webhook URL.';
    if (!hostAllowed(host, allowlist)) return `${host} is not on the approved host list.`;
    return null;
}

/**
 * Full SSRF check before any real request: the URL shape above, then the
 * host is resolved and EVERY address must be public. `lookup` is injectable
 * (dns.promises.lookup with { all: true } by default).
 */
async function checkHttpTarget(raw, { allowlist = DEFAULT_HTTP_ALLOWLIST, lookup } = {}) {
    const shape = checkUrlShape(raw, { allowlist });
    if (shape) return { ok: false, error: shape };
    const host = new URL(String(raw)).hostname;
    const resolve = lookup || ((h) => require('node:dns').promises.lookup(h, { all: true, verbatim: true }));
    let addresses;
    try { addresses = await resolve(host); } catch { return { ok: false, error: 'The host could not be resolved.' }; }
    const list = (Array.isArray(addresses) ? addresses : [addresses]).map((a) => (typeof a === 'string' ? a : a.address));
    if (!list.length || list.some(privateAddress)) return { ok: false, error: 'The host resolves to a private or internal address.' };
    return { ok: true, addresses: list };
}

// ---------------------------------------------------------------- validation

function validateField(name, spec, value) {
    if (value === undefined || value === null || value === '') return spec.required ? `${name} is required.` : null;
    switch (spec.kind) {
        case 'text': {
            if (typeof value !== 'string') return `${name} must be text.`;
            if (value.length > spec.max) return `${name} is longer than ${spec.max} characters.`;
            if (spec.pattern && !spec.pattern.test(value)) return `${name} has an invalid format.`;
            if (/@everyone|@here/.test(value)) return `${name} may not mention @everyone or @here.`;
            return null;
        }
        case 'number': return Number.isInteger(value) && value >= spec.min && value <= spec.max ? null : `${name} must be a whole number from ${spec.min} to ${spec.max}.`;
        case 'enum': return spec.options.includes(value) ? null : `${name} must be one of ${spec.options.join(', ')}.`;
        case 'id': return typeof value === 'string' && SNOWFLAKE.test(value) ? null : `${name} must be a Discord ID.`;
        case 'var': return typeof value === 'string' && VAR_NAME.test(value) ? null : `${name} must be a variable name (letters, digits, _).`;
        case 'url': return typeof value === 'string' && value.length <= 500 ? null : `${name} must be a URL.`;
        default: return `${name} is not supported.`;
    }
}

/** Shape-check + normalise a stored graph; returns { graph } or { error }. */
function parseGraph(input) {
    const g = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return null; } })() : input;
    if (!g || typeof g !== 'object' || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { error: 'A workflow needs nodes and edges.' };
    if (Buffer.byteLength(JSON.stringify(g), 'utf8') > LIMITS.bytes) return { error: 'The workflow is larger than 256 KB.' };
    if (g.nodes.length > LIMITS.nodes) return { error: `At most ${LIMITS.nodes} blocks.` };
    if (g.edges.length > LIMITS.edges) return { error: `At most ${LIMITS.edges} connections.` };
    const nodes = g.nodes.map((n) => ({
        id: String(n?.id ?? ''),
        type: String(n?.type ?? n?.data?.block ?? ''),
        position: { x: Number(n?.position?.x) || 0, y: Number(n?.position?.y) || 0 },
        data: n?.data && typeof n.data === 'object' && !Array.isArray(n.data) ? Object.fromEntries(Object.entries(n.data).filter(([k]) => k !== 'block' && k !== 'label')) : {}
    }));
    const edges = g.edges.map((e) => ({ id: String(e?.id ?? `${e?.source}-${e?.target}`), source: String(e?.source ?? ''), target: String(e?.target ?? ''), sourceHandle: e?.sourceHandle ? String(e.sourceHandle) : null }));
    return { graph: { version: 1, nodes, edges } };
}

/** All problems: [{ nodeId?, message }]. Empty = valid. */
function validateWorkflow(input, { allowlist = DEFAULT_HTTP_ALLOWLIST } = {}) {
    const parsed = parseGraph(input);
    if (parsed.error) return { problems: [{ message: parsed.error }] };
    const { nodes, edges } = parsed.graph;
    const problems = [];
    const byId = new Map();
    for (const n of nodes) {
        if (!/^[\w-]{1,64}$/.test(n.id)) { problems.push({ message: 'A block has an invalid id.' }); continue; }
        if (byId.has(n.id)) { problems.push({ nodeId: n.id, message: 'Two blocks share an id.' }); continue; }
        byId.set(n.id, n);
        const block = BLOCKS[n.type];
        if (!block) { problems.push({ nodeId: n.id, message: `Unknown block "${n.type}".` }); continue; }
        for (const key of Object.keys(n.data)) if (!block.fields[key]) problems.push({ nodeId: n.id, message: `${block.label}: unknown setting "${key}".` });
        for (const [name, spec] of Object.entries(block.fields)) {
            const err = validateField(name, spec, n.data[name]);
            if (err) problems.push({ nodeId: n.id, message: `${block.label}: ${err}` });
        }
        if (n.type === 'integration.http' && n.data.url) { const e = checkUrlShape(n.data.url, { allowlist }); if (e) problems.push({ nodeId: n.id, message: `${block.label}: ${e}` }); }
        if (n.type === 'integration.webhook' && n.data.url) { const e = checkUrlShape(n.data.url, { webhook: true }); if (e) problems.push({ nodeId: n.id, message: `${block.label}: ${e}` }); }
        if (n.type === 'cond.time' && Number.isInteger(n.data.fromHour) && n.data.fromHour === n.data.toHour) problems.push({ nodeId: n.id, message: 'Time of day: from and to are the same hour.' });
    }
    const out = new Map([...byId.keys()].map((id) => [id, []]));
    const incoming = new Map([...byId.keys()].map((id) => [id, 0]));
    const seenHandle = new Set();
    for (const e of edges) {
        const s = byId.get(e.source); const t = byId.get(e.target);
        if (!s || !t) { problems.push({ message: 'A connection points to a missing block.' }); continue; }
        const outputs = BLOCKS[s.type]?.outputs || [];
        const handle = e.sourceHandle || outputs[0];
        if (!outputs.includes(handle)) { problems.push({ nodeId: s.id, message: `${BLOCKS[s.type]?.label || s.type}: has no "${handle}" output.` }); continue; }
        if (BLOCKS[t.type]?.kind === 'trigger') { problems.push({ nodeId: t.id, message: 'Triggers cannot have inputs.' }); continue; }
        if (e.source === e.target) { problems.push({ nodeId: s.id, message: 'A block cannot connect to itself.' }); continue; }
        const key = `${e.source}:${handle}`;
        if (seenHandle.has(key)) { problems.push({ nodeId: s.id, message: `Output "${handle}" is connected twice; use one connection per output.` }); continue; }
        seenHandle.add(key);
        out.get(e.source).push({ handle, target: e.target });
        incoming.set(e.target, incoming.get(e.target) + 1);
    }
    const triggers = nodes.filter((n) => BLOCKS[n.type]?.kind === 'trigger' && byId.get(n.id) === n);
    if (!triggers.length) problems.push({ message: 'Add a trigger block: it decides when the workflow runs.' });
    // Cycle detection (iterative DFS, colours).
    const colour = new Map();
    for (const start of byId.keys()) {
        if (colour.get(start)) continue;
        const stack = [[start, 0]];
        colour.set(start, 1);
        while (stack.length) {
            const top = stack[stack.length - 1];
            const next = out.get(top[0])[top[1]++];
            if (!next) { colour.set(top[0], 2); stack.pop(); continue; }
            const c = colour.get(next.target);
            if (c === 1) { problems.push({ nodeId: next.target, message: 'This connection makes a cycle. Use a "Repeat (max 50)" block for loops.' }); continue; }
            if (!c) { colour.set(next.target, 1); stack.push([next.target, 0]); }
        }
    }
    // Unreachable blocks.
    const reached = new Set();
    const queue = triggers.map((n) => n.id);
    while (queue.length) { const id = queue.shift(); if (reached.has(id)) continue; reached.add(id); for (const o of out.get(id) || []) queue.push(o.target); }
    for (const id of byId.keys()) if (!reached.has(id) && BLOCKS[byId.get(id).type]) problems.push({ nodeId: id, message: 'This block can never run: nothing connects to it from a trigger.' });
    return { problems, graph: parsed.graph, out };
}

// ---------------------------------------------------------------- simulator

const fill = (text, vars) => String(text ?? '').replace(/\{\{\s*([a-z][a-z0-9_.]{0,63})\s*\}\}/gi, (_, name) => {
    const v = name.split('.').reduce((o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined), vars);
    return v === undefined || v === null || typeof v === 'object' ? '' : String(v);
});

function compare(left, op, right) {
    const ln = Number(left); const rn = Number(right);
    switch (op) {
        case 'equals': return String(left) === String(right);
        case 'not_equals': return String(left) !== String(right);
        case 'contains': return String(left).includes(String(right));
        case 'greater': return Number.isFinite(ln) && Number.isFinite(rn) && ln > rn;
        case 'less': return Number.isFinite(ln) && Number.isFinite(rn) && ln < rn;
        default: return false;
    }
}

/** A sample event for a trigger, used when the user does not supply one. */
function sampleEvent(triggerType) {
    return {
        user: { id: '111111111111111111', username: 'tester', roles: [], permissions: [], createdDaysAgo: 30 },
        guild: { id: '222222222222222222', name: 'Test server' },
        channel: { id: '333333333333333333', name: 'general' },
        message: { content: triggerType === 'trigger.slash_command' ? '' : 'hello world' },
        hourUtc: 12,
        trigger: triggerType
    };
}

class WorkflowError extends Error {}

/**
 * Run a valid workflow against a mocked Discord. Never performs I/O.
 * Returns { ok, steps: [{ nodeId, block, did }], actions, vars, error? }.
 */
function simulate(input, { triggerId, event, now = () => Date.now(), timeoutMs = LIMITS.timeoutMs, maxSteps = LIMITS.steps } = {}) {
    const { problems, graph, out } = validateWorkflow(input);
    if (problems.length) return { ok: false, error: 'Fix the workflow first.', problems, steps: [], actions: [] };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const trigger = triggerId ? byId.get(String(triggerId)) : graph.nodes.find((n) => BLOCKS[n.type].kind === 'trigger');
    if (!trigger || BLOCKS[trigger.type].kind !== 'trigger') return { ok: false, error: 'Pick a trigger to test.', steps: [], actions: [] };
    const ev = { ...sampleEvent(trigger.type), ...(event && typeof event === 'object' ? event : {}) };
    const vars = { user: { id: ev.user?.id, name: ev.user?.username }, server: { id: ev.guild?.id, name: ev.guild?.name }, channel: { id: ev.channel?.id, name: ev.channel?.name }, message: { content: String(ev.message?.content ?? '').slice(0, 2000) } };
    const db = new Map();
    const steps = []; const actions = [];
    const started = now();
    const nextOf = (id, handle) => (out.get(id) || []).find((o) => o.handle === handle)?.target || null;

    function guard() {
        if (steps.length >= maxSteps) throw new WorkflowError(`Stopped after ${maxSteps} steps.`);
        if (now() - started > timeoutMs) throw new WorkflowError(`Stopped after ${timeoutMs / 1000} seconds.`);
    }
    function act(node, did, extra = {}) { actions.push({ nodeId: node.id, type: node.type, did, ...extra }); return did; }

    // Runs from `id` until the path ends; returns nothing. Recursion depth is bounded by the DAG size.
    function run(id) {
        let current = id;
        while (current) {
            guard();
            const node = byId.get(current);
            const d = node.data;
            const block = BLOCKS[node.type];
            let handle = block.outputs[0] || null;
            let did = '';
            switch (node.type) {
                case 'cond.has_role': handle = (ev.user?.roles || []).includes(d.roleId) ? 'true' : 'false'; break;
                case 'cond.in_channel': handle = ev.channel?.id === d.channelId ? 'true' : 'false'; break;
                case 'cond.has_permission': handle = (ev.user?.permissions || []).includes(d.permission) || (ev.user?.permissions || []).includes('Administrator') ? 'true' : 'false'; break;
                case 'cond.content': {
                    const cs = d.caseSensitive === 'yes';
                    const text = cs ? vars.message.content : vars.message.content.toLowerCase();
                    const value = cs ? d.value : d.value.toLowerCase();
                    handle = (d.op === 'equals' ? text === value : d.op === 'starts_with' ? text.startsWith(value) : text.includes(value)) ? 'true' : 'false';
                    break;
                }
                case 'cond.account_age': handle = Number(ev.user?.createdDaysAgo ?? 0) >= d.minDays ? 'true' : 'false'; break;
                case 'cond.user_id': handle = ev.user?.id === d.userId ? 'true' : 'false'; break;
                case 'cond.server_id': handle = ev.guild?.id === d.guildId ? 'true' : 'false'; break;
                case 'cond.time': { const h = Number(ev.hourUtc ?? 0); handle = (d.fromHour < d.toHour ? h >= d.fromHour && h < d.toHour : h >= d.fromHour || h < d.toHour) ? 'true' : 'false'; break; }
                case 'cond.variable': handle = compare(vars[d.name], d.op, fill(d.value, vars)) ? 'true' : 'false'; break;
                case 'action.send_message': did = act(node, `send message to #${d.channelId || vars.channel.name}`, { content: fill(d.content, vars) }); break;
                case 'action.send_embed': did = act(node, `send embed to #${d.channelId || vars.channel.name}`, { title: fill(d.title, vars), description: fill(d.description, vars) }); break;
                case 'action.add_role': did = act(node, `add role ${d.roleId} to ${vars.user.name}`); break;
                case 'action.remove_role': did = act(node, `remove role ${d.roleId} from ${vars.user.name}`); break;
                case 'action.create_channel': did = act(node, `create channel #${d.name}`); break;
                case 'action.delete_channel': did = act(node, `delete channel ${d.channelId}`); break;
                case 'action.create_thread': did = act(node, `create thread "${fill(d.name, vars)}"`); break;
                case 'action.timeout': did = act(node, `timeout ${vars.user.name} for ${d.minutes} min`); break;
                case 'action.notify_mods': did = act(node, `notify moderators in ${d.channelId}`, { content: fill(d.content, vars) }); break;
                case 'action.add_reaction': did = act(node, `react with ${d.emoji}`); break;
                case 'ai.classify': vars[d.into] = String(d.labels).split(',')[0].trim(); did = `(simulated) classified as "${vars[d.into]}"`; break;
                case 'ai.spam': vars[d.into] = /(.)\1{9,}|free nitro|https?:\/\//i.test(vars.message.content) ? 'spam' : 'ok'; did = `(simulated) spam check: ${vars[d.into]}`; break;
                case 'ai.links': vars[d.into] = /https?:\/\/(?!discord\.com)/i.test(vars.message.content) ? 'suspicious' : 'ok'; did = `(simulated) links: ${vars[d.into]}`; break;
                case 'ai.summarize': vars[d.into] = vars.message.content.slice(0, 100); did = '(simulated) summary'; break;
                case 'ai.translate': vars[d.into] = `[${d.language}] ${vars.message.content}`; did = '(simulated) translation'; break;
                case 'ai.generate': vars[d.into] = `(AI text for: ${fill(d.prompt, vars).slice(0, 80)})`; did = '(simulated) generated text'; break;
                case 'ai.image': vars[d.into] = 'https://example.invalid/simulated.png'; did = '(simulated) image'; break;
                case 'logic.if': handle = compare(fill(d.left, vars), d.op, fill(d.right, vars)) ? 'true' : 'false'; break;
                case 'logic.switch': {
                    const cases = String(d.cases).split(',').map((s) => s.trim());
                    const i = cases.indexOf(fill(d.value, vars));
                    handle = i >= 0 && i < 3 ? `case${i + 1}` : 'default';
                    break;
                }
                case 'logic.delay': did = `wait ${d.seconds}s (skipped in the simulator)`; break;
                case 'logic.set_var': vars[d.name] = fill(d.value, vars); did = `${d.name} = "${vars[d.name]}"`; break;
                case 'logic.transform': {
                    const v = String(vars[d.name] ?? '');
                    vars[d.name] = d.op === 'upper' ? v.toUpperCase() : d.op === 'lower' ? v.toLowerCase() : d.op === 'trim' ? v.trim() : String(v.length);
                    did = `${d.name} → "${vars[d.name]}"`;
                    break;
                }
                case 'logic.loop': {
                    const body = nextOf(node.id, 'body');
                    const times = Math.min(d.times, LIMITS.loopMax);
                    steps.push({ nodeId: node.id, block: block.label, did: `repeat ${times}×` });
                    for (let i = 0; i < times; i += 1) { vars.loop = { index: i }; if (body) run(body); }
                    current = nextOf(node.id, 'done');
                    continue;
                }
                case 'logic.try': {
                    steps.push({ nodeId: node.id, block: block.label, did: 'try' });
                    try { const t = nextOf(node.id, 'try'); if (t) run(t); } catch (e) {
                        if (!(e instanceof WorkflowError) || /^Stopped after/.test(e.message)) throw e;
                        vars.error = e.message;
                        steps.push({ nodeId: node.id, block: block.label, did: `caught: ${e.message}` });
                        const c = nextOf(node.id, 'catch'); if (c) run(c);
                    }
                    current = null;
                    continue;
                }
                case 'logic.fail': steps.push({ nodeId: node.id, block: block.label, did: 'raise error' }); throw new WorkflowError(fill(d.message, vars));
                case 'integration.webhook': did = act(node, 'post to Discord webhook (not sent in the simulator)', { content: fill(d.content, vars) }); break;
                case 'integration.http': did = act(node, `${d.method} ${new URL(d.url).host} (not sent in the simulator)`); if (d.into) vars[d.into] = '{"simulated":true}'; break;
                case 'integration.db_get': vars[d.into] = db.get(fill(d.key, vars)) ?? ''; did = `read ${fill(d.key, vars)}`; break;
                case 'integration.db_set': db.set(fill(d.key, vars), fill(d.value, vars)); did = `write ${fill(d.key, vars)}`; break;
                default: if (block.kind === 'trigger') did = `triggered: ${block.label}`;
            }
            if (block.kind === 'condition' || node.type === 'logic.if' || node.type === 'logic.switch') did = `→ ${handle}`;
            steps.push({ nodeId: node.id, block: block.label, did });
            current = handle ? nextOf(node.id, handle) : null;
        }
    }

    try {
        run(trigger.id);
        return { ok: true, steps, actions, vars: redactVars(vars) };
    } catch (e) {
        return { ok: false, error: e instanceof WorkflowError ? e.message : 'The simulator hit an internal error.', steps, actions, vars: redactVars(vars) };
    }
}

const redactVars = (vars) => JSON.parse(JSON.stringify(vars, (k, v) => (typeof v === 'string' ? v.slice(0, 500) : v)));

// ---------------------------------------------------------------- export as code

const q = (s) => JSON.stringify(String(s ?? ''));
const EVENTS = {
    'trigger.member_join': ['GuildMemberAdd', 'member', 'member.guild.systemChannel'],
    'trigger.member_leave': ['GuildMemberRemove', 'member', 'member.guild.systemChannel'],
    'trigger.message_create': ['MessageCreate', 'message', 'message.channel'],
    'trigger.message_update': ['MessageUpdate', '_old, message', 'message.channel'],
    'trigger.message_delete': ['MessageDelete', 'message', 'message.channel'],
    'trigger.reaction_add': ['MessageReactionAdd', 'reaction, user', 'reaction.message.channel'],
    'trigger.voice_state': ['VoiceStateUpdate', '_old, state', 'null']
};

/** discord.js (JavaScript) module for the workflow: readable, no eval, values JSON-quoted. */
function exportCode(input, { name = 'workflow' } = {}) {
    const { problems, graph, out } = validateWorkflow(input);
    if (problems.length) return { error: 'Fix the workflow before exporting it.', problems };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const nextOf = (id, h) => (out.get(id) || []).find((o) => o.handle === h)?.target || null;
    const lines = [];
    const emit = (depth, text) => lines.push(`${'    '.repeat(depth)}${text}`);
    const cond = (n) => {
        const d = n.data;
        switch (n.type) {
            case 'cond.has_role': return `ctx.member?.roles?.cache?.has(${q(d.roleId)})`;
            case 'cond.in_channel': return `ctx.channel?.id === ${q(d.channelId)}`;
            case 'cond.has_permission': return `ctx.member?.permissions?.has(${q(d.permission)})`;
            case 'cond.content': { const t = d.caseSensitive === 'yes' ? 'ctx.content' : 'ctx.content.toLowerCase()'; const v = q(d.caseSensitive === 'yes' ? d.value : d.value.toLowerCase()); return d.op === 'equals' ? `${t} === ${v}` : d.op === 'starts_with' ? `${t}.startsWith(${v})` : `${t}.includes(${v})`; }
            case 'cond.account_age': return `(Date.now() - (ctx.user?.createdTimestamp ?? Date.now())) / 86400000 >= ${d.minDays}`;
            case 'cond.user_id': return `ctx.user?.id === ${q(d.userId)}`;
            case 'cond.server_id': return `ctx.guild?.id === ${q(d.guildId)}`;
            case 'cond.time': return d.fromHour < d.toHour ? `new Date().getUTCHours() >= ${d.fromHour} && new Date().getUTCHours() < ${d.toHour}` : `new Date().getUTCHours() >= ${d.fromHour} || new Date().getUTCHours() < ${d.toHour}`;
            case 'cond.variable': return `compare(vars[${q(d.name)}], ${q(d.op)}, fill(${q(d.value)}, vars))`;
            case 'logic.if': return `compare(fill(${q(d.left)}, vars), ${q(d.op)}, fill(${q(d.right)}, vars))`;
            default: return 'false';
        }
    };
    function block(id, depth) {
        let cur = id;
        while (cur) {
            const n = byId.get(cur); const d = n.data; const b = BLOCKS[n.type];
            const ch = d.channelId ? `await ctx.client.channels.fetch(${q(d.channelId)})` : 'ctx.channel';
            emit(depth, `// ${b.label}`);
            if (b.kind === 'condition' || n.type === 'logic.if') {
                emit(depth, `if (${cond(n)}) {`); const t = nextOf(n.id, 'true'); if (t) block(t, depth + 1);
                emit(depth, '} else {'); const f = nextOf(n.id, 'false'); if (f) block(f, depth + 1);
                emit(depth, '}'); return;
            }
            switch (n.type) {
                case 'action.send_message': emit(depth, `await (${ch})?.send({ content: fill(${q(d.content)}, vars), allowedMentions: SAFE });`); break;
                case 'action.send_embed': emit(depth, `await (${ch})?.send({ embeds: [{ title: fill(${q(d.title)}, vars), description: fill(${q(d.description)}, vars)${d.color ? `, color: ${parseInt(d.color.slice(1), 16)}` : ''} }], allowedMentions: SAFE });`); break;
                case 'action.add_role': emit(depth, `await ctx.member?.roles.add(${q(d.roleId)});`); break;
                case 'action.remove_role': emit(depth, `await ctx.member?.roles.remove(${q(d.roleId)});`); break;
                case 'action.create_channel': emit(depth, `await ctx.guild?.channels.create({ name: ${q(d.name)} });`); break;
                case 'action.delete_channel': emit(depth, `await (await ctx.guild?.channels.fetch(${q(d.channelId)}))?.delete();`); break;
                case 'action.create_thread': emit(depth, `await ctx.channel?.threads?.create({ name: fill(${q(d.name)}, vars).slice(0, 100) });`); break;
                case 'action.timeout': emit(depth, `await ctx.member?.timeout(${d.minutes * 60000}, ${q(d.reason || 'Workflow')});`); break;
                case 'action.notify_mods': emit(depth, `await (await ctx.client.channels.fetch(${q(d.channelId)}))?.send({ content: fill(${q(d.content)}, vars), allowedMentions: SAFE });`); break;
                case 'action.add_reaction': emit(depth, `await ctx.message?.react(${q(d.emoji)});`); break;
                case 'logic.delay': emit(depth, `await new Promise((r) => setTimeout(r, ${d.seconds * 1000}));`); break;
                case 'logic.set_var': emit(depth, `vars[${q(d.name)}] = fill(${q(d.value)}, vars);`); break;
                case 'logic.transform': emit(depth, `vars[${q(d.name)}] = transform(vars[${q(d.name)}], ${q(d.op)});`); break;
                case 'logic.loop': { emit(depth, `for (let i = 0; i < ${Math.min(d.times, LIMITS.loopMax)}; i += 1) {`); emit(depth + 1, 'vars.loop = { index: i };'); const body = nextOf(n.id, 'body'); if (body) block(body, depth + 1); emit(depth, '}'); cur = nextOf(n.id, 'done'); continue; }
                case 'logic.try': { emit(depth, 'try {'); const t = nextOf(n.id, 'try'); if (t) block(t, depth + 1); emit(depth, '} catch (error) {'); emit(depth + 1, 'vars.error = String(error?.message || error);'); const c = nextOf(n.id, 'catch'); if (c) block(c, depth + 1); emit(depth, '}'); return; }
                case 'logic.fail': emit(depth, `throw new Error(fill(${q(d.message)}, vars));`); return;
                case 'logic.switch': {
                    const cases = String(d.cases).split(',').map((s) => s.trim()).slice(0, 3);
                    emit(depth, `switch (fill(${q(d.value)}, vars)) {`);
                    cases.forEach((c, i) => { emit(depth + 1, `case ${q(c)}: {`); const t = nextOf(n.id, `case${i + 1}`); if (t) block(t, depth + 2); emit(depth + 2, 'break;'); emit(depth + 1, '}'); });
                    emit(depth + 1, 'default: {'); const t = nextOf(n.id, 'default'); if (t) block(t, depth + 2); emit(depth + 1, '}');
                    emit(depth, '}'); return;
                }
                case 'integration.webhook': emit(depth, `await safeFetch(${q(d.url)}, { method: 'POST', body: { content: fill(${q(d.content)}, vars), allowed_mentions: { parse: [] } } });`); break;
                case 'integration.http': emit(depth, `${d.into ? `vars[${q(d.into)}] = ` : ''}await safeFetch(${q(d.url)}, { method: ${q(d.method)}${d.body ? `, body: fill(${q(d.body)}, vars)` : ''} });`); break;
                case 'integration.db_get': emit(depth, `vars[${q(d.into)}] = store.get(fill(${q(d.key)}, vars)) ?? '';`); break;
                case 'integration.db_set': emit(depth, `store.set(fill(${q(d.key)}, vars), fill(${q(d.value)}, vars));`); break;
                default:
                    if (b.kind === 'ai') emit(depth, `vars[${q(d.into)}] = await ai(${q(n.type.slice(3))}, ${q(d.prompt || d.labels || d.language || '')}, vars); // needs your own AI provider`);
            }
            const h = b.outputs[0];
            cur = h ? nextOf(n.id, h) : null;
        }
    }
    const fnName = String(name).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'workflow';
    lines.push(`// Generated by ZiGBoT Studio from the visual workflow "${String(name).replace(/[^\w .-]/g, '')}".`);
    lines.push('// Plain discord.js code: no eval, values are fixed strings, @everyone/@here are blocked.');
    lines.push("const { Events } = require('discord.js');", '');
    lines.push('const SAFE = { parse: [] };', 'const store = new Map(); // swap for a real database', '');
    lines.push("const fill = (text, vars) => String(text).replace(/\\{\\{\\s*([a-z][a-z0-9_.]{0,63})\\s*\\}\\}/gi, (_, k) => { const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), vars); return v == null || typeof v === 'object' ? '' : String(v); });");
    lines.push("const compare = (a, op, b) => (op === 'equals' ? String(a) === String(b) : op === 'not_equals' ? String(a) !== String(b) : op === 'contains' ? String(a).includes(String(b)) : op === 'greater' ? Number(a) > Number(b) : op === 'less' ? Number(a) < Number(b) : false);");
    lines.push("const transform = (v, op) => { const s = String(v ?? ''); return op === 'upper' ? s.toUpperCase() : op === 'lower' ? s.toLowerCase() : op === 'trim' ? s.trim() : String(s.length); };");
    lines.push("async function ai() { throw new Error('Connect an AI provider to use AI blocks.'); }");
    lines.push(`const ALLOWED_HOSTS = ${JSON.stringify(DEFAULT_HTTP_ALLOWLIST)};`);
    lines.push("async function safeFetch(url, { method = 'GET', body } = {}) {");
    lines.push("    const u = new URL(url);");
    lines.push("    const ok = u.protocol === 'https:' && (/^(canary\\.|ptb\\.)?discord(app)?\\.com$/.test(u.hostname) || ALLOWED_HOSTS.some((h) => (h.startsWith('*.') ? u.hostname.endsWith(h.slice(1)) : u.hostname === h)));");
    lines.push("    if (!ok) throw new Error(`Host not allowed: ${u.hostname}`);");
    lines.push("    const res = await fetch(u, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });");
    lines.push("    return (await res.text()).slice(0, 2000);");
    lines.push('}', '');
    lines.push('function context(client, guild, channel, member, user, message) {');
    lines.push("    return { client, guild, channel, member, user, message, content: message?.content ?? '' };");
    lines.push('}', '');
    lines.push(`module.exports = function register_${fnName}(client) {`);
    const triggers = graph.nodes.filter((n) => BLOCKS[n.type].kind === 'trigger');
    for (const t of triggers) {
        const first = nextOf(t.id, 'next');
        const ev = EVENTS[t.type];
        if (t.type === 'trigger.slash_command' || t.type === 'trigger.button') {
            const test = t.type === 'trigger.slash_command' ? `i.isChatInputCommand() && i.commandName === ${q(t.data.name)}` : `i.isButton() && i.customId === ${q(t.data.customId)}`;
            emit(1, `client.on(Events.InteractionCreate, async (i) => {`);
            emit(2, `if (!(${test})) return;`);
            emit(2, 'const ctx = context(client, i.guild, i.channel, i.member, i.user, null);');
        } else if (t.type === 'trigger.schedule') {
            emit(1, `client.once(Events.ClientReady, () => setInterval(async () => {`);
            emit(2, 'const ctx = context(client, null, null, null, null, null);');
        } else {
            const [event, args] = ev;
            const subject = args.split(', ').pop();
            emit(1, `client.on(Events.${event}, async (${args}) => {`);
            if (subject === 'member') emit(2, 'const ctx = context(client, member.guild, member.guild.systemChannel, member, member.user, null);');
            else if (subject === 'message') { emit(2, 'if (message.author?.bot) return;'); emit(2, 'const ctx = context(client, message.guild, message.channel, message.member, message.author, message);'); }
            else if (subject === 'user') emit(2, 'const ctx = context(client, reaction.message.guild, reaction.message.channel, null, user, reaction.message);');
            else emit(2, 'const ctx = context(client, state.guild, state.channel, state.member, state.member?.user, null);');
        }
        emit(2, 'const vars = { user: { id: ctx.user?.id, name: ctx.user?.username }, server: { id: ctx.guild?.id, name: ctx.guild?.name }, channel: { id: ctx.channel?.id, name: ctx.channel?.name }, message: { content: ctx.content } };');
        emit(2, 'try {');
        if (first) block(first, 3);
        emit(2, '} catch (error) {');
        emit(3, `console.error(${q(`[workflow ${fnName}]`)}, error?.message || error);`);
        emit(2, '}');
        emit(1, t.type === 'trigger.schedule' ? `}, ${t.data.everyMinutes * 60000}));` : '});');
    }
    lines.push('};', '');
    return { path: `src/workflows/${fnName}.js`, content: lines.join('\n') };
}

/** The catalog for the editor palette (no functions or regexes). */
function catalog() {
    return Object.entries(BLOCKS).map(([type, b]) => ({
        type, kind: b.kind, label: b.label, outputs: b.outputs,
        fields: Object.entries(b.fields).map(([name, f]) => ({ name, kind: f.kind, required: f.required, max: f.max, min: f.min, options: f.options }))
    }));
}

module.exports = { BLOCKS, LIMITS, DEFAULT_HTTP_ALLOWLIST, catalog, parseGraph, validateWorkflow, simulate, exportCode, checkUrlShape, checkHttpTarget, privateAddress, fill };
