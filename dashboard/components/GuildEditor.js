'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const TABS = [
    { id: 'behaviour', label: 'AI behaviour' },
    { id: 'roles', label: 'Roles' },
    { id: 'channels', label: 'Channels' },
    { id: 'features', label: 'Features' },
    { id: 'test', label: 'Test' },
    { id: 'premium', label: '💎 Premium' },
    { id: 'history', label: 'History' }
];

const TONE_LABELS = { gentle: 'Gentle', savage: 'Savage roast', neutral: 'Neutral helper' };
const TONE_HELP = {
    gentle: 'Warm, wholesome, supportive. Never roasts.',
    savage: 'ZiGBoT’s dark-humour roast persona (needs the “roast” feature).',
    neutral: 'A friendly, helpful assistant without the persona.'
};
const TIER_LABELS = { admin: 'Admin', moderator: 'Moderator', member: 'Member', custom: 'Custom' };

function stripMeta(config) {
    const { version, updated_at, guild_id, ...rest } = config;
    return rest;
}

async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
    });
    let data = {};
    try {
        data = await response.json();
    } catch {
        data = {};
    }
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status}).`);
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function Switch({ checked, onChange, label, help, id, disabled = false }) {
    return (
        <label className={`switch ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
            <input id={id} type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span className="track" aria-hidden="true" />
            <span>
                <span className="label" style={{ display: 'block' }}>{label}</span>
                {help ? <span className="help">{help}</span> : null}
            </span>
        </label>
    );
}

function TextArea({ id, label, help, value, onChange, max, error, rows = 5, placeholder, disabled = false }) {
    const length = (value || '').length;
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            {help ? <span className="help" id={`${id}-help`}>{help}</span> : null}
            <textarea id={id} rows={rows} value={value || ''} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? 'true' : undefined} aria-describedby={help ? `${id}-help` : undefined} />
            <div className="spread">
                {error ? <span className="error" role="alert">{error}</span> : <span />}
                <span className={`counter ${length > max ? 'over' : ''}`}>{length}/{max}</span>
            </div>
        </div>
    );
}

