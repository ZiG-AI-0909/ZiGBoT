'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import IdentityTab from './IdentityTab';
import LanguageSelect from './LanguageSelect';
import PersonaTemplates from './PersonaTemplates';

const TABS = [
    { id: 'behaviour', label: 'AI behaviour' },
    { id: 'roles', label: 'Roles' },
    { id: 'channels', label: 'Channels' },
    { id: 'features', label: 'Features' },
    { id: 'music', label: '🎵 Music' },
    { id: 'voice', label: '🎙️ Voice' },
    { id: 'identity', label: '🪪 Identity' },
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
const INTENSITY_LABELS = { mild: 'Mild', spicy: 'Spicy', savage: 'Savage' };
const INTENSITY_HELP = {
    mild: 'Light, friendly teasing. No profanity.',
    spicy: 'Sharp roasts with desi slang and attitude. No profanity.',
    savage: 'Brutal roasts with attitude and mild profanity (like saala, kamina, damn).'
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
    // The form always holds a supported language (meta.languages). An old or
    // unknown saved value is shown as the default and flagged until saved.
    const languageValues = meta.languages.map((l) => l.value);
    const withLanguage = (config) => (languageValues.includes(config.language) ? config : { ...config, language: meta.defaultLanguage });
    const formOf = (config) => withLanguage(stripMeta(config));
    const [tab, setTab] = useState('behaviour');
    const [saved, setSaved] = useState(initial.config);
    const [draft, setDraft] = useState(formOf(initial.config));
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

    const configDirty = JSON.stringify(formOf(saved)) !== JSON.stringify(draft);
    const mappingsDirty = JSON.stringify(savedMappings) !== JSON.stringify(mappings);
    const dirty = configDirty || mappingsDirty;
    // Saved language not on the list (old free text, "English-Hinglish mix", or never set).
    const staleLanguage = languageValues.includes(saved.language) ? null : (saved.language || '');
    const canSave = dirty || staleLanguage !== null;

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
            if (configDirty || staleLanguage !== null) {
                const { config } = await api(`/api/guilds/${initial.guild.id}/config`, { method: 'PUT', body: { config: draft, expectedVersion: saved.version } });
                setSaved(config);
                setDraft(formOf(config));
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
                setTab(/^music_/.test(first) ? 'music' : /^voice_/.test(first) ? 'voice' : /_role_ids$|owner_pronouns/.test(first) ? 'roles' : /channel|respond|cooldown|keyword/.test(first) ? 'channels' : /memory|reputation|music|voice|legacy/.test(first) ? 'features' : 'behaviour');
            }
            toast(error.status === 401 ? 'Your session expired. Sign in again.' : error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    function discard() {
        setDraft(formOf(saved));
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
                setDraft(formOf(config));
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
                {TABS.filter((t) => t.id !== 'identity' || meta.identityEnabled).map((t) => (
                    <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} id={`tab-${t.id}`} onClick={() => setTab(t.id)}>{t.label}</button>
                ))}
            </div>

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === 'behaviour' ? <BehaviourTab draft={draft} saved={saved} set={set} errors={fieldErrors} meta={meta} premium={premium} channels={channels} staleLanguage={staleLanguage} updateDraft={setDraft} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'roles' ? <ServerSetupCard draft={draft} set={set} errors={fieldErrors} roles={roles} /> : null}
                {tab === 'roles' ? <div style={{ marginTop: 16 }}><RolesTab roles={roles} roleById={roleById} mappings={mappings} setMappings={setMappings} errors={mappingErrors} meta={meta} premium={premium} onUpgrade={() => setTab('premium')} /></div> : null}
                {tab === 'voice' ? <VoiceTab draft={draft} set={set} errors={fieldErrors} meta={meta} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'channels' ? <ChannelsTab draft={draft} set={set} errors={fieldErrors} channels={channels} /> : null}
                {tab === 'features' ? <FeaturesTab draft={draft} set={set} isHome={initial.guild.isHome} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'music' ? <MusicTab guildId={initial.guild.id} draft={draft} set={set} errors={fieldErrors} roles={roles} channels={channels} premium={premium} onUpgrade={() => setTab('premium')} /> : null}
                {tab === 'premium' ? <PremiumTab guildId={initial.guild.id} plan={plan} setPlan={setPlan} perks={meta.perks} contactUrl={meta.contactUrl} toast={toast} /> : null}
                {tab === 'identity' && meta.identityEnabled ? <IdentityTab guildId={initial.guild.id} guildName={initial.guild.name} premium={premium} onUpgrade={() => setTab('premium')} toast={toast} /> : null}
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

            {canSave ? (
                <div className="savebar" role="region" aria-label="Unsaved changes">
                    <div className="inner">
                        <span className="small">{dirty
                            ? `You have unsaved changes${mappingsDirty && configDirty ? ' (settings and roles)' : mappingsDirty ? ' (roles)' : ''}.`
                            : `This server's language needs saving: it will be set to ${draft.language}.`}</span>
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

const GIF_MODE_LABELS = { gentle: 'Gentle', neutral: 'Neutral helper', savage: 'Savage roast' };
const GIF_MODE_HELP = {
    gentle: 'Wholesome only. Roast GIFs are always off here, and under-18 members always get these rules.',
    neutral: 'Wholesome plus facepalm and mind-blown. No roasts.',
    savage: 'Everything, including roast GIFs when someone trash-talks ZiGBoT or bullies a member.'
};

// Reaction GIFs per persona mode (rules: lib/shared/gifs.js, enforced again on save and by the bot).
function GifSettings({ value, onChange, meta, premium, channels, error, onUpgrade }) {
    const gifs = value || {};
    const modes = gifs.modes || {};
    const update = (patch) => onChange({ ...gifs, ...patch });
    const updateMode = (mode, patch) => update({ modes: { ...modes, [mode]: { ...modes[mode], ...patch } } });
    const toggleStyle = (mode, style, on) => {
        const current = modes[mode]?.styles || [];
        const next = on ? [...current, style] : current.filter((s) => s !== style);
        updateMode(mode, { styles: meta.gif.modeStyles[mode].filter((s) => next.includes(s)) });
    };
    return (
        <div className="card stack">
            <div>
                <h2>Reaction GIFs</h2>
                <p className="help">Now and then ZiGBoT adds a GIF that fits the moment. GIFs come from GIPHY at its strictest rating (G), searched only from ZiGBoT’s own short style list — never from what members type.</p>
            </div>
            <Switch id="gifs-enabled" checked={gifs.enabled} onChange={(on) => update({ enabled: on })} label="Reaction GIFs" help="Off: no GIFs anywhere in this server." />
            <div className="field">
                <label htmlFor="gifs-channels">Where</label>
                <select id="gifs-channels" value={gifs.channels || 'chat'} disabled={!gifs.enabled} onChange={(e) => update({ channels: e.target.value })}>
                    <option value="chat">Only in chat channels (where ZiGBoT chats freely)</option>
                    <option value="all">Anywhere ZiGBoT replies</option>
                </select>
            </div>
            <ChannelPicker id="gifs-blocked" label="Never send GIFs in" channels={channels} selected={gifs.blocked_channel_ids || []} onChange={(ids) => update({ blocked_channel_ids: ids })} />
            {meta.gif && Object.keys(meta.gif.modeStyles).map((mode) => {
                const settings = modes[mode] || {};
                return (
                    <fieldset key={mode} className="gif-mode" disabled={!gifs.enabled}>
                        <legend>{GIF_MODE_LABELS[mode] || mode}</legend>
                        <p className="help" style={{ margin: 0 }}>{GIF_MODE_HELP[mode]}</p>
                        <div className="grid-2">
                            <Switch id={`gifs-${mode}`} checked={settings.enabled !== false} onChange={(on) => updateMode(mode, { enabled: on })} label="GIFs in this mode" />
                            <div className="field">
                                <label htmlFor={`gifs-${mode}-freq`}>How often</label>
                                <select id={`gifs-${mode}-freq`} value={settings.frequency || 'normal'} onChange={(e) => updateMode(mode, { frequency: e.target.value })}>
                                    <option value="rare">Rare (at most 1 in 20 replies)</option>
                                    <option value="normal">Normal (at most 1 in 8)</option>
                                    <option value="often">Often (at most 1 in 4)</option>
                                </select>
                            </div>
                        </div>
                        {mode === 'savage' ? (
                            <Switch id="gifs-savage-roast" checked={settings.roast !== false} onChange={(on) => updateMode(mode, { roast: on })} label="Roast GIFs" help="Mic drop, side-eye, “you tried”… for trash talk at ZiGBoT and for backing up a bullied member." />
                        ) : null}
                        <div className="checklist gif-styles" role="group" aria-label={`${GIF_MODE_LABELS[mode]} GIF styles`}>
                            {meta.gif.modeStyles[mode].map((style) => (
                                <label key={style}>
                                    <input type="checkbox" checked={(settings.styles || []).includes(style)} disabled={mode === 'savage' && meta.gif.styles[style].roast && settings.roast === false} onChange={(e) => toggleStyle(mode, style, e.target.checked)} />
                                    <span>{meta.gif.styles[style].label}</span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                );
            })}
            <div className="field">
                <label htmlFor="gifs-custom-style">GIF style for your custom persona {premium ? null : <span className="pill pill-premium">Premium</span>}</label>
                <span className="help" id="gifs-custom-style-help">Optional, e.g. “pirate”, “anime” or “90s cartoons”. Added to GIF searches when your custom persona replies. Empty: ZiGBoT guesses from the persona. It goes through the same safety filters as everything else.</span>
                <input id="gifs-custom-style" type="text" value={gifs.custom_style || ''} maxLength={meta.gif.styleMax} disabled={!premium || !gifs.enabled} onChange={(e) => update({ custom_style: e.target.value })} aria-describedby="gifs-custom-style-help" aria-invalid={error ? 'true' : undefined} />
                {premium ? null : <PremiumNote onUpgrade={onUpgrade}>A custom persona GIF style is a Premium feature, like custom personas.</PremiumNote>}
            </div>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </div>
    );
}

function BehaviourTab({ draft, set, errors, meta, premium, channels, staleLanguage = null, updateDraft, onUpgrade }) {
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
                <Switch id="owner-roast" checked={draft.owner_roast} onChange={set('owner_roast')} label="Roast the owner too" help="Off: the server owner always gets ZiGBoT's respectful assistant mode. On: the owner is roasted like everyone else (safety rules still apply)." />
                {errors.default_tone ? <span className="error">{errors.default_tone}</span> : null}
            </div>
            <div className="card stack">
                <div>
                    <h2>Savage roast intensity</h2>
                    <p className="help">How hard ZiGBoT roasts members who get the Savage tone. At every level it roasts only what someone said or did: never sexual content, family insults, slurs, or anything about caste, religion, gender, looks, or disability. Members with the under-18 role always get Gentle.</p>
                </div>
                <Segmented label="Savage roast intensity" value={draft.roast_intensity} onChange={set('roast_intensity')} options={meta.roastIntensities.map((v) => ({ value: v, label: INTENSITY_LABELS[v] }))} />
                <p className="help" style={{ margin: 0 }}>{INTENSITY_HELP[draft.roast_intensity]}</p>
                {errors.roast_intensity ? <span className="error" role="alert">{errors.roast_intensity}</span> : null}
            </div>
            <div className="card stack">
                <div>
                    <h2>Custom personality {premium ? null : <span className="pill pill-premium">Premium</span>}</h2>
                    <p className="help">Describe who ZiGBoT should be here. ZiGBoT’s safety rules always apply and cannot be switched off from here.</p>
                </div>
                {premium ? null : <PremiumNote onUpgrade={onUpgrade}>A custom personality is a Premium feature. Anything saved here earlier is kept but not used until this server is Premium.</PremiumNote>}
                <PersonaTemplates draft={draft} updateDraft={updateDraft} premium={premium} />
                <Switch id="replace" disabled={!premium} checked={draft.replace_base_persona} onChange={set('replace_base_persona')} label="Replace the ZiGBoT persona entirely" help="Off: your text is added on top of the selected tone. On: your text becomes the whole personality." />
                {errors.replace_base_persona ? <span className="error">{errors.replace_base_persona}</span> : null}
                <TextArea id="prompt" disabled={!premium} label="Personality / system prompt" value={draft.custom_system_prompt} onChange={set('custom_system_prompt')} max={meta.limits.customSystemPrompt} error={errors.custom_system_prompt} rows={7} placeholder="e.g. You are the cheerful mascot of an anime art server. Hype up people's artwork and answer art questions." />
                <TextArea id="instructions" label="How to respond to different messages" value={draft.response_instructions} onChange={set('response_instructions')} max={meta.limits.responseInstructions} error={errors.response_instructions} placeholder="e.g. Questions about events: point to #announcements. Art feedback: be specific and kind." />
                <TextArea id="rules" label="Server rules and restrictions" value={draft.server_rules} onChange={set('server_rules')} max={meta.limits.serverRules} error={errors.server_rules} placeholder="e.g. No spoilers for ongoing anime. Never discuss politics." />
            </div>
            <div className="card grid-2">
                <div>
                    <LanguageSelect
                        id="language"
                        label="Language"
                        help="The language ZiGBoT replies in here. /setup sets the same thing."
                        options={meta.languages}
                        value={draft.language}
                        onChange={set('language')}
                        notice={staleLanguage === null ? null : staleLanguage
                            ? `This server had “${staleLanguage}” saved, which isn’t a supported choice. It’s shown as ${draft.language} and will be saved that way next time you save.`
                            : `No language was chosen yet (ZiGBoT has been using its original English–Hindi mix). It’s shown as ${draft.language} and will be saved that way next time you save.`}
                    />
                    {errors.language ? <span className="error" role="alert">{errors.language}</span> : null}
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
            <GifSettings value={draft.gif_settings} onChange={set('gif_settings')} meta={meta} premium={premium} channels={channels} error={errors.gif_settings} onUpgrade={onUpgrade} />
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

const SOURCE_NAMES = { youtube: 'YouTube', soundcloud: 'SoundCloud', direct: 'Direct link' };
const MUSIC_COMMANDS = [
    ['/play <song or link>', 'Play the best match (YouTube first, SoundCloud when YouTube is unavailable)'],
    ['/search <song>', 'Pick from the top 5 results'],
    ['/pause · /resume · /skip · /stop', 'Playback controls (also buttons on the music panel)'],
    ['/queue · /nowplaying', 'What is playing and what is next'],
    ['/volume · /loop · /shuffle', 'Volume 1-100, loop song/queue/off, shuffle'],
    ['/remove <position> · /clearqueue', 'Edit the queue'],
    ['/leave', 'Disconnect from voice']
];

function formatSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Live state comes from the bot through Supabase (read-only here): playback
// itself is controlled from Discord, never from the browser.
function MusicTab({ guildId, draft, set, errors, roles, channels, premium, onUpgrade }) {
    const [live, setLive] = useState({ loading: true, data: null, error: null });
    useEffect(() => {
        let alive = true;
        const load = () => api(`/api/guilds/${guildId}/music`)
            .then((data) => alive && setLive({ loading: false, data, error: null }))
            .catch((error) => alive && setLive((prev) => ({ loading: false, data: prev.data, error: error.message })));
        load();
        const timer = setInterval(load, 10_000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [guildId]);

    const djIds = draft.music_dj_role_ids || [];
    const djSet = new Set(djIds);
    const data = live.data;
    const state = data?.state;
    const health = data?.health;
    const track = state?.current_track;
    return (
        <div className="stack">
            {premium ? null : <PremiumNote onUpgrade={onUpgrade}>Music is a Premium feature. These settings take effect once this server is Premium.</PremiumNote>}

            <div className="card stack">
                <div className="spread">
                    <h2>Now playing</h2>
                    <span className="help">Updates every 10 seconds</span>
                </div>
                {live.loading ? <div className="skeleton" /> : null}
                {data?.migrationMissing ? <div className="notice" role="alert">Music status needs the database update <code>20261019010000_zigbot_music.sql</code>. Run it in Supabase → SQL Editor.</div> : null}
                {live.error ? <div className="notice" role="alert">{live.error}</div> : null}
                {data && !data.migrationMissing ? (
                    track ? (
                        <div className="row" style={{ alignItems: 'flex-start' }}>
                            {track.thumbnail ? <img src={track.thumbnail} alt="" width={120} height={68} style={{ borderRadius: 8, objectFit: 'cover' }} /> : null}
                            <div className="stack" style={{ gap: 4 }}>
                                <a href={track.url} target="_blank" rel="noreferrer"><strong>{track.title || track.url}</strong></a>
                                <span className="help">
                                    {[track.artist, formatSeconds(track.duration), `${SOURCE_NAMES[track.source] || track.source}${track.fallback_from ? ' (YouTube unavailable)' : ''}`].filter(Boolean).join(' · ')}
                                </span>
                                <div className="row">
                                    <span className={`pill ${state.status === 'playing' ? 'pill-ok' : 'pill-warn'}`}>{state.status === 'playing' ? 'Playing' : 'Paused'}</span>
                                    <span className="pill">Volume {state.volume}%</span>
                                    <span className="pill">Loop: {state.loop_mode}</span>
                                    <span className="pill">{state.queue_length} queued</span>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <p className="muted" style={{ margin: 0 }}>Nothing is playing in this server right now. Start music in Discord with <code>/play</code>.</p>
                    )
                ) : null}
                {state?.upcoming?.length ? (
                    <div className="stack" style={{ gap: 2 }}>
                        <span className="label">Up next</span>
                        {state.upcoming.map((t, i) => (
                            <span key={`${t.url}-${i}`} className="help">{i + 1}. {t.title || t.url}{t.duration ? ` · ${formatSeconds(t.duration)}` : ''}</span>
                        ))}
                        {state.queue_length > state.upcoming.length ? <span className="help">…and {state.queue_length - state.upcoming.length} more</span> : null}
                    </div>
                ) : null}
            </div>

            <div className="card stack">
                <h2>Music service status</h2>
                {data ? (
                    <div className="row">
                        <span className={`pill ${data.bot?.online ? 'pill-ok' : 'pill-bad'}`}>{data.bot?.online ? 'Bot online' : 'Bot offline'}</span>
                        {health ? (
                            <>
                                <span className={`pill ${health.ready && health.fresh ? 'pill-ok' : 'pill-bad'}`}>{health.ready && health.fresh ? 'Audio ready' : health.fresh ? 'Audio not ready' : 'No recent audio report'}</span>
                                <span className="pill">Searches: {SOURCE_NAMES[health.preferred_source] || health.preferred_source} first</span>
                                <span className="pill">{health.active_players} active player{health.active_players === 1 ? '' : 's'}</span>
                            </>
                        ) : <span className="pill pill-warn">No audio report yet</span>}
                    </div>
                ) : null}
                {health && !health.ready && health.fresh ? (
                    <div className="notice">The bot cannot play audio right now: {health.ytdlp_version ? '' : 'yt-dlp is missing (it installs during npm install). '}{health.ffmpeg_ready ? '' : 'ffmpeg is missing.'}</div>
                ) : null}
                {health?.last_error ? (
                    <p className="help" style={{ margin: 0 }}>Last playback problem{health.last_error_at ? ` (${new Date(health.last_error_at).toLocaleString()})` : ''}: {health.last_error}</p>
                ) : null}
                {health?.ytdlp_version ? <p className="help" style={{ margin: 0 }}>yt-dlp {health.ytdlp_version}</p> : null}
            </div>

            <div className="card stack">
                <h2>Settings</h2>
                <Switch id="music-enabled" checked={draft.music_enabled} onChange={set('music_enabled')} label="Music enabled in this server" help="Turns all music commands and the music panel on or off for everyone." />
                <div className="grid-2">
                    <div className="field">
                        <label htmlFor="music-volume">Starting volume: {draft.music_default_volume ?? 80}%</label>
                        <span className="help">Volume when a new music session starts.</span>
                        <input id="music-volume" type="range" min={1} max={100} value={draft.music_default_volume ?? 80} onChange={(e) => set('music_default_volume')(Number(e.target.value))} />
                        {errors.music_default_volume ? <span className="error">{errors.music_default_volume}</span> : null}
                    </div>
                    <div className="field">
                        <label htmlFor="music-idle">Leave after inactivity (minutes)</label>
                        <span className="help">With nothing playing or nobody listening, ZiGBoT leaves voice after this long.</span>
                        <input id="music-idle" type="number" min={1} max={60} value={draft.music_idle_minutes ?? 3} onChange={(e) => set('music_idle_minutes')(e.target.value === '' ? 1 : Number(e.target.value))} aria-invalid={errors.music_idle_minutes ? 'true' : undefined} />
                        {errors.music_idle_minutes ? <span className="error">{errors.music_idle_minutes}</span> : null}
                    </div>
                    <div className="field">
                        <label htmlFor="music-channel">Music request channel</label>
                        <span className="help">If set, /play and /search only work in this channel.</span>
                        <select id="music-channel" value={draft.music_channel_id || ''} onChange={(e) => set('music_channel_id')(e.target.value || null)} aria-invalid={errors.music_channel_id ? 'true' : undefined}>
                            <option value="">Any channel</option>
                            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                        </select>
                        {errors.music_channel_id ? <span className="error">{errors.music_channel_id}</span> : null}
                    </div>
                    <div className="field">
                        <span className="label" id="dj-label">DJ roles</span>
                        <span className="help">If any are picked, only DJs control playback (skip, stop, volume, queue edits). Server managers, whoever requested the current song (for skip) and someone alone with the bot always can. Leave empty to let everyone control music.</span>
                        <div className="checklist" role="group" aria-labelledby="dj-label">
                            {roles.length === 0 ? <span className="help" style={{ padding: 8 }}>No roles found.</span> : null}
                            {roles.map((r) => (
                                <label key={r.id}>
                                    <input type="checkbox" checked={djSet.has(r.id)} onChange={(e) => set('music_dj_role_ids')(e.target.checked ? [...djIds, r.id] : djIds.filter((x) => x !== r.id))} />
                                    <span>{r.name}</span>
                                </label>
                            ))}
                        </div>
                        {errors.music_dj_role_ids ? <span className="error">{errors.music_dj_role_ids}</span> : null}
                    </div>
                </div>
            </div>

            <div className="card stack">
                <h2>Commands</h2>
                <p className="help" style={{ margin: 0 }}>Music is controlled from Discord. Every song also gets a music panel with buttons.</p>
                {MUSIC_COMMANDS.map(([cmd, text]) => (
                    <div key={cmd} className="spread"><code>{cmd}</code><span className="help">{text}</span></div>
                ))}
            </div>
        </div>
    );
}

function titleCase(name) {
    return name.charAt(0).toUpperCase() + name.slice(1);
}

// One role picker for the /setup roles (same style as the channel pickers).
function RoleChecklist({ id, label, help, roles, selected, onChange, error }) {
    const set = new Set(selected || []);
    return (
        <div className="field">
            <span className="label" id={`${id}-label`}>{label}</span>
            {help ? <span className="help">{help}</span> : null}
            <div className="checklist" role="group" aria-labelledby={`${id}-label`}>
                {roles.length === 0 ? <span className="help" style={{ padding: 8 }}>No roles found.</span> : null}
                {roles.map((r) => (
                    <label key={r.id}>
                        <input type="checkbox" checked={set.has(r.id)} onChange={(e) => onChange(e.target.checked ? [...(selected || []), r.id] : (selected || []).filter((x) => x !== r.id))} />
                        <span style={{ color: roleColor(r.color) }}>●</span>
                        <span>{r.name}</span>
                    </label>
                ))}
            </div>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </div>
    );
}

// The same answers the bot's /setup command asks for, editable here too.
function ServerSetupCard({ draft, set, errors, roles }) {
    return (
        <div className="card stack">
            <h2>Server setup</h2>
            <p className="help" style={{ margin: 0 }}>What ZiGBoT cannot work out by itself. Same as the <code>/setup</code> command in Discord. The language is under <strong>AI behaviour</strong>.</p>
            <div className="field" style={{ maxWidth: 320 }}>
                <label htmlFor="owner-gender">Server owner's gender</label>
                <select id="owner-gender" value={draft.owner_pronouns || ''} onChange={(e) => set('owner_pronouns')(e.target.value || null)} aria-invalid={errors.owner_pronouns ? 'true' : undefined}>
                    <option value="">Not set</option>
                    <option value="he/him">Male (he/him)</option>
                    <option value="she/her">Female (she/her)</option>
                    <option value="they/them">Prefer not to say (they/them)</option>
                </select>
                {errors.owner_pronouns ? <span className="error">{errors.owner_pronouns}</span> : null}
            </div>
            <div className="grid-2">
                <RoleChecklist id="male-roles" label="Male roles (he/him)" roles={roles} selected={draft.male_role_ids} onChange={set('male_role_ids')} error={errors.male_role_ids} />
                <RoleChecklist id="female-roles" label="Female roles (she/her)" roles={roles} selected={draft.female_role_ids} onChange={set('female_role_ids')} error={errors.female_role_ids} />
                <RoleChecklist id="adult-roles" label="18+ roles" help="Members with these get roast mode." roles={roles} selected={draft.adult_role_ids} onChange={set('adult_role_ids')} error={errors.adult_role_ids} />
                <RoleChecklist id="minor-roles" label="Under-18 roles" help="Always gentle and clean, never roasted — beats every other setting." roles={roles} selected={draft.minor_role_ids} onChange={set('minor_role_ids')} error={errors.minor_role_ids} />
            </div>
        </div>
    );
}

function VoiceTab({ draft, set, errors, meta, premium, onUpgrade }) {
    const pace = draft.voice_pace ?? 100;
    return (
        <div className="stack">
            {premium ? null : <PremiumNote onUpgrade={onUpgrade}>Voice chat is a Premium feature. These settings take effect once this server is Premium.</PremiumNote>}
            <div className="card stack">
                <h2>Voice chat</h2>
                <Switch id="voice-enabled" checked={draft.voice_enabled} onChange={set('voice_enabled')} label="Voice chat enabled in this server" help="Lets ZiGBoT join voice channels to listen and talk (/join, or @ZiGBoT join)." />
                <Switch id="voice-speak-replies" checked={draft.voice_speak_replies} onChange={set('voice_speak_replies')} label="Speak typed replies out loud" help="When ZiGBoT is in a voice channel, replies to messages typed in that channel's chat (or by people sitting in it) are also spoken. Never while music is playing." />
            </div>
            <div className="card stack">
                <h2>ZiGBoT's voice</h2>
                <div className="grid-2">
                    <div className="field">
                        <label htmlFor="voice-speaker">Voice</label>
                        <span className="help">Natural Indian voices from Sarvam AI. Listen to them on Sarvam's website, then pick one here.</span>
                        <select id="voice-speaker" value={draft.voice_speaker || ''} onChange={(e) => set('voice_speaker')(e.target.value)} aria-invalid={errors.voice_speaker ? 'true' : undefined}>
                            <option value="">Default voice</option>
                            {meta.voiceSpeakers.map((name) => <option key={name} value={name}>{titleCase(name)}</option>)}
                        </select>
                        {errors.voice_speaker ? <span className="error">{errors.voice_speaker}</span> : null}
                    </div>
                    <div className="field">
                        <label htmlFor="voice-language">Accent / language</label>
                        <span className="help">Automatic follows the server language: English servers get Indian English, others Hindi/Hinglish.</span>
                        <select id="voice-language" value={draft.voice_language || 'auto'} onChange={(e) => set('voice_language')(e.target.value)}>
                            <option value="auto">Automatic</option>
                            <option value="hi-IN">Hindi / Hinglish</option>
                            <option value="en-IN">Indian English</option>
                        </select>
                    </div>
                    <div className="field">
                        <label htmlFor="voice-pace">Speaking speed: {(pace / 100).toFixed(2)}×</label>
                        <input id="voice-pace" type="range" min={50} max={200} step={5} value={pace} onChange={(e) => set('voice_pace')(Number(e.target.value))} />
                        {errors.voice_pace ? <span className="error">{errors.voice_pace}</span> : null}
                    </div>
                </div>
                <p className="help" style={{ margin: 0 }}>If the Indian voice service is unavailable, ZiGBoT falls back to its standard voice automatically.</p>
            </div>
            <div className="card stack">
                <h2>How to talk to ZiGBoT</h2>
                <div className="spread"><code>/join</code><span className="help">Call ZiGBoT into your voice channel (posts a panel with Start/Stop listening, Status and Leave)</span></div>
                <div className="spread"><code>Start listening</code><span className="help">Then just talk — server owner and admins switch listening on, because it controls recording</span></div>
                <div className="spread"><code>Type in the voice chat</code><span className="help">ZiGBoT answers in text and out loud</span></div>
            </div>
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

const AUDIT_VERBS = { INSERT: 'created', DELETE: 'removed', RESET: 'reset', APPLY: 'applied', REVERT: 'reverted', REVIEW: 'reviewed', BLOCK: 'changed a block on' };

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
                    <span><strong>{e.actor}</strong> {AUDIT_VERBS[e.action] || 'updated'} {e.target}</span>
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
            const fail = () => {
                clearTimeout(timer);
                razorpayScript = null;
                script.remove();
                reject(new Error('Could not load Razorpay Checkout.'));
            };
            // Never wait forever: a blocked or hanging script counts as a failure.
            const timer = setTimeout(fail, 10_000);
            script.src = RAZORPAY_CHECKOUT_SRC;
            script.async = true;
            script.onload = () => {
                clearTimeout(timer);
                if (typeof window.Razorpay === 'function') resolve();
                else fail();
            };
            script.onerror = fail;
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

        // Fallback: pay on Razorpay's hosted page, so the button can never stay stuck.
        const openHostedPage = () => {
            setBusy(null);
            setWatching(true);
            if (session?.url) window.location.href = session.url;
            else toast('Could not open Razorpay. Please disable ad-blockers and try again.', 'err');
        };

        if (typeof window.Razorpay !== 'function') {
            // Script blocked (e.g. an ad-blocker).
            openHostedPage();
            return;
        }

        try {
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
        } catch (error) {
            console.error('[razorpay] checkout failed to open', error);
            openHostedPage();
        }
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
