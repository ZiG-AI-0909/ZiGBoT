'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';

/** Upgrade screen shown when the server answers 402 premium_required. */
export default function PremiumPaywall({ info, onClose }) {
    const closeRef = useRef(null);
    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    if (!info) return null;
    return (
        <div className="paywall-backdrop" onClick={onClose}>
            <div className="paywall" role="dialog" aria-modal="true" aria-labelledby="paywall-title" onClick={(e) => e.stopPropagation()}>
                <div className="paywall-glow" aria-hidden="true" />
                <p className="paywall-kicker">💎 ZiGBoT Premium</p>
                <h2 id="paywall-title">Bring your automation to life</h2>
                <p className="muted">{info.why}</p>
                <h3>Premium unlocks</h3>
                <ul className="paywall-list">{(info.unlocks || []).map((u) => <li key={u}>{u}</li>)}</ul>
                <div className="paywall-plans">
                    {(info.plans || []).map((p) => (
                        <div key={p.id} className={`paywall-plan${p.id === 'yearly' ? ' is-best' : ''}`}>
                            <strong>{p.label}</strong>
                            <span className="paywall-price">{p.price || 'See the Premium tab'}</span>
                        </div>
                    ))}
                </div>
                <p className="help">{info.howToUpgrade}</p>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Link className="btn btn-primary" href={info.upgradePath || '/dashboard'}>Upgrade from a server</Link>
                    <button ref={closeRef} className="btn" type="button" onClick={onClose}>Keep designing for free</button>
                </div>
                <p className="help" style={{ marginTop: 10 }}>Your workflow is saved as a draft either way.</p>
            </div>
        </div>
    );
}
