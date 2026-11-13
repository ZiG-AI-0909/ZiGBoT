'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, addEdge, applyNodeChanges, applyEdgeChanges, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import PremiumPaywall from './PremiumPaywall';

const KIND_COLOUR = { trigger: '#8b5cf6', condition: '#f59e0b', action: '#22c55e', ai: '#ec4899', logic: '#38bdf8', integration: '#f97316' };
const KIND_LABEL = { trigger: 'Triggers', condition: 'Conditions', action: 'Actions', ai: 'AI', logic: 'Logic', integration: 'Integrations' };

async function call(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' }, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Something went wrong.'), { body });
    return body;
}

// Stored graph ⇄ React Flow. Stored nodes: { id, type: <block>, position, data: <field values> }.
const toFlow = (graph) => ({
    nodes: (graph?.nodes || []).map((n) => ({ id: n.id, type: 'block', position: n.position || { x: 0, y: 0 }, data: { block: n.type, values: n.data || {} } })),
    edges: (graph?.edges || []).map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || undefined, label: e.sourceHandle && !['next'].includes(e.sourceHandle) ? e.sourceHandle : undefined }))
});
const fromFlow = (nodes, edges) => ({
    version: 1,
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.block, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data.values })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || null }))
});

function BlockNode({ data, selected }) {
    const b = data.def;
    if (!b) return <div className="card" style={{ padding: 8 }}>Unknown block</div>;
    const colour = KIND_COLOUR[b.kind];
    return (
        <div style={{ minWidth: 170, borderRadius: 10, border: `2px solid ${selected ? '#fff' : colour}`, background: 'var(--panel, #111827)', color: 'var(--text, #e5e7eb)', fontSize: 12, outline: data.problem ? '2px solid #ef4444' : 'none' }}>
            {b.kind !== 'trigger' ? <Handle type="target" position={Position.Left} /> : null}
            <div style={{ background: colour, color: '#0b0b0f', padding: '3px 8px', borderRadius: '7px 7px 0 0', fontWeight: 700 }}>{b.label}</div>
            <div style={{ padding: '6px 8px', opacity: 0.85 }}>
                {Object.entries(data.values || {}).slice(0, 3).map(([k, v]) => <div key={k} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{k}: {String(v)}</div>)}
                {data.problem ? <div style={{ color: '#fca5a5' }}>⚠ {data.problem}</div> : null}
            </div>
            {b.outputs.map((h, i) => (
                <Handle key={h} id={h} type="source" position={Position.Right} style={{ top: `${((i + 1) / (b.outputs.length + 1)) * 100}%` }}>
                    {b.outputs.length > 1 ? <span style={{ position: 'absolute', left: 10, top: -8, fontSize: 10, whiteSpace: 'nowrap' }}>{h}</span> : null}
                </Handle>
            ))}
        </div>
    );
}
const nodeTypes = { block: BlockNode };

function FieldInput({ field, value, onChange }) {
    const id = `wf-field-${field.name}`;
    let input;
    if (field.kind === 'enum') input = <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}><option value="">—</option>{field.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    else if (field.kind === 'number') input = <input id={id} type="number" min={field.min} max={field.max} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Math.trunc(Number(e.target.value)))} />;
    else if (field.kind === 'text' && (field.max || 0) > 200) input = <textarea id={id} rows={3} maxLength={field.max} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    else input = <input id={id} value={value ?? ''} maxLength={field.max || 500} placeholder={field.kind === 'id' ? 'Discord ID' : field.kind === 'url' ? 'https://' : field.kind === 'var' ? 'variable_name' : ''} onChange={(e) => onChange(e.target.value)} />;
    return <div className="field"><label htmlFor={id}>{field.name}{field.required ? ' *' : ''}</label>{input}</div>;
}

