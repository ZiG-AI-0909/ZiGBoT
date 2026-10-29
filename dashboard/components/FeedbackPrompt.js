'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import feedback from '@/lib/shared/feedback';

// First-purchase Premium feedback. Appears for the buyer after their first
// verified purchase (right after checkout, or on their next dashboard visit),
// never blocks anything, and never shows again once submitted. Closing keeps
// it pending; "Remind Me Later" hides it for a day. The plan shown and the
// plan-specific questions come from the verified purchase on the server.

const { FEEDBACK_OPTIONS: O, FEEDBACK_RATING_LABELS, FEEDBACK_EASE_LABELS, FEEDBACK_TEXT_MAX } = feedback;
const STEPS = ['Your experience', 'What you bought it for', 'Last few things'];

async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status}).`);
        error.data = data;
        throw error;
    }
    return data;
}

function Choice({ name, legend, options, value, onChange, error, multiple = false, required = false }) {
    const selected = multiple ? value || [] : value;
    return (
        <fieldset className="fb-group" aria-invalid={error ? 'true' : undefined}>
            <legend className="label">{legend}{required ? <span aria-hidden="true"> *</span> : <span className="help"> (optional{multiple ? ', pick any' : ''})</span>}</legend>
            <div className="fb-options">
                {options.map(([key, label]) => {
                    const checked = multiple ? selected.includes(key) : selected === key;
                    return (
                        <label key={key} className={`fb-option ${checked ? 'is-on' : ''}`}>
                            <input
                                type={multiple ? 'checkbox' : 'radio'}
                                name={name}
                                value={key}
                                checked={checked}
                                onChange={() => onChange(multiple ? (checked ? selected.filter((k) => k !== key) : [...selected, key]) : key)}
                            />
                            <span>{label}</span>
                        </label>
                    );
                })}
            </div>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </fieldset>
    );
}

function Scale({ name, legend, min, max, labels, value, onChange, error, ends }) {
    const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    return (
        <fieldset className="fb-group" aria-invalid={error ? 'true' : undefined}>
            <legend className="label">{legend}<span aria-hidden="true"> *</span></legend>
            <div className="fb-scale" role="radiogroup" aria-label={legend}>
                {values.map((n) => (
                    <label key={n} className={`fb-step ${value === n ? 'is-on' : ''}`} title={labels ? labels[n - min] : undefined}>
                        <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} />
                        <span aria-hidden="true">{name === 'overall_rating' ? (value >= n ? '★' : '☆') : n}</span>
                        <span className="sr-only">{labels ? `${n} — ${labels[n - min]}` : String(n)}</span>
                    </label>
                ))}
            </div>
            <div className="spread help"><span>{ends[0]}</span><span>{value !== null && labels ? labels[value - min] : ''}</span><span>{ends[1]}</span></div>
            {error ? <span className="error" role="alert">{error}</span> : null}
        </fieldset>
    );
}

function TextArea({ id, label, value, onChange, placeholder, error }) {
    return (
        <label className="field" htmlFor={id}>
            <span className="label">{label} <span className="help">(optional)</span></span>
            <textarea id={id} rows={3} maxLength={FEEDBACK_TEXT_MAX} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? 'true' : undefined} />
            {error ? <span className="error" role="alert">{error}</span> : null}
        </label>
    );
}

const EMPTY = {
    overall_rating: null, activation_ease: null, value_for_money: null,
    purchase_reasons: [], valuable_features: [],
    meets_expectations: null, more_useful: '',
    justifies_price: null, needs_onboarding: null, advanced_capabilities: [], meets_requirements: null,
    missing_features: '', issues: [], issue_details: '', recommend_score: null, comments: ''
};

// Which answers each step must have before "Next" (the server checks them all again).
function stepErrors(step, a, yearly) {
    const e = {};
    if (step === 0) {
        if (!a.overall_rating) e.overall_rating = 'Pick a star rating.';
        if (!a.activation_ease) e.activation_ease = 'Pick how easy it was.';
        if (!a.value_for_money) e.value_for_money = 'Pick an answer.';
    }
    if (step === 1) {
        if (yearly) {
            if (!a.justifies_price) e.justifies_price = 'Pick an answer.';
            if (!a.needs_onboarding) e.needs_onboarding = 'Pick an answer.';
            if (!a.meets_requirements) e.meets_requirements = 'Pick an answer.';
        } else if (!a.meets_expectations) {
            e.meets_expectations = 'Pick an answer.';
        }
    }
    if (step === 2 && a.recommend_score === null) e.recommend_score = 'Pick a number from 0 to 10.';
    return e;
}

export default function FeedbackPrompt() {
    const [pending, setPending] = useState(null);
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(0);
    const [answers, setAnswers] = useState(EMPTY);
    const [errors, setErrors] = useState({});
    const [status, setStatus] = useState('idle'); // idle | sending | done | error
    const [message, setMessage] = useState('');
    const dialogRef = useRef(null);

    const check = useCallback(async () => {
        try {
            const data = await request('/api/feedback');
            setPending(data.pending);
            if (data.pending && !data.pending.snoozedUntil) setOpen(true);
        } catch {
            setPending(null); // signed out or unavailable: never get in the way
        }
    }, []);

    useEffect(() => {
        check();
        // Right after a verified checkout (dispatched by the Premium tab).
        const onVerified = () => check();
        window.addEventListener('zigbot:premium-verified', onVerified);
        return () => window.removeEventListener('zigbot:premium-verified', onVerified);
    }, [check]);

    useEffect(() => {
        if (!open) return undefined;
        dialogRef.current?.querySelector('input, button, textarea')?.focus();
        const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, step]);

    if (!pending) return null;
    const yearly = pending.planPeriod === 'yearly';
    const set = (key) => (value) => setAnswers((a) => ({ ...a, [key]: value }));
    // "No issues so far" and real issues exclude each other: picking one clears the other.
    const setIssues = (next) => {
        const added = next.find((key) => !answers.issues.includes(key));
        set('issues')(added === 'none' ? ['none'] : next.filter((key) => key !== 'none'));
    };

    if (!open) {
        return status === 'done' ? null : (
            <div className="fb-banner" role="region" aria-label="Premium feedback">
                <span>💜 Thanks for getting <strong>{pending.planLabel}</strong>! Got 1–2 minutes to tell us how it&apos;s going?</span>
                <button className="btn btn-primary" type="button" onClick={() => setOpen(true)}>Give feedback</button>
            </div>
        );
    }

    function next() {
        const e = stepErrors(step, answers, yearly);
        setErrors(e);
        if (Object.keys(e).length === 0) setStep((s) => s + 1);
    }

    async function submit(event) {
        event.preventDefault();
        const e = stepErrors(2, answers, yearly);
        setErrors(e);
        if (Object.keys(e).length || status === 'sending') return;
        setStatus('sending');
        try {
            await request('/api/feedback', { method: 'POST', body: { purchaseId: pending.purchaseId, answers } });
            setStatus('done');
        } catch (error) {
            setErrors(error.data?.fieldErrors || {});
            setMessage(error.message);
            setStatus('error');
            const fields = Object.keys(error.data?.fieldErrors || {});
            if (fields.some((f) => ['overall_rating', 'activation_ease', 'value_for_money'].includes(f))) setStep(0);
            else if (fields.some((f) => ['justifies_price', 'needs_onboarding', 'meets_requirements', 'meets_expectations'].includes(f))) setStep(1);
        }
    }

    async function later() {
        try {
            const data = await request('/api/feedback/remind', { method: 'POST', body: { purchaseId: pending.purchaseId } });
            setPending({ ...pending, snoozedUntil: data.snoozedUntil });
        } catch {
            // Still close it; it stays pending either way.
        }
        setOpen(false);
    }

    return (
        <div className="fb-backdrop">
            <div className="fb-dialog card" role="dialog" aria-modal="true" aria-labelledby="fb-title" ref={dialogRef}>
                {status === 'done' ? (
                    <div className="stack" style={{ textAlign: 'center' }}>
                        <h2 id="fb-title" style={{ margin: 0 }}>Thank you! 💜</h2>
                        <p className="muted" style={{ margin: 0 }}>Thank you for being part of ZiGBoT! 💜 Your feedback helps us build a better experience for every community.</p>
                        <div className="row" style={{ justifyContent: 'center' }}>
                            <button className="btn btn-primary" type="button" onClick={() => { setOpen(false); setPending(null); }}>Close</button>
                        </div>
                    </div>
                ) : (
                    <form className="stack" onSubmit={submit} noValidate>
                        <div className="spread">
                            <div>
                                <h2 id="fb-title" style={{ margin: 0 }}>Help Us Make ZiGBoT Better 💜</h2>
                                <p className="help" style={{ margin: 0 }}>Thanks for supporting ZiGBoT! Tell us about your premium experience. Your feedback helps us improve the bot for everyone.</p>
                            </div>
                            <span className="pill pill-premium">{pending.planLabel}</span>
                        </div>
                        <div className="fb-progress" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-valuetext={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
                            <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
                        </div>
                        <p className="help" style={{ margin: 0 }}>Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>

                        {step === 0 ? (
                            <>
                                <Scale name="overall_rating" legend="How would you rate your experience with ZiGBoT so far?" min={1} max={5} labels={FEEDBACK_RATING_LABELS} value={answers.overall_rating} onChange={set('overall_rating')} error={errors.overall_rating} ends={['Very Poor', 'Excellent']} />
                                <Scale name="activation_ease" legend="How easy was it to purchase and activate Premium?" min={1} max={5} labels={FEEDBACK_EASE_LABELS} value={answers.activation_ease} onChange={set('activation_ease')} error={errors.activation_ease} ends={['Very Difficult', 'Very Easy']} />
                                <Choice name="value_for_money" legend="How do you feel about the value of your selected plan?" options={O.value_for_money} value={answers.value_for_money} onChange={set('value_for_money')} error={errors.value_for_money} required />
                            </>
                        ) : null}
                        {step === 1 ? (
                            <>
                                <Choice name="purchase_reasons" legend="What made you decide to purchase ZiGBoT Premium?" options={O.purchase_reasons} value={answers.purchase_reasons} onChange={set('purchase_reasons')} error={errors.purchase_reasons} multiple />
                                <Choice name="valuable_features" legend="Which features are you most excited to use?" options={O.valuable_features} value={answers.valuable_features} onChange={set('valuable_features')} error={errors.valuable_features} multiple />
                                {yearly ? (
                                    <>
                                        <Choice name="justifies_price" legend="Do the yearly plan's benefits justify its price for you?" options={O.justifies_price} value={answers.justifies_price} onChange={set('justifies_price')} error={errors.justifies_price} required />
                                        <Choice name="advanced_capabilities" legend="Which Premium capabilities matter most to your server?" options={O.advanced_capabilities} value={answers.advanced_capabilities} onChange={set('advanced_capabilities')} error={errors.advanced_capabilities} multiple />
                                        <Choice name="meets_requirements" legend="Does the plan meet your server's requirements?" options={O.meets_requirements} value={answers.meets_requirements} onChange={set('meets_requirements')} error={errors.meets_requirements} required />
                                        <Choice name="needs_onboarding" legend="Would you like help with setup or onboarding?" options={O.needs_onboarding} value={answers.needs_onboarding} onChange={set('needs_onboarding')} error={errors.needs_onboarding} required />
                                    </>
                                ) : (
                                    <>
                                        <Choice name="meets_expectations" legend="Do the Premium features meet your expectations?" options={O.meets_expectations} value={answers.meets_expectations} onChange={set('meets_expectations')} error={errors.meets_expectations} required />
                                        <TextArea id="fb-more-useful" label="What would make the plan more useful for you?" value={answers.more_useful} onChange={set('more_useful')} error={errors.more_useful} placeholder="More of…, less of…, I wish it could…" />
                                    </>
                                )}
                            </>
                        ) : null}
                        {step === 2 ? (
                            <>
                                <TextArea id="fb-missing" label="Is there any feature you expected but couldn't find?" value={answers.missing_features} onChange={set('missing_features')} error={errors.missing_features} placeholder="Tell us what you'd like to see in ZiGBoT..." />
                                <Choice name="issues" legend="Have you experienced any issues with ZiGBoT Premium?" options={O.issues} value={answers.issues} onChange={setIssues} error={errors.issues} multiple />
                                {answers.issues.some((k) => k !== 'none') ? <TextArea id="fb-issue-details" label="Tell us more about the issue" value={answers.issue_details} onChange={set('issue_details')} error={errors.issue_details} placeholder="What happened, and where?" /> : null}
                                <Scale name="recommend_score" legend="How likely are you to recommend ZiGBoT to a friend or another server owner?" min={0} max={10} value={answers.recommend_score} onChange={set('recommend_score')} error={errors.recommend_score} ends={['0 — Not at all likely', '10 — Extremely likely']} />
                                <TextArea id="fb-comments" label="Anything else you'd like to tell us?" value={answers.comments} onChange={set('comments')} error={errors.comments} />
                            </>
                        ) : null}

                        {status === 'error' && message ? <div className="notice" role="alert">{message}</div> : null}
                        <div className="spread">
                            <button className="btn btn-ghost" type="button" onClick={later} disabled={status === 'sending'}>Remind Me Later</button>
                            <div className="row">
                                {step > 0 ? <button className="btn" type="button" onClick={() => { setErrors({}); setStep((s) => s - 1); }} disabled={status === 'sending'}>Back</button> : null}
                                {step < STEPS.length - 1
                                    ? <button className="btn btn-primary" type="button" onClick={next}>Next</button>
                                    : <button className="btn btn-primary" type="submit" disabled={status === 'sending'}>{status === 'sending' ? 'Sending…' : 'Submit Feedback'}</button>}
                            </div>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
