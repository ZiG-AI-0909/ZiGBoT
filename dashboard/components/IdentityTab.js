'use client';

import { useEffect, useState } from 'react';

// Custom bot identity (Premium): nickname, avatar and bio for ZiGBoT in this
// server, with a live preview. Every rule is enforced again on the server;
// the checks here only give quicker feedback.

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const REVERT_REASONS = {
    premium_lapsed: 'this server’s Premium ended',
    premium_inactive: 'this server isn’t Premium right now',
    blocked: 'custom identity was turned off for this server',
    not_enabled_here: 'custom identity isn’t available in this server yet',
    feature_disabled: 'custom identity was switched off for a while'
};

async function request(path, { method = 'GET', form } = {}) {
    const response = await fetch(path, { method, body: form, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status}).`);
        error.data = data;
        throw error;
    }
    return data;
}

function Preview({ name, bio, avatarSrc, guildName }) {
    return (
        <div className="identity-preview" aria-label="Preview of how ZiGBoT will look in this server">
            <div className="identity-message">
                <img className="identity-avatar" src={avatarSrc} alt="" width="40" height="40" />
                <div>
                    <div className="identity-name-row">
                        <strong>{name || 'ZiGBoT'}</strong>
                        <span className="identity-app-tag">APP</span>
                    </div>
                    <p className="identity-text">Hey! I’m {name || 'ZiGBoT'}, here for {guildName}. Ask me anything 👋</p>
                </div>
            </div>
            <div className="identity-card">
                <img className="identity-avatar identity-avatar-lg" src={avatarSrc} alt="" width="72" height="72" />
                <div className="identity-name-row">
                    <strong>{name || 'ZiGBoT'}</strong>
                    <span className="identity-app-tag">APP</span>
                </div>
                <p className="help" style={{ margin: 0 }}>{bio || 'No server bio.'}</p>
            </div>
            <p className="help" style={{ margin: 0 }}>Preview. Discord always shows the APP tag, so members can tell it’s a bot.</p>
        </div>
    );
}

export default function IdentityTab({ guildId, guildName, premium, onUpgrade, toast }) {
    const [state, setState] = useState({ loading: true, data: null, error: null });
    const [nick, setNick] = useState('');
    const [bio, setBio] = useState('');
    const [file, setFile] = useState(null);
    const [fileUrl, setFileUrl] = useState(null);
    const [removeAvatar, setRemoveAvatar] = useState(false);
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [version, setVersion] = useState(0);

    useEffect(() => {
        let alive = true;
        request(`/api/guilds/${guildId}/identity`)
            .then((data) => {
                if (!alive) return;
                setState({ loading: false, data, error: null });
                setNick(data.identity?.nick || '');
                setBio(data.identity?.bio || '');
            })
            .catch((error) => alive && setState({ loading: false, data: null, error: error.message }));
        return () => {
            alive = false;
        };
    }, [guildId, version]);

    useEffect(() => () => {
        if (fileUrl) URL.revokeObjectURL(fileUrl);
    }, [fileUrl]);

    if (state.loading) return <div className="stack"><div className="skeleton" /><div className="skeleton" /></div>;
    if (state.error) return <div className="notice" role="alert">{state.error}</div>;
    const data = state.data;
    if (!data?.enabled) return <div className="card empty"><p className="muted" style={{ margin: 0 }}>Custom bot identity isn’t available yet.</p></div>;
    const identity = data.identity;
    const limits = data.limits;
    const locked = !premium || data.blocked;

    function pickFile(event) {
        const picked = event.target.files?.[0] || null;
        setErrors((e) => ({ ...e, avatar: null }));
        if (fileUrl) URL.revokeObjectURL(fileUrl);
        setFile(null);
        setFileUrl(null);
        if (!picked) return;
        if (!ACCEPT.includes(picked.type)) {
            setErrors((e) => ({ ...e, avatar: 'Please pick a PNG, JPG or WebP picture.' }));
            return;
        }
        if (picked.size > limits.imageMaxBytes) {
            setErrors((e) => ({ ...e, avatar: `Pictures can be at most ${limits.imageMaxBytes / (1024 * 1024)} MB.` }));
            return;
        }
        setRemoveAvatar(false);
        setFile(picked);
        setFileUrl(URL.createObjectURL(picked));
    }

    async function save(event) {
        event.preventDefault();
        setBusy('save');
        setErrors({});
        const form = new FormData();
        form.set('nick', nick);
        form.set('bio', bio);
        if (file) form.set('avatar', file);
        if (removeAvatar) form.set('remove_avatar', '1');
        try {
            const next = await request(`/api/guilds/${guildId}/identity`, { method: 'PUT', form });
            setState({ loading: false, data: next, error: null });
            setFile(null);
            setFileUrl(null);
            setRemoveAvatar(false);
            toast(file ? 'Saved. The name and bio are live; the new picture goes live after a quick review.' : 'Saved. ZiGBoT’s profile in this server is updated.');
        } catch (error) {
            setErrors(error.data?.fieldErrors || {});
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    async function reset() {
        setBusy('reset');
        try {
            const result = await request(`/api/guilds/${guildId}/identity`, { method: 'DELETE' });
            setConfirmReset(false);
            setFile(null);
            setFileUrl(null);
            toast(result.warning || 'ZiGBoT is back to its default name, picture and bio here.', result.warning ? 'err' : 'ok');
            setVersion((v) => v + 1);
        } catch (error) {
            toast(error.message, 'err');
        } finally {
            setBusy(null);
        }
    }

    // Preview: the new upload, else the approved picture, else the default.
    const avatarSrc = fileUrl || (!removeAvatar && identity?.hasAvatar ? `/api/guilds/${guildId}/identity/avatar?slot=live` : '/zigbot.png');

    return (
        <div className="stack">
            {!premium ? (
                <div className="premium-note">
                    <span>💎 Custom bot identity is a Premium feature. Without Premium, ZiGBoT keeps its default name and picture here.</span>
                    <button type="button" className="btn btn-primary" onClick={onUpgrade}>See Premium</button>
                </div>
            ) : null}
            {data.blocked ? <div className="notice" role="alert">Custom bot identity has been turned off for this server or your account. Contact ZiGBoT support if you think this is a mistake.</div> : null}
            {identity?.revertedAt && REVERT_REASONS[identity.revertReason] ? (
                <div className="notice">ZiGBoT went back to its default profile on {new Date(identity.revertedAt).toLocaleDateString()} because {REVERT_REASONS[identity.revertReason]}. Your saved identity comes back when that changes.</div>
            ) : null}
            {identity?.hasPending ? <div className="notice">A new picture is waiting for review. Until then, members see {identity.hasAvatar ? 'the previously approved picture' : 'the default ZiGBoT picture'}.</div> : null}
            {identity?.reviewNote ? <div className="notice" role="alert">Your last picture wasn’t approved: {identity.reviewNote}</div> : null}

            <div className="identity-grid">
                <form className="card stack" onSubmit={save} aria-label="Custom bot identity">
                    <div>
                        <h2 style={{ margin: 0 }}>🪪 ZiGBoT’s identity here</h2>
                        <p className="help" style={{ margin: 0 }}>Give ZiGBoT its own name, picture and bio in this server only. It never pretends to be a person: Discord’s APP tag always shows.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="identity-nick">Name</label>
                        <span className="help" id="identity-nick-help">Leave empty to keep “ZiGBoT”. No Discord/ZiGBoT staff names, other bots’ names, @ # : or profanity.</span>
                        <input id="identity-nick" type="text" value={nick} maxLength={limits.nickMax} disabled={locked} onChange={(e) => setNick(e.target.value)} aria-invalid={errors.nick ? 'true' : undefined} aria-describedby="identity-nick-help" />
                        <div className="spread">
                            {errors.nick ? <span className="error" role="alert">{errors.nick}</span> : <span />}
                            <span className={`counter ${nick.length > limits.nickMax ? 'over' : ''}`}>{nick.length}/{limits.nickMax}</span>
                        </div>
                    </div>
                    <div className="field">
                        <label htmlFor="identity-bio">Bio</label>
                        <span className="help" id="identity-bio-help">Shown on ZiGBoT’s profile in this server. No links, invites or mentions.</span>
                        <textarea id="identity-bio" rows={3} value={bio} maxLength={limits.bioMax} disabled={locked} onChange={(e) => setBio(e.target.value)} aria-invalid={errors.bio ? 'true' : undefined} aria-describedby="identity-bio-help" />
                        <div className="spread">
                            {errors.bio ? <span className="error" role="alert">{errors.bio}</span> : <span />}
                            <span className={`counter ${bio.length > limits.bioMax ? 'over' : ''}`}>{bio.length}/{limits.bioMax}</span>
                        </div>
                    </div>
                    <div className="field">
                        <label htmlFor="identity-avatar">Picture</label>
                        <span className="help" id="identity-avatar-help">PNG, JPG or WebP, up to {limits.imageMaxBytes / (1024 * 1024)} MB, at least {limits.imageMinPx}×{limits.imageMinPx}. It’s cropped to a square, its metadata (like location) is removed, and it goes live after a quick review.</span>
                        <input id="identity-avatar" type="file" accept={ACCEPT.join(',')} disabled={locked} onChange={pickFile} aria-invalid={errors.avatar ? 'true' : undefined} aria-describedby="identity-avatar-help" />
                        {errors.avatar ? <span className="error" role="alert">{errors.avatar}</span> : null}
                        {identity?.hasAvatar || identity?.hasPending ? (
                            <label className="row small" htmlFor="identity-remove">
                                <input id="identity-remove" type="checkbox" checked={removeAvatar} disabled={locked || Boolean(file)} onChange={(e) => setRemoveAvatar(e.target.checked)} />
                                Remove the custom picture (use the default ZiGBoT picture)
                            </label>
                        ) : null}
                    </div>
                    <div className="row">
                        <button type="submit" className="btn btn-primary" disabled={locked || Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save identity'}</button>
                        <span className="help">Up to {limits.changesPerHour} changes an hour.</span>
                    </div>
                </form>
                <Preview name={nick.trim()} bio={bio.trim()} avatarSrc={avatarSrc} guildName={guildName} />
            </div>

            <div className="card">
                <div className="spread">
                    <div>
                        <h3>Reset to default ZiGBoT</h3>
                        <p className="help" style={{ margin: 0 }}>Puts back the default name, picture and bio, and deletes the saved identity and pictures. You can do this any time.</p>
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
        </div>
    );
}
