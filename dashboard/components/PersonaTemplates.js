'use client';

import { useEffect, useRef, useState } from 'react';
import personaTemplates from '@/lib/shared/personaTemplates';

const { PERSONA_TEMPLATES, applyPersonaTemplate, personaTemplateWouldReplace } = personaTemplates;

// Ready-made custom personas (lib/shared/personaTemplates.js). Clicking a card
// fills the persona text, response style, default tone and GIF style; the
// admin can edit everything before saving. Typed text is only replaced after
// a confirmation. Free servers see the cards locked (Premium).
export default function PersonaTemplates({ draft, updateDraft, premium }) {
    const [pending, setPending] = useState(null); // template waiting for "replace?" confirmation
    const [applied, setApplied] = useState(null);
    const confirmRef = useRef(null);

    useEffect(() => {
        if (pending) confirmRef.current?.focus();
    }, [pending]);

    function apply(template) {
        updateDraft((current) => applyPersonaTemplate(current, template.id));
        setPending(null);
        setApplied(template);
    }

    function choose(template) {
        if (!premium) return;
        setApplied(null);
        if (personaTemplateWouldReplace(draft, template.id)) setPending(template);
        else apply(template);
    }

    return (
        <div className="stack persona-templates">
            <div>
                <h3 style={{ margin: 0 }}>Start from a template</h3>
                <p className="help" style={{ margin: 0 }}>Pick one to fill in the personality below, then change anything you like. Nothing is saved until you press Save.</p>
            </div>
            <div className="template-grid">
                {PERSONA_TEMPLATES.map((template, i) => (
                    <button
                        key={template.id}
                        type="button"
                        className="template-card"
                        style={{ '--i': i }}
                        disabled={!premium}
                        aria-describedby={`template-${template.id}-desc`}
                        onClick={() => choose(template)}
                    >
                        <span className="template-head">
                            <span className="template-emoji" aria-hidden="true">{template.emoji}</span>
                            <strong>{template.name}</strong>
                            {premium ? null : <span className="template-lock" aria-label="Premium only">🔒</span>}
                        </span>
                        <span className="help" id={`template-${template.id}-desc`}>{template.description}</span>
                        <span className="template-sample">“{template.sample}”</span>
                    </button>
                ))}
            </div>
            {pending ? (
                <div className="notice template-confirm" role="alertdialog" aria-labelledby="template-confirm-text" onKeyDown={(e) => { if (e.key === 'Escape') setPending(null); }}>
                    <span id="template-confirm-text">Replace the personality text you’ve already written with “{pending.name}”?</span>
                    <div className="row">
                        <button ref={confirmRef} type="button" className="btn btn-primary" onClick={() => apply(pending)}>Replace</button>
                        <button type="button" className="btn" onClick={() => setPending(null)}>Keep my text</button>
                    </div>
                </div>
            ) : null}
            {applied ? <p className="small" role="status" style={{ margin: 0 }}>{applied.emoji} Filled in from “{applied.name}”. Edit anything you like, then save.</p> : null}
        </div>
    );
}