function ChannelPicker({ id, label, help, channels, selected, onChange, error }) {
    const [query, setQuery] = useState('');
    const visible = channels.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
    const set = new Set(selected);
    return (
        <div className="field">
            <span className="label" id={`${id}-label`}>{label}</span>
            {help ? <span className="help">{help}</span> : null}
            <input type="search" placeholder="Filter channels" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={`Filter ${label}`} />
            <div className="checklist" role="group" aria-labelledby={`${id}-label`}>
                {visible.length === 0 ? <span className="help" style={{ padding: 8 }}>No channels match.</span> : null}
                {visible.map((c) => (
                    <label key={c.id}>
                        <input type="checkbox" checked={set.has(c.id)} onChange={(e) => onChange(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                        <span>#{c.name}</span>
                    </label>
                ))}
            </div>
            <span className="help">{selected.length} selected</span>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </div>
    );
}

function Segmented({ options, value, onChange, label }) {
    return (
        <div className="segmented" role="group" aria-label={label}>
            {options.map((o) => (
                <button type="button" key={o.value} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label}</button>
            ))}
        </div>
    );
}

function roleColor(color) {
    return color ? `#${Number(color).toString(16).padStart(6, '0')}` : 'var(--muted)';
}

export default function GuildEditor({ initial, meta }) {
    const [tab, setTab] = useState('behaviour');
    const [saved, setSaved] = useState(initial.config);
    const [draft, setDraft] = useState(stripMeta(initial.config));
    const [savedMappings, setSavedMappings] = useState(initial.mappings);
    const [mappings, setMappings] = useState(initial.mappings);
    const [fieldErrors, setFieldErrors] = useState({});
    const [mappingErrors, setMappingErrors] = useState([]);
    const [busy, setBusy] = useState(null);
    const [toasts, setToasts] = useState([]);
    const [confirmReset, setConfirmReset] = useState(false);
    const [plan, setPlan] = useState(initial.plan);
    const premium = Boolean(plan?.premium);
    const roles = initial.roles;
    const channels = initial.channels;
    const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

    const configDirty = JSON.stringify(stripMeta(saved)) !== JSON.stringify(draft);
    const mappingsDirty = JSON.stringify(savedMappings) !== JSON.stringify(mappings);
    const dirty = configDirty || mappingsDirty;

    useEffect(() => {
        const warn = (e) => {
            if (!dirty) return;
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);

    const toast = useCallback((text, kind = 'ok') => {
        const id = Math.random().toString(36).slice(2);
        setToasts((t) => [...t, { id, text, kind }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 7000 : 4000);
    }, []);

    const set = (key) => (value) => setDraft((d) => ({ ...d, [key]: value }));


    async function save() {
        setBusy('save');
        setFieldErrors({});
        setMappingErrors([]);
        try {
            if (configDirty) {
                const { config } = await api(`/api/guilds/${initial.guild.id}/config`, { method: 'PUT', body: { config: draft, expectedVersion: saved.version } });
                setSaved(config);
                setDraft(stripMeta(config));
            }
            if (mappingsDirty) {
                const { mappings: next } = await api(`/api/guilds/${initial.guild.id}/roles`, { method: 'PUT', body: { mappings } });
                setSavedMappings(next);
                setMappings(next);
            }
            toast('Saved. ZiGBoT picks up the changes within about 30 seconds.');
        } catch (error) {
            if (error.data?.fieldErrors) setFieldErrors(error.data.fieldErrors);
            if (error.data?.mappingErrors) {
                setMappingErrors(error.data.mappingErrors);
                setTab('roles');
            } else if (error.data?.fieldErrors) {
                const first = Object.keys(error.data.fieldErrors)[0] || '';
                setTab(/channel|respond|cooldown|keyword/.test(first) ? 'channels' : /memory|reputation|music|voice|legacy/.test(first) ? 'features' : 'behaviour');
            }
            toast(error.status === 401 ? 'Your session expired. Sign in again.' : error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    function discard() {
        setDraft(stripMeta(saved));
        setMappings(savedMappings);
        setFieldErrors({});
        setMappingErrors([]);
    }

    async function reset() {
        setBusy('reset');
        try {
            const { config } = await api(`/api/guilds/${initial.guild.id}/config/reset`, { method: 'POST' });
            if (config) {
                setSaved(config);
                setDraft(stripMeta(config));
            }
            setConfirmReset(false);
            toast('Settings reset to safe defaults. Role mappings were kept.');
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    const status = initial.botStatus;

    return (
        <div>
            <div className="toasts" aria-live="polite">
                {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : ''}`} role={t.kind === 'err' ? 'alert' : 'status'}>{t.text}</div>)}
            </div>

            <div className="spread" style={{ marginTop: 16 }}>
                <div className="row">
                    {initial.guild.icon ? <img className="guild-icon" src={initial.guild.icon} alt="" /> : <span className="guild-icon">{initial.guild.name.slice(0, 2).toUpperCase()}</span>}
                    <div>
                        <h1>{initial.guild.name}</h1>
                        <div className="row">
                            <span className="pill pill-ok">Installed</span>
                            <span className={`pill ${status.online ? 'pill-ok' : 'pill-bad'}`}>{status.online ? 'Bot online' : 'Bot offline'}</span>
                            <span className={`pill ${draft.enabled ? 'pill-ok' : 'pill-warn'}`}>{draft.enabled ? 'Active here' : 'Switched off here'}</span>
                            <span className={`pill ${premium ? 'pill-premium' : ''}`}>{premium ? '💎 Premium' : 'Free plan'}</span>
                        </div>
                    </div>
                </div>
            </div>
            {!status.online ? (
                <p className="help" style={{ marginTop: 8 }}>
                    {status.lastSeen ? `Last heartbeat ${new Date(status.lastSeen).toLocaleString()}.` : 'No heartbeat received yet.'} Settings still save; the bot applies them when it is back online.
                </p>
            ) : null}

            <div className="tabs" role="tablist" aria-label="Settings sections">
                {TABS.map((t) => (
                    <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => setTab(t.id)}>{t.label}</button>
                ))}
            </div>

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === 'behaviour' ? <BehaviourTab draft={draft} saved={saved} set={set} errors={fieldErrors} meta={meta} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'roles' ? <RolesTab roles={roles} roleById={roleById} mappings={mappings} setMappings={setMappings} errors={mappingErrors} meta={meta} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'channels' ? <ChannelsTab draft={draft} set={set} errors={fieldErrors} channels={channels} /> : null}
                {tab === 'features' ? <FeaturesTab draft={draft} set={set} isHome={initial.guild.isHome} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'premium' ? <PremiumTab guildId={initial.guild.id} plan={plan} setPlan={setPlan} perks={meta.perks} contactUrl={meta.contactUrl} toast={toast} /> : null}
                {tab === 'test' ? <TestTab guildId={initial.guild.id} draft={draft} tones={meta.tones} toast={toast} /> : null}
                {tab === 'history' ? <HistoryTab guildId={initial.guild.id} /> : null}
            </div>

            <div className="card" style={{ marginTop: 28 }}>
                <div className="spread">
                    <div>
                        <h3>Reset to defaults</h3>
                        <p className="help" style={{ margin: 0 }}>Restores the safe default AI, channel and feature settings for this server. Role mappings are kept.</p>
                    </div>
                    {confirmReset ? (
                        <div className="row">
                            <button className="btn" onClick={() => setConfirmReset(false)} disabled={busy === 'reset'}>Cancel</button>
                            <button className="btn btn-danger" onClick={reset} disabled={busy === 'reset'}>{busy === 'reset' ? 'Resetting…' : 'Yes, reset'}</button>
                        </div>
                    ) : (
                        <button className="btn btn-danger" onClick={() => setConfirmReset(true)}>Reset…</button>
                    )}
                </div>
            </div>

            {dirty ? (
                <div className="savebar" role="region" aria-label="Unsaved changes">
                    <div className="inner">
                        <span className="small">You have unsaved changes{mappingsDirty && configDirty ? ' (settings and roles)' : mappingsDirty ? ' (roles)' : ''}.</span>
                        <div className="row">
                            <button className="btn" onClick={discard} disabled={busy === 'save'}>Discard</button>
                            <button className="btn btn-primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function PremiumNote({ children, onUpgrade }) {
    return (
        <div className="premium-note">
            <span>💎 {children}</span>
            <button type="button" className="btn btn-primary" onClick={onUpgrade}>See Premium</button>
        </div>
    );
}

function BehaviourTab({ draft, set, errors, meta, premium, onUpgrade }) {
    return (
        <div className="stack">
            <div className="card stack">
                <Switch id="enabled" checked={draft.enabled} onChange={set('enabled')} label="ZiGBoT is active in this server" help="Turn off to make the bot ignore every message and command here." />
            </div>
            <div className="card stack">
                <div>
                    <h2>Default tone</h2>
                    <p className="help">Used for members without a role mapping that sets a tone.</p>
                </div>
                <Segmented label="Default tone" value={draft.default_tone} onChange={set('default_tone')} options={meta.tones.map((t) => ({ value: t, label: TONE_LABELS[t] }))} />
                <p className="help" style={{ margin: 0 }}>{TONE_HELP[draft.default_tone]}</p>
                {errors.default_tone ? <span className="error">{errors.default_tone}</span> : null}
            </div>
            <div className="card stack">
                <div>
                    <h2>Custom personality {premium ? null : <span className="pill pill-premium">Premium</span>}</h2>
                    <p className="help">Describe who ZiGBoT should be here. ZiGBoT’s safety rules always apply and cannot be switched off from here.</p>
                </div>
                {premium ? null : <PremiumNote onUpgrade={onUpgrade}>A custom personality is a Premium feature. Anything saved here earlier is kept but not used until this server is Premium.</PremiumNote>}
                <Switch id="replace" disabled={!premium} checked={draft.replace_base_persona} onChange={set('replace_base_persona')} label="Replace the ZiGBoT persona entirely" help="Off: your text is added on top of the selected tone. On: your text becomes the whole personality." />
                {errors.replace_base_persona ? <span className="error">{errors.replace_base_persona}</span> : null}
                <TextArea id="prompt" disabled={!premium} label="Personality / system prompt" value={draft.custom_system_prompt} onChange={set('custom_system_prompt')} max={meta.limits.customSystemPrompt} error={errors.custom_system_prompt} rows={7} placeholder="e.g. You are the cheerful mascot of an anime art server. Hype up people's artwork and answer art questions." />
                <TextArea id="instructions" label="How to respond to different messages" value={draft.response_instructions} onChange={set('response_instructions')} max={meta.limits.responseInstructions} error={errors.response_instructions} placeholder="e.g. Questions about events: point to #announcements. Art feedback: be specific and kind." />
                <TextArea id="rules" label="Server rules and restrictions" value={draft.server_rules} onChange={set('server_rules')} max={meta.limits.serverRules} error={errors.server_rules} placeholder="e.g. No spoilers for ongoing anime. Never discuss politics." />
            </div>
            <div className="card grid-2">
                <div className="field">
                    <label htmlFor="language">Language</label>
                    <input id="language" type="text" value={draft.language || ''} maxLength={meta.limits.language + 10} onChange={(e) => set('language')(e.target.value)} placeholder="e.g. English, Hindi, Hinglish" aria-invalid={errors.language ? 'true' : undefined} />
                    {errors.language ? <span className="error">{errors.language}</span> : null}
                </div>
                <div className="field">
                    <label htmlFor="length">Reply length</label>
                    <select id="length" value={draft.response_length} onChange={(e) => set('response_length')(e.target.value)}>
                        <option value="short">Short (1–3 sentences)</option>
                        <option value="medium">Medium (a paragraph)</option>
                        <option value="long">Long (detailed)</option>
                    </select>
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label htmlFor="style">Response style</label>
                    <input id="style" type="text" value={draft.response_style || ''} onChange={(e) => set('response_style')(e.target.value)} placeholder="e.g. playful, lots of emojis, gaming slang" aria-invalid={errors.response_style ? 'true' : undefined} />
                    {errors.response_style ? <span className="error">{errors.response_style}</span> : null}
                </div>
            </div>
        </div>
    );
}

function FeatureControl({ feature, label, mapping, onChange }) {
    const state = mapping.allowed_features.includes(feature) ? 'allow' : mapping.denied_features.includes(feature) ? 'deny' : 'inherit';
    const update = (next) => {
        const allowed = mapping.allowed_features.filter((f) => f !== feature);
        const denied = mapping.denied_features.filter((f) => f !== feature);
        if (next === 'allow') allowed.push(feature);
        if (next === 'deny') denied.push(feature);
        onChange({ ...mapping, allowed_features: allowed, denied_features: denied });
    };
    return (
        <div className="feature" title={label}>
            <span className="small">{feature.replace('_', ' ')}</span>
            <Segmented label={`${feature} for this role`} value={state} onChange={update} options={[{ value: 'inherit', label: '–' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]} />
        </div>
    );
}

function RolesTab({ roles, roleById, mappings, setMappings, errors, meta, premium, onUpgrade }) {
    const maxMappings = premium ? meta.limits.roleMappingsPerGuild : meta.freeRoleMappings;
    const used = new Set(mappings.map((m) => m.role_id));
    const available = roles.filter((r) => !used.has(r.id));
    const [pick, setPick] = useState('');

    const add = () => {
        const role = roleById.get(pick) || available[0];
        if (!role) return;
        setMappings([...mappings, { role_id: role.id, role_name: role.name, tier: 'custom', priority: 0, tone: null, pronouns: null, instructions: '', allowed_features: [], denied_features: [] }]);
        setPick('');
    };
    const update = (index, next) => setMappings(mappings.map((m, i) => (i === index ? next : m)));
    const remove = (index) => setMappings(mappings.filter((_, i) => i !== index));

    return (
        <div className="stack">
            <div className="card">
                <h2>Role-based behaviour</h2>
                <p className="help">Map your server’s roles to a tone, pronouns, extra instructions and features. Roles are read live from Discord.</p>
                <ul className="help" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                    <li><strong>Multiple roles:</strong> the mapping with the highest priority sets tone and pronouns (ties go to the higher Discord role).</li>
                    <li><strong>Features:</strong> “Deny” on any of a member’s roles always beats “Allow”.</li>
                    <li><strong>Moderation / admin tools</strong> also need the member’s real Discord permission (e.g. Kick Members). A mapping can never grant a permission they don’t have. The server owner and Administrators always keep access.</li>
                </ul>
            </div>

            {premium ? null : (
                <PremiumNote onUpgrade={onUpgrade}>
                    Free servers can map up to {meta.freeRoleMappings} roles ({Math.min(mappings.length, meta.freeRoleMappings)}/{meta.freeRoleMappings} used){mappings.length > meta.freeRoleMappings ? '. Only the highest-priority ones are active until this server is Premium.' : '.'} Premium allows up to {meta.limits.roleMappingsPerGuild}.
                </PremiumNote>
            )}
            {errors._ ? <span className="error" role="alert">{errors._}</span> : null}
            {errors[0]?._ ? <span className="error" role="alert">{errors[0]._}</span> : null}

            {mappings.length === 0 ? <div className="card empty"><p className="muted" style={{ margin: 0 }}>No role mappings yet. Everyone gets the server defaults.</p></div> : null}

            {mappings.map((m, index) => {
                const role = roleById.get(m.role_id);
                const err = errors[index] || {};
                return (
                    <div key={m.role_id} className="mapping">
                        <div className="spread">
                            <div className="row">
                                <span className="role-dot" style={{ background: roleColor(role?.color) }} aria-hidden="true" />
                                <strong>{role?.name || m.role_name || 'Deleted role'}</strong>
                                {!role ? <span className="pill pill-warn">Role no longer exists</span> : null}
                            </div>
                            <button className="btn btn-ghost btn-danger" onClick={() => remove(index)}>Remove</button>
                        </div>
                        {err.role_id ? <span className="error">{err.role_id}</span> : null}
                        <div className="grid-2">
                            <div className="field">
                                <label htmlFor={`tier-${index}`}>Tier</label>
                                <select id={`tier-${index}`} value={m.tier} onChange={(e) => update(index, { ...m, tier: e.target.value })}>
                                    {meta.tiers.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor={`priority-${index}`}>Priority</label>
                                <input id={`priority-${index}`} type="number" min={meta.limits.priorityMin} max={meta.limits.priorityMax} value={m.priority} onChange={(e) => update(index, { ...m, priority: e.target.value === '' ? 0 : Number(e.target.value) })} aria-invalid={err.priority ? 'true' : undefined} />
                                {err.priority ? <span className="error">{err.priority}</span> : <span className="help">Higher wins when a member has several mapped roles.</span>}
                            </div>
                            <div className="field">
                                <label htmlFor={`tone-${index}`}>Tone</label>
                                <select id={`tone-${index}`} value={m.tone || ''} onChange={(e) => update(index, { ...m, tone: e.target.value || null })}>
                                    <option value="">Server default</option>
                                    {meta.tones.map((t) => <option key={t} value={t}>{TONE_LABELS[t]}</option>)}
                                </select>
                            </div>
                            <div className="field">
                                <label htmlFor={`pronouns-${index}`}>Pronouns</label>
                                <select id={`pronouns-${index}`} value={m.pronouns || ''} onChange={(e) => update(index, { ...m, pronouns: e.target.value || null })}>
                                    <option value="">Not set</option>
                                    {meta.pronouns.map((p) => <option key={p} value={p}>{p}</option>)}
                                </select>
                            </div>
                        </div>
                        <TextArea id={`instr-${index}`} label="Extra instructions for this role" value={m.instructions} onChange={(v) => update(index, { ...m, instructions: v })} max={meta.limits.roleInstructions} error={err.instructions} rows={3} placeholder="e.g. Treat VIPs like celebrities." />
                        <div className="field">
                            <span className="label">Features</span>
                            <div className="feature-grid">
                                {Object.entries(meta.features).map(([feature, label]) => <FeatureControl key={feature} feature={feature} label={label} mapping={m} onChange={(next) => update(index, next)} />)}
                            </div>
                            {err.allowed_features || err.denied_features ? <span className="error">{err.allowed_features || err.denied_features}</span> : null}
                        </div>
                    </div>
                );
            })}

            <div className="card row">
                <select aria-label="Role to map" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} disabled={available.length === 0}>
                    <option value="">{available.length === 0 ? 'All roles are mapped' : 'Choose a role…'}</option>
                    {available.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <button className="btn" onClick={add} disabled={!pick || mappings.length >= maxMappings}>Add mapping</button>
            </div>
        </div>
    );
}

function ChannelsTab({ draft, set, errors, channels }) {
    return (
        <div className="stack">
            <div className="card stack">
                <h2>When ZiGBoT replies</h2>
                <Switch id="all" checked={draft.respond_to_all} onChange={set('respond_to_all')} label="Reply to every message" help="Usually too noisy. When off, ZiGBoT replies to mentions, replies to its messages, and chat channels." />
                <Switch id="kw" checked={draft.auto_reply_keywords} onChange={set('auto_reply_keywords')} label="Jump in on keywords" help="Reacts to stress or fun keywords (exam, bored, lol…) without a mention." />
                <div className="field" style={{ maxWidth: 260 }}>
                    <label htmlFor="cooldown">Keyword cooldown (seconds)</label>
                    <input id="cooldown" type="number" min={0} max={3600} value={draft.cooldown_seconds} onChange={(e) => set('cooldown_seconds')(e.target.value === '' ? 0 : Number(e.target.value))} aria-invalid={errors.cooldown_seconds ? 'true' : undefined} />
                    {errors.cooldown_seconds ? <span className="error">{errors.cooldown_seconds}</span> : null}
                </div>
            </div>
            <div className="card grid-2">
                <ChannelPicker id="chat" label="Chat channels" help="ZiGBoT replies to everything in these." channels={channels} selected={draft.chat_channel_ids} onChange={set('chat_channel_ids')} error={errors.chat_channel_ids} />
                <ChannelPicker id="allowed" label="Only reply in these channels" help="Leave empty to allow every channel." channels={channels} selected={draft.allowed_channel_ids} onChange={set('allowed_channel_ids')} error={errors.allowed_channel_ids} />
                <ChannelPicker id="blocked" label="Never reply in these channels" help="Overrides everything else." channels={channels} selected={draft.blocked_channel_ids} onChange={set('blocked_channel_ids')} error={errors.blocked_channel_ids} />
                <div className="field">
                    <label htmlFor="log">Audit log channel</label>
                    <span className="help">Where ZiGBoT posts moderation/admin actions taken through it.</span>
                    <select id="log" value={draft.log_channel_id || ''} onChange={(e) => set('log_channel_id')(e.target.value || null)} aria-invalid={errors.log_channel_id ? 'true' : undefined}>
                        <option value="">None</option>
                        {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                    </select>
                    {errors.log_channel_id ? <span className="error">{errors.log_channel_id}</span> : null}
                </div>
            </div>
        </div>
    );
}

function FeaturesTab({ draft, set, isHome, premium, onUpgrade }) {
    return (
        <div className="card stack">
            <h2>Server-wide features</h2>
            <Switch id="memory" checked={draft.memory_enabled} onChange={set('memory_enabled')} label="Long-term memory" help="ZiGBoT remembers durable facts members share (30-day retention) and can follow up later. Off by default for privacy." />
            <Switch id="rep" checked={draft.reputation_enabled} onChange={set('reputation_enabled')} label="Behaviour reputation" help="Tracks positive/negative behaviour signals and adapts how warmly ZiGBoT treats members." />
            {premium ? null : <PremiumNote onUpgrade={onUpgrade}>Music and voice chat are Premium features. The switches below take effect once this server is Premium.</PremiumNote>}
            <Switch id="music" checked={draft.music_enabled} onChange={set('music_enabled')} label={premium ? 'Music commands' : 'Music commands (Premium)'} />
            <Switch id="voice" checked={draft.voice_enabled} onChange={set('voice_enabled')} label={premium ? 'Voice chat' : 'Voice chat (Premium)'} help="Joining voice channels and listening/speaking." />
            {isHome || draft.legacy_role_rules ? (
                <Switch id="legacy" checked={draft.legacy_role_rules} onChange={set('legacy_role_rules')} label="Legacy role rules (env-configured)" help="Keeps the original gentle/savage and pronoun role-name rules from the bot’s environment. Role mappings above still take priority." />
            ) : null}
        </div>
    );
}

function TestTab({ guildId, draft, tones, toast }) {
    const [message, setMessage] = useState('');
    const [tone, setTone] = useState(tones.includes(draft.default_tone) ? draft.default_tone : tones[0]);
    const [busy, setBusy] = useState(false);
    const [history, setHistory] = useState([]);

    async function run(e) {
        e.preventDefault();
        if (!message.trim()) return;
        setBusy(true);
        const text = message.trim();
        try {
            const result = await api(`/api/guilds/${guildId}/preview`, { method: 'POST', body: { message: text, config: draft, tone } });
            setHistory((h) => [...h, { me: text, ...result }]);
            setMessage('');
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid-2" style={{ alignItems: 'start' }}>
            <div className="card stack">
                <div>
                    <h2>Test your unsaved settings</h2>
                    <p className="help">Runs your current draft (including unsaved changes) through the same prompt and safety filters the live bot uses. Nothing is posted to Discord. Limited to 10 tests per 10 minutes.</p>
                </div>
                <div className="field">
                    <span className="label">Reply tone</span>
                    <Segmented label="Reply tone" value={tone} onChange={setTone} options={tones.map((t) => ({ value: t, label: TONE_LABELS[t] }))} />
                    <span className="help">{TONE_HELP[tone]} Send the same message in each tone to compare.</span>
                </div>
                <form onSubmit={run} className="stack">
                    <div className="field">
                        <label htmlFor="testmsg">Test message</label>
                        <textarea id="testmsg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} placeholder="e.g. bro my exam is tomorrow and I haven't studied" />
                    </div>
                    <div><button className="btn btn-primary" type="submit" disabled={busy || !message.trim()}>{busy ? 'Thinking…' : 'Send test message'}</button></div>
                </form>
            </div>
            <div className="card stack" aria-live="polite">
                <h2>Result</h2>
                {history.length === 0 ? <p className="muted small">Replies appear here.</p> : null}
                <div className="chat">
                    {history.map((h, i) => (
                        <div key={i} className="chat">
                            <div className="bubble me">{h.me}</div>
                            {h.reply ? <div className="bubble bot">{h.reply}</div> : null}
                            {h.note ? <span className="help">{h.note}</span> : null}
                            {h.summary ? <span className="help">Tone: <strong>{TONE_LABELS[h.summary.tone] || h.summary.tone}</strong></span> : null}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function HistoryTab({ guildId }) {
    const [state, setState] = useState({ loading: true, entries: [], error: null });
    useEffect(() => {
        let alive = true;
        api(`/api/guilds/${guildId}/audit`)
            .then(({ entries }) => alive && setState({ loading: false, entries, error: null }))
            .catch((error) => alive && setState({ loading: false, entries: [], error: error.message }));
        return () => {
            alive = false;
        };
    }, [guildId]);

    if (state.loading) return <div className="stack"><div className="skeleton" /><div className="skeleton" /></div>;
    if (state.error) return <div className="notice" role="alert">{state.error}</div>;
    if (state.entries.length === 0) return <div className="card empty"><p className="muted" style={{ margin: 0 }}>No changes recorded yet.</p></div>;
    return (
        <div className="card audit">
            {state.entries.map((e) => (
                <div key={e.id} className="audit-row">
                    <span><strong>{e.actor}</strong> {e.action === 'INSERT' ? 'created' : e.action === 'DELETE' ? 'removed' : 'updated'} {e.target}</span>
                    <span className="help">{new Date(e.at).toLocaleString()}{e.fields.length ? ` · ${e.fields.slice(0, 6).join(', ')}${e.fields.length > 6 ? '…' : ''}` : ''}</span>
                </div>
            ))}
        </div>
    );
}

const PERIOD_LABELS = { monthly: 'Monthly', yearly: 'Yearly' };

// Load Razorpay's Standard Checkout script once, only when someone pays.
const RAZORPAY_CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let razorpayScript = null;
function loadRazorpayCheckout() {
    if (typeof window.Razorpay === 'function') return Promise.resolve();
    if (!razorpayScript) {
        razorpayScript = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = RAZORPAY_CHECKOUT_SRC;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => {
                razorpayScript = null;
                script.remove();
                reject(new Error('Could not load Razorpay Checkout.'));
            };
            document.head.appendChild(script);
        });
    }
    return razorpayScript;
}

function PremiumTab({ guildId, plan, setPlan, perks, contactUrl, toast }) {
    const [busy, setBusy] = useState(null);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const [watching, setWatching] = useState(false);
    const end = plan.currentPeriodEnd ? new Date(plan.currentPeriodEnd).toLocaleDateString() : null;

    // While a checkout is open on Razorpay's page, ask our server (which asks
    // Razorpay) every 5 s whether the first payment went through. Stops after
    // 15 minutes or as soon as Premium is active.
    useEffect(() => {
        if (!watching) return undefined;
        let stopped = false;
        const startedAt = Date.now();
        const timer = setInterval(async () => {
            if (stopped) return;
            if (Date.now() - startedAt > 15 * 60 * 1000) {
                setWatching(false);
                return;
            }
            try {
                const { plan: next } = await api(`/api/guilds/${guildId}/billing/sync`, { method: 'POST' });
                setPlan(next);
                if (next.premium && next.status === 'active' && !next.checkoutPending) {
                    setWatching(false);
                    toast('💎 Premium is active for this server. Thank you!');
                }
            } catch {
                // Transient: keep polling.
            }
        }, 5000);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [watching, guildId, setPlan, toast]);

    // Razorpay Standard Checkout: our server creates the subscription, the
    // modal collects the payment, and our server verifies the signature.
    async function checkout(period) {
        setBusy(period);
        let session;
        try {
            [session] = await Promise.all([
                api(`/api/guilds/${guildId}/billing/checkout`, { method: 'POST', body: { period } }),
                loadRazorpayCheckout().catch(() => null)
            ]);
        } catch (error) {
            toast(error.message, 'err');
            setBusy(null);
            return;
        }

        if (typeof window.Razorpay !== 'function') {
            // Script blocked (e.g. an ad-blocker): pay on Razorpay's hosted page instead.
            setBusy(null);
            setWatching(true);
            window.location.href = session.url;
            return;
        }

        const rzp = new window.Razorpay({
            key: session.keyId,
            subscription_id: session.subscriptionId,
            name: 'ZiGBoT Premium',
            description: `${PERIOD_LABELS[period]} plan for this server`,
            image: `${window.location.origin}/zigbot.png`,
            theme: { color: '#a855f7' },
            handler: async (response) => {
                setBusy('verify');
                try {
                    const { plan: next } = await api(`/api/guilds/${guildId}/billing/verify`, {
                        method: 'POST',
                        body: {
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_subscription_id: response.razorpay_subscription_id,
                            razorpay_signature: response.razorpay_signature
                        }
                    });
                    setPlan(next);
                    if (next.premium && next.status === 'active') {
                        toast('💎 Payment verified — Premium is active for this server. Thank you!');
                    } else {
                        // Signature is valid; Razorpay is still activating the subscription.
                        toast('Payment verified. Razorpay is activating your subscription — this updates in a few seconds.');
                        setWatching(true);
                    }
                } catch (error) {
                    toast(error.message, 'err');
                } finally {
                    setBusy(null);
                }
            },
            modal: {
                ondismiss: () => {
                    setBusy(null);
                    toast('Checkout closed. Nothing was charged.');
                }
            }
        });
        rzp.on('payment.failed', (response) => {
            toast(`Payment failed: ${response?.error?.description || 'please try another method.'}`, 'err');
        });
        rzp.open();
    }

    async function refresh() {
        setBusy('refresh');
        try {
            const { plan: next } = await api(`/api/guilds/${guildId}/billing/sync`, { method: 'POST' });
            setPlan(next);
            toast(next.premium ? 'Premium is active.' : 'No completed payment yet.');
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    async function cancel() {
        setBusy('cancel');
        try {
            const { plan: next } = await api(`/api/guilds/${guildId}/billing/cancel`, { method: 'POST' });
            setPlan(next);
            setConfirmCancel(false);
            toast(next.currentPeriodEnd ? `Renewal cancelled. Premium stays until ${new Date(next.currentPeriodEnd).toLocaleDateString()}.` : 'Renewal cancelled.');
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    let status;
    if (plan.isHome) status = 'You own this server, so every Premium feature is always on — free.';
    else if (plan.status === 'active' && plan.cancelAtPeriodEnd) status = `Renewal cancelled — Premium stays active until ${end || 'the end of this period'}.`;
    else if (plan.status === 'active') status = `Premium (${PERIOD_LABELS[plan.period] || 'subscription'}) is active${end ? ` and renews on ${end}` : ''}.`;
    else if (plan.status === 'pending') status = `The last renewal payment failed and Razorpay is retrying. Premium stays on until ${end || 'the end of this period'}.`;
    else if (plan.status === 'halted') status = 'Premium is paused because the renewal payment kept failing. Start a new subscription to restore it.';
    else if (plan.premium && plan.status === 'cancelled') status = `Subscription cancelled — Premium stays active until ${end}.`;
    else if (watching || plan.checkoutPending) status = 'Waiting for your payment on Razorpay…';
    else status = 'This server is on the free plan.';

    const renewing = plan.status === 'active' && !plan.cancelAtPeriodEnd;
    const canBuy = !plan.isHome && !renewing;

    return (
        <div className="stack">
            <div className="card stack premium-hero">
                <div>
                    <h2>💎 ZiGBoT Premium</h2>
                    <p className="muted" style={{ margin: 0 }} aria-live="polite">{status}</p>
                </div>
                <div className="perk-grid">
                    {perks.map((perk) => (
                        <div key={perk.key} className="perk">
                            <strong>{perk.title}</strong>
                            <span className="help">{perk.text}</span>
                        </div>
                    ))}
                </div>
                {canBuy ? (
                    plan.billingEnabled ? (
                        <div className="row">
                            <button className="btn btn-primary btn-lg" onClick={() => checkout('monthly')} disabled={Boolean(busy)}>
                                {busy === 'monthly' ? 'Opening Razorpay…' : `Monthly${plan.prices?.monthly ? ` · ${plan.prices.monthly}` : ''}`}
                            </button>
                            <button className="btn btn-primary btn-lg" onClick={() => checkout('yearly')} disabled={Boolean(busy)}>
                                {busy === 'yearly' ? 'Opening Razorpay…' : `Yearly${plan.prices?.yearly ? ` · ${plan.prices.yearly}` : ''}`}
                            </button>
                            {watching || plan.checkoutPending ? (
                                <button className="btn" onClick={refresh} disabled={Boolean(busy)}>{busy === 'refresh' ? 'Checking…' : 'I’ve paid — check now'}</button>
                            ) : null}
                        </div>
                    ) : (
                        <p className="help" style={{ margin: 0 }}>Premium checkout is not open yet. Check back soon!</p>
                    )
                ) : null}
                {canBuy && plan.billingEnabled ? <p className="help" style={{ margin: 0 }}>Paid securely through Razorpay — UPI Autopay, cards (Indian and international) and netbanking. Premium applies to this server only; cancel any time and it stays active until the end of the period you paid for.</p> : null}
                {renewing && !plan.isHome ? (
                    confirmCancel ? (
                        <div className="row">
                            <span className="small">Stop renewing? Premium stays until {end || 'the end of this period'}.</span>
                            <button className="btn" onClick={() => setConfirmCancel(false)} disabled={busy === 'cancel'}>Keep Premium</button>
                            <button className="btn btn-danger" onClick={cancel} disabled={busy === 'cancel'}>{busy === 'cancel' ? 'Cancelling…' : 'Yes, cancel renewal'}</button>
                        </div>
                    ) : (
                        <div><button className="btn btn-ghost btn-danger" onClick={() => setConfirmCancel(true)}>Cancel renewal…</button></div>
                    )
                ) : null}
            </div>
            {contactUrl ? (
                <div className="card spread">
                    <div>
                        <h3>Questions about Premium?</h3>
                        <p className="help" style={{ margin: 0 }}>Message ZiG, ZiGBoT’s creator, directly on Discord.</p>
                    </div>
                    <a className="btn" href={contactUrl} target="_blank" rel="noreferrer">💬 Message ZiG on Discord</a>
                </div>
            ) : null}
        </div>
    );
}
