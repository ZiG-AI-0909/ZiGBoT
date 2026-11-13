'use client';

import { useState } from 'react';
import specs from '@/lib/studio/specializations';

const ICON_PATHS = {
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14',
    flow: 'M6 4a2 2 0 100 4 2 2 0 000-4zM18 16a2 2 0 100 4 2 2 0 000-4zM6 8v4a4 4 0 004 4h6M18 4v6',
    ai: 'M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM5 15l.6 1.4 1.4.6-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z'
};

/**
 * "What do you want your AI to build?" Three large cards (radio group);
 * arrow keys move between them, Enter/Space or the button continues.
 */
export default function SpecializationPicker({ value, onPick }) {
    const [selected, setSelected] = useState(value || null);
    const list = specs.SPECIALIZATIONS;

    function onKey(e, i) {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
        e.preventDefault();
        const next = list[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length];
        setSelected(next.id);
        document.getElementById(`spec-${next.id}`)?.focus();
    }

    return (
        <div className="spec-pick">
            <header className="spec-head">
                <h1>What do you want your AI to build?</h1>
                <p className="muted">Choose your AI specialization and create an intelligent workspace tailored to your needs.</p>
            </header>
            <div className="spec-grid" role="radiogroup" aria-label="AI specialization">
                {list.map((s, i) => {
                    const on = selected === s.id;
                    return (
                        <div key={s.id} id={`spec-${s.id}`} role="radio" aria-checked={on} tabIndex={on || (!selected && i === 0) ? 0 : -1}
                            className={`spec-card${on ? ' is-selected' : ''}`} style={{ '--spec': s.accent, '--i': i }}
                            onClick={() => setSelected(s.id)} onDoubleClick={() => onPick(s.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (on) onPick(s.id); else setSelected(s.id); } else onKey(e, i); }}>
                            <span className="spec-check" aria-hidden="true">✓</span>
                            <span className="spec-icon" aria-hidden="true">
                                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={ICON_PATHS[s.icon]} /></svg>
                            </span>
                            <h2>{s.title}</h2>
                            <p className="muted small">{s.tagline}</p>
                            <div className="spec-tags">{s.technologies.map((t) => <span key={t} className="spec-tag">{t}</span>)}</div>
                            <ul className="spec-features">{s.features.map((f) => <li key={f.label}>{f.label}</li>)}</ul>
                            {s.later.length ? <p className="help spec-later">Coming later: {s.later.join(' · ')}</p> : null}
                        </div>
                    );
                })}
            </div>
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                <button className="btn btn-primary btn-lg" type="button" disabled={!selected} onClick={() => onPick(selected)}>
                    {selected ? `Continue with ${specs.byId(selected).title}` : 'Pick a specialization'}
                </button>
            </div>
        </div>
    );
}