function Canvas({ base, workflow, catalog, onSaved }) {
    const defs = useMemo(() => Object.fromEntries(catalog.map((b) => [b.type, b])), [catalog]);
    const initial = useMemo(() => toFlow(workflow.graph), [workflow.graph]);
    const [nodes, setNodes] = useState(initial.nodes);
    const [edges, setEdges] = useState(initial.edges);
    const [selected, setSelected] = useState(null);
    const [problems, setProblems] = useState(workflow.problems || []);
    const [result, setResult] = useState(null);
    const [runs, setRuns] = useState(workflow.runs || []);
    const [message, setMessage] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [state, setState] = useState(workflow.state || 'draft');
    const [paywall, setPaywall] = useState(null);
    const closePaywall = useCallback(() => setPaywall(null), []);
    const past = useRef([]); const future = useRef([]);

    // Live run: the server re-checks Premium and deploys active workflows to the paired runner(s).
    async function runLive() {
        try {
            const r = await call(`${base}/${workflow.id}/execute`, { method: 'POST', body: '{}' });
            setMessage({ ok: r.message });
        } catch (e) {
            if (e.body?.code === 'premium_required') setPaywall(e.body);
            else setMessage({ error: e.message });
        }
    }

    // Activation is decided by the server (Premium + a valid workflow); the
    // button only asks. A 402 opens the upgrade screen.
    async function setActive(on) {
        if (on) { const p = await save(); if (p === null) return; if (p.length) { setMessage({ error: 'Fix the problems before activating.' }); return; } }
        try {
            const r = await call(`${base}/${workflow.id}/activate`, { method: 'POST', body: JSON.stringify({ active: on }) });
            setState(r.state);
            setMessage({ ok: on ? `Activated. ${r.runtime?.message || ''}` : 'Deactivated: back to draft.' });
        } catch (e) {
            if (e.body?.code === 'premium_required') setPaywall(e.body);
            else setMessage({ error: e.message });
        }
    }
    const flow = useReactFlow();
    const fileInput = useRef(null);

    const snapshot = useCallback(() => { past.current.push({ nodes, edges }); if (past.current.length > 100) past.current.shift(); future.current = []; setDirty(true); }, [nodes, edges]);
    const undo = () => { const p = past.current.pop(); if (!p) return; future.current.push({ nodes, edges }); setNodes(p.nodes); setEdges(p.edges); };
    const redo = () => { const f = future.current.pop(); if (!f) return; past.current.push({ nodes, edges }); setNodes(f.nodes); setEdges(f.edges); };

    const problemFor = useMemo(() => Object.fromEntries(problems.filter((p) => p.nodeId).map((p) => [p.nodeId, p.message])), [problems]);
    const shown = useMemo(() => nodes.map((n) => ({ ...n, data: { ...n.data, def: defs[n.data.block], problem: problemFor[n.id] } })), [nodes, defs, problemFor]);

    const onNodesChange = useCallback((changes) => {
        if (changes.some((c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false))) snapshot();
        setNodes((ns) => applyNodeChanges(changes, ns));
    }, [snapshot]);
    const onEdgesChange = useCallback((changes) => { if (changes.some((c) => c.type === 'remove')) snapshot(); setEdges((es) => applyEdgeChanges(changes, es)); }, [snapshot]);
    const onConnect = useCallback((c) => {
        snapshot();
        setEdges((es) => addEdge({ ...c, id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label: c.sourceHandle && c.sourceHandle !== 'next' ? c.sourceHandle : undefined }, es.filter((e) => !(e.source === c.source && (e.sourceHandle || null) === (c.sourceHandle || null)))));
    }, [snapshot]);

    const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    function addBlock(type, position) {
        snapshot();
        const pos = position || flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        const id = newId();
        setNodes((ns) => [...ns, { id, type: 'block', position: pos, data: { block: type, values: {} } }]);
        setSelected(id);
    }
    function duplicate() {
        const n = nodes.find((x) => x.id === selected);
        if (!n) return;
        snapshot();
        const id = newId();
        setNodes((ns) => [...ns, { ...n, id, selected: false, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: { ...n.data, values: { ...n.data.values } } }]);
        setSelected(id);
    }
    function removeSelected() {
        if (!selected) return;
        snapshot();
        setNodes((ns) => ns.filter((n) => n.id !== selected));
        setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
        setSelected(null);
    }
    function setValue(name, value) {
        snapshot();
        setNodes((ns) => ns.map((n) => {
            if (n.id !== selected) return n;
            const values = { ...n.data.values };
            if (value === undefined || value === '') delete values[name]; else values[name] = value;
            return { ...n, data: { ...n.data, values } };
        }));
    }

    async function save() {
        try {
            const body = await call(`${base}/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ graph: fromFlow(nodes, edges) }) });
            setProblems(body.problems); setDirty(false);
            if (body.deactivated) setState('draft');
            setMessage({ ok: body.problems.length ? `Saved with ${body.problems.length} problem(s) to fix.` : 'Saved. No problems found ✓' });
            onSaved?.();
            return body.problems;
        } catch (e) { setMessage({ error: e.message }); return null; }
    }
    async function test() {
        const p = await save();
        if (p === null) return;
        try {
            const { result: r } = await call(`${base}/${workflow.id}/simulate`, { method: 'POST', body: JSON.stringify({}) });
            setResult(r);
            setRuns((await call(`${base}/${workflow.id}`)).runs);
        } catch (e) { setMessage({ error: e.message }); }
    }
    async function exportCode(write) {
        const p = await save();
        if (p === null) return;
        try {
            const body = await call(`${base}/${workflow.id}/export`, { method: 'POST', body: JSON.stringify({ write }) });
            if (write) setMessage({ ok: `Wrote ${body.path} into the project. Require it from your bot's entry point.` });
            else download(body.path.split('/').pop(), body.content, 'text/javascript');
        } catch (e) { setMessage({ error: e.message }); }
    }
    function download(name, content, type) {
        const url = URL.createObjectURL(new Blob([content], { type }));
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function importJson(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result));
                const g = toFlow(parsed.graph || parsed);
                snapshot(); setNodes(g.nodes); setEdges(g.edges);
                setMessage({ ok: 'Imported. Save to validate it.' });
            } catch { setMessage({ error: 'That file is not a workflow JSON export.' }); }
        };
        reader.readAsText(file.slice(0, 300 * 1024));
    }

    useEffect(() => {
        const onKey = (e) => {
            if (e.target.closest?.('input, textarea, select')) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const sel = nodes.find((n) => n.id === selected);
    const selDef = sel ? defs[sel.data.block] : null;
    const grouped = useMemo(() => catalog.reduce((acc, b) => { (acc[b.kind] ||= []).push(b); return acc; }, {}), [catalog]);

    return (
        <div className="stack">
            {paywall ? <PremiumPaywall info={paywall} onClose={closePaywall} /> : null}
            {message?.error ? <p className="error" role="alert">{message.error}</p> : null}
            {message?.ok ? <p className="help" role="status">{message.ok}</p> : null}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" type="button" onClick={save}>{dirty ? 'Save •' : 'Save'}</button>
                <button className="btn" type="button" onClick={save}>Validate</button>
                <button className="btn" type="button" onClick={test}>Test in simulator</button>
                <button className="btn" type="button" onClick={undo} disabled={!past.current.length}>Undo</button>
                <button className="btn" type="button" onClick={redo} disabled={!future.current.length}>Redo</button>
                <button className="btn" type="button" onClick={() => download(`${workflow.name}.workflow.json`, JSON.stringify({ name: workflow.name, graph: fromFlow(nodes, edges) }, null, 2), 'application/json')}>Export JSON</button>
                <button className="btn" type="button" onClick={() => fileInput.current?.click()}>Import JSON</button>
                <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
                <button className="btn" type="button" onClick={() => exportCode(false)}>Download code</button>
                <button className="btn" type="button" onClick={() => exportCode(true)}>Write code to project</button>
                <span className="row" style={{ gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
                    <span className={`wf-state${state === 'active' ? ' is-active' : state === 'paused_premium_expired' ? ' is-paused' : ''}`}>{state === 'active' ? 'Active' : state === 'paused_premium_expired' ? 'Paused: Premium expired' : 'Draft'}</span>
                    {state === 'draft' ? (
                        <button className="btn btn-primary" type="button" onClick={() => setActive(true)}>{workflow.entitlement?.premium ? '⚡ Activate' : '💎 Activate'}</button>
                    ) : (
                        <>
                            {state === 'active' ? <button className="btn btn-primary" type="button" onClick={runLive}>▶ Run live now</button> : null}
                            <button className="btn" type="button" onClick={() => setActive(false)}>Deactivate</button>
                        </>
                    )}
                </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr 260px', gap: 10 }}>
                <aside className="card" aria-label="Blocks" style={{ maxHeight: '70vh', overflow: 'auto', padding: 8 }}>
                    <p className="help" style={{ marginTop: 0 }}>Click or drag a block onto the canvas.</p>
                    {Object.entries(grouped).map(([kind, blocks]) => (
                        <div key={kind}>
                            <strong style={{ color: KIND_COLOUR[kind], fontSize: 12 }}>{KIND_LABEL[kind]}</strong>
                            {blocks.map((b) => (
                                <button key={b.type} type="button" className="link" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-zig-block', b.type)} onClick={() => addBlock(b.type)} style={{ display: 'block', textAlign: 'left', fontSize: 12, padding: '2px 0' }}>{b.label}</button>
                            ))}
                        </div>
                    ))}
                </aside>
                <div className="card" style={{ height: '70vh', padding: 0 }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                    onDrop={(e) => { e.preventDefault(); const type = e.dataTransfer.getData('application/x-zig-block'); if (defs[type]) addBlock(type, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })); }}>
                    <ReactFlow nodes={shown} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
                        onSelectionChange={({ nodes: s }) => setSelected(s[0]?.id || null)} colorMode="dark" fitView deleteKeyCode={['Delete', 'Backspace']}>
                        <Background /><Controls /><MiniMap pannable zoomable />
                    </ReactFlow>
                </div>
                <aside className="card" aria-label="Block settings" style={{ maxHeight: '70vh', overflow: 'auto' }}>
                    {sel && selDef ? (
                        <div className="stack">
                            <strong style={{ color: KIND_COLOUR[selDef.kind] }}>{selDef.label}</strong>
                            {selDef.fields.length === 0 ? <p className="help">No settings.</p> : selDef.fields.map((f) => <FieldInput key={`${sel.id}-${f.name}`} field={f} value={sel.data.values[f.name]} onChange={(v) => setValue(f.name, v)} />)}
                            <p className="help">Text supports placeholders like {'{{user.name}}'}, {'{{message.content}}'} or your own variables.</p>
                            <div className="row" style={{ gap: 6 }}>
                                <button className="btn" type="button" onClick={duplicate}>Duplicate</button>
                                <button className="btn btn-danger" type="button" onClick={removeSelected}>Delete</button>
                            </div>
                        </div>
                    ) : <p className="help">Select a block to edit it.</p>}
                    {problems.length ? (
                        <div style={{ marginTop: 12 }}>
                            <strong>Problems ({problems.length})</strong>
                            <ul style={{ paddingLeft: 16, fontSize: 12 }}>{problems.map((p, i) => <li key={i}>{p.nodeId ? <button type="button" className="link" onClick={() => { setSelected(p.nodeId); const n = nodes.find((x) => x.id === p.nodeId); if (n) flow.setCenter(n.position.x, n.position.y, { zoom: 1.2 }); }}>{p.message}</button> : p.message}</li>)}</ul>
                        </div>
                    ) : null}
                </aside>
            </div>
            <div className="card">
                <h2 style={{ marginTop: 0 }}>Simulator</h2>
                <p className="help">Runs on a pretend Discord: nothing is sent, no web requests, AI answers are simulated. Loops stop at 50, runs at 1000 steps or 5 seconds.</p>
                {result ? (
                    <div aria-live="polite">
                        <strong>{result.ok ? 'Finished ✓' : `Stopped: ${result.error}`}</strong>
                        <ol style={{ fontSize: 13 }}>{result.steps.slice(0, 200).map((s, i) => <li key={i}><code>{s.block}</code> {s.did}</li>)}</ol>
                        {result.actions.length ? <><strong>What the bot would do</strong><ul style={{ fontSize: 13 }}>{result.actions.slice(0, 100).map((a, i) => <li key={i}>{a.did}{a.content ? `: “${a.content}”` : ''}</li>)}</ul></> : null}
                    </div>
                ) : <p className="help">Press “Test in simulator”.</p>}
                {runs.length ? (
                    <details><summary>Execution history ({runs.length})</summary>
                        <ul style={{ fontSize: 13 }}>{runs.map((r) => <li key={r.id}>{new Date(r.createdAt).toLocaleString()}: {r.ok ? 'ok' : `error: ${r.error}`} ({r.steps} steps)</li>)}</ul>
                    </details>
                ) : null}
            </div>
        </div>
    );
}

/**
 * "Describe the automation you want to create." The server asks the chosen
 * AI for a workflow in the builder's schema, validates it and saves it as a
 * draft; it opens on the canvas for editing. Nothing runs or activates.
 */
function AiWorkflowGenerator({ base, onCreated }) {
    const [text, setText] = useState('');
    const [engine, setEngine] = useState('zigbot');
    const [engines, setEngines] = useState([{ id: 'zigbot', label: 'ZiGBoT AI' }]);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    const abortRef = useRef(null);
    useEffect(() => {
        call('/api/studio/agents/keys').then((b) => setEngines([{ id: 'zigbot', label: 'ZiGBoT AI' }, ...b.providers.filter((p) => p.configured).map((p) => ({ id: p.id, label: `${p.label} (your key)` }))])).catch(() => {});
    }, []);
    async function generate(e) {
        e.preventDefault();
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(true); setNote(null);
        try {
            const r = await call(`${base}/generate`, { method: 'POST', body: JSON.stringify({ request: text, engine }), signal: controller.signal });
            const extra = [r.problems.length ? `${r.problems.length} thing(s) to fill in or fix (marked on the canvas)` : 'no problems found', r.dropped.length ? `ignored: ${r.dropped.slice(0, 4).join(', ')}` : null].filter(Boolean).join(' · ');
            setNote({ ok: `Created “${r.workflow.name}” as a draft: ${extra}. Edit any block, then test it in the simulator.` });
            setText('');
            await onCreated(r.workflow.id);
        } catch (err) {
            setNote(err.name === 'AbortError' ? { ok: 'Cancelled.' } : { error: err.message });
        } finally { setBusy(false); abortRef.current = null; }
    }
    return (
        <form className="card stack" onSubmit={generate} style={{ borderTop: '3px solid #fb923c' }}>
            <label htmlFor="wf-ai"><strong>✨ Describe the automation you want to create.</strong></label>
            <textarea id="wf-ai" rows={3} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
                placeholder="When someone joins my Discord server, send them a welcome message, assign a role, and notify the moderators if the account is less than seven days old." />
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="sr-only" htmlFor="wf-engine">AI</label>
                <select id="wf-engine" value={engine} onChange={(e) => setEngine(e.target.value)} disabled={busy}>{engines.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
                <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()} aria-busy={busy}>{busy ? 'Designing…' : 'Generate workflow'}</button>
                {busy ? <button className="btn" type="button" onClick={() => abortRef.current?.abort()}>Cancel</button> : null}
            </div>
            <p className="help" style={{ margin: 0 }}>The AI can only use the builder&apos;s blocks (no custom code). The result is saved as a draft you review and edit; activating still needs Premium.</p>
            {note?.error ? <p className="error" role="alert">{note.error}</p> : null}
            {note?.ok ? <p className="help" role="status">{note.ok}</p> : null}
        </form>
    );
}

export default function WorkflowBuilder({ projectId }) {
    const base = `/api/studio/projects/${projectId}/workflows`;
    const [list, setList] = useState(null);
    const [catalog, setCatalog] = useState([]);
    const [current, setCurrent] = useState(null);
    const [error, setError] = useState(null);
    const [name, setName] = useState('');

    const load = useCallback(() => call(base).then((b) => { setList(b.workflows); setCatalog(b.catalog); }).catch((e) => setError(e.message)), [base]);
    useEffect(() => { load(); }, [load]);

    async function open(id) {
        try { const b = await call(`${base}/${id}`); setCurrent({ ...b.workflow, problems: b.problems, runs: b.runs, entitlement: b.entitlement }); } catch (e) { setError(e.message); }
    }
    async function create(e) {
        e.preventDefault();
        try { const { workflow } = await call(base, { method: 'POST', body: JSON.stringify({ name }) }); setName(''); await load(); open(workflow.id); } catch (err) { setError(err.message); }
    }
    async function remove(w) {
        if (!window.confirm(`Delete the workflow "${w.name}"?`)) return;
        try { await call(`${base}/${w.id}`, { method: 'DELETE' }); if (current?.id === w.id) setCurrent(null); load(); } catch (e) { setError(e.message); }
    }

    if (list === null && !error) return <p className="help" aria-busy="true">Loading…</p>;
    return (
        <div className="stack">
            {error ? <p className="error" role="alert">{error}</p> : null}
            <AiWorkflowGenerator base={base} onCreated={async (id) => { await load(); open(id); }} />
            <div className="card">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {(list || []).length === 0 ? <span className="help">No workflows yet.</span> : (list || []).map((w) => (
                        <span key={w.id} className="row" style={{ gap: 4 }}>
                            <button type="button" className={current?.id === w.id ? 'btn btn-primary' : 'btn'} onClick={() => open(w.id)}>{w.name}</button>
                            <button type="button" className="link" aria-label={`Delete ${w.name}`} onClick={() => remove(w)}>✕</button>
                        </span>
                    ))}
                    <form onSubmit={create} className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                        <label className="sr-only" htmlFor="wf-name">New workflow name</label>
                        <input id="wf-name" placeholder="New workflow name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
                        <button className="btn" type="submit" disabled={!name.trim()}>Create</button>
                    </form>
                </div>
            </div>
            {current ? <ReactFlowProvider key={current.id}><Canvas base={base} workflow={current} catalog={catalog} onSaved={load} /></ReactFlowProvider> : <p className="help">Pick or create a workflow.</p>}
        </div>
    );
}
