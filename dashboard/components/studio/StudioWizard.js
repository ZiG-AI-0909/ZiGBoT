'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import studio from '@/lib/studio/projects';

// The 5-step "Create new bot" wizard. The server validates everything again
// (lib/studio/projects.js validateNewProject) and enforces the plan limit.
// The Discord step is guidance only: no bot token is asked for here (tokens
// are entered later, encrypted on the server, and never shown again).
const { FRAMEWORKS, TEMPLATES, WIZARD_STEPS } = studio;

export default function StudioWizard() {
    const router = useRouter();
    const [step, setStep] = useState(0);
    const [draft, setDraft] = useState({ name: '', botName: '', description: '', visibility: 'private', framework: 'discordjs', template: 'blank' });
    const [errors, setErrors] = useState({});
    const [busy, setBusy] = useState(false);
    const set = (key) => (e) => setDraft({ ...draft, [key]: e.target.value });
    const framework = FRAMEWORKS.find((f) => f.id === draft.framework);

    // Check the current step locally before moving on (same rules as the server).
    function next() {
        const check = studio.validateNewProject({ ...draft, language: framework.language });
        const stepFields = [['name', 'botName', 'description', 'visibility'], ['framework', 'language'], ['template'], [], []][step];
        const stepErrors = Object.fromEntries(Object.entries(check.errors || {}).filter(([k]) => stepFields.includes(k)));
        setErrors(stepErrors);
        if (!Object.keys(stepErrors).length) setStep(step + 1);
    }

    async function create() {
        setBusy(true);
        setErrors({});
        try {
            const res = await fetch('/api/studio/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, language: framework.language }) });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setErrors({ ...(body.fieldErrors || {}), _: body.error || 'Could not create the project.' });
                if (body.fieldErrors?.name || body.fieldErrors?.botName) setStep(0);
                return;
            }
            router.push(`/studio/${body.project.id}`);
        } finally {
            setBusy(false);
        }
    }

    const field = (key, label, input, help) => (
        <div className="field">
            <label className="label" htmlFor={`wiz-${key}`}>{label}</label>
            {help ? <span className="help">{help}</span> : null}
            {input}
            {errors[key] ? <span className="error" role="alert">{errors[key]}</span> : null}
        </div>
    );

    return (
        <div className="card stack">
            <h1 style={{ margin: 0 }}>Create a new bot</h1>
            <ol className="row" aria-label="Steps" style={{ gap: 8, flexWrap: 'wrap', listStyle: 'none', padding: 0 }}>
                {WIZARD_STEPS.map((s, i) => <li key={s.id} className="pill" aria-current={i === step ? 'step' : undefined} style={{ opacity: i === step ? 1 : 0.6 }}>{i + 1}. {s.title}</li>)}
            </ol>

            {step === 0 ? (
                <div className="stack">
                    {field('name', 'Project name', <input id="wiz-name" value={draft.name} maxLength={40} onChange={set('name')} />, '3-40 letters, numbers, spaces, - or _.')}
                    {field('botName', 'Bot name', <input id="wiz-botName" value={draft.botName} maxLength={32} onChange={set('botName')} />, 'What members will see. You set the real name in the Discord Developer Portal.')}
                    {field('description', 'Description', <textarea id="wiz-description" rows={3} maxLength={400} value={draft.description} onChange={set('description')} />)}
                    {field('visibility', 'Visibility', (
                        <select id="wiz-visibility" value={draft.visibility} onChange={set('visibility')}>
                            <option value="private">Private (only you)</option>
                            <option value="unlisted">Unlisted</option>
                        </select>
                    ))}
                    <p className="help">Avatar: you upload the bot&apos;s picture in the Discord Developer Portal (Bot → Icon).</p>
                </div>
            ) : null}

            {step === 1 ? (
                <fieldset className="stack" style={{ border: 0, padding: 0 }}>
                    <legend className="label">Framework</legend>
                    {FRAMEWORKS.map((f) => (
                        <label key={f.id} className="card" style={{ cursor: 'pointer' }}>
                            <input type="radio" name="framework" value={f.id} checked={draft.framework === f.id} onChange={set('framework')} />{' '}
                            <strong>{f.label}</strong>
                            <span className="help" style={{ display: 'block' }}>{f.description} · {f.runtime} · {f.library} · Start: {f.start}</span>
                        </label>
                    ))}
                    {errors.framework ? <span className="error" role="alert">{errors.framework}</span> : null}
                </fieldset>
            ) : null}

            {step === 2 ? (
                <fieldset className="stack" style={{ border: 0, padding: 0 }}>
                    <legend className="label">Starter template</legend>
                    {TEMPLATES.map((t) => (
                        <label key={t.id} className="card" style={{ cursor: 'pointer' }}>
                            <input type="radio" name="template" value={t.id} checked={draft.template === t.id} onChange={set('template')} />{' '}
                            <strong>{t.label}</strong>
                            <span className="help" style={{ display: 'block' }}>{t.description}</span>
                        </label>
                    ))}
                    {errors.template ? <span className="error" role="alert">{errors.template}</span> : null}
                </fieldset>
            ) : null}

            {step === 3 ? (
                <div className="stack">
                    <h2 style={{ margin: 0 }}>Connect a Discord application</h2>
                    <ol className="stack">
                        <li>Open the <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal</a> and click <strong>New Application</strong>.</li>
                        <li>Under <strong>Bot</strong>, set the bot&apos;s name and icon.</li>
                        <li>Click <strong>Reset Token</strong> and copy it. Keep it secret: anyone with it controls your bot. You will paste it into Studio&apos;s settings later; it is stored encrypted and never shown again.</li>
                        <li>Turn on only the <strong>Privileged Gateway Intents</strong> your bot needs (Server Members for welcome messages, Message Content only if it reads messages).</li>
                        <li>Slash commands are registered by the generated code when the bot starts.</li>
                        <li>Under <strong>OAuth2 → URL Generator</strong>, tick <code>bot</code> and <code>applications.commands</code>, choose only the permissions your template needs, and open the link to add the bot to your server.</li>
                    </ol>
                    <p className="help">ZiGBoT never asks for your Discord password.</p>
                </div>
            ) : null}

            {step === 4 ? (
                <div className="stack">
                    <h2 style={{ margin: 0 }}>Ready to create</h2>
                    <p><strong>{draft.name}</strong> · {draft.botName} · {framework.label} · {TEMPLATES.find((t) => t.id === draft.template).label} · {draft.visibility}</p>
                    {errors._ ? <p className="error" role="alert">{errors._}</p> : null}
                </div>
            ) : null}

            <div className="row" style={{ gap: 8 }}>
                {step > 0 ? <button className="btn" type="button" onClick={() => setStep(step - 1)} disabled={busy}>Back</button> : null}
                {step < 4 ? <button className="btn btn-primary" type="button" onClick={next}>Next</button> : <button className="btn btn-primary" type="button" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>}
            </div>
        </div>
    );
}
