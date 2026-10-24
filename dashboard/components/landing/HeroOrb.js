'use client';

import { useEffect, useRef } from 'react';

// The ZiGBoT orb: pure CSS layers (landing.css, .orb-*). On devices with a
// fine pointer it tilts and its eyes follow the cursor; touch screens and
// reduced-motion users get the calm, static version. Decorative only.
export default function HeroOrb() {
    const ref = useRef(null);

    useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
        if (!window.matchMedia('(pointer: fine)').matches) return undefined;
        let frame = 0;
        const onMove = (event) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const rect = element.getBoundingClientRect();
                const x = (event.clientX - (rect.left + rect.width / 2)) / window.innerWidth;
                const y = (event.clientY - (rect.top + rect.height / 2)) / window.innerHeight;
                element.style.setProperty('--tilt-x', `${(y * -12).toFixed(2)}deg`);
                element.style.setProperty('--tilt-y', `${(x * 16).toFixed(2)}deg`);
                element.style.setProperty('--look-x', `${(x * 18).toFixed(1)}px`);
                element.style.setProperty('--look-y', `${(y * 12).toFixed(1)}px`);
            });
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        return () => {
            window.removeEventListener('pointermove', onMove);
            cancelAnimationFrame(frame);
        };
    }, []);

    return (
        <div className="orb-wrap" ref={ref} aria-hidden="true">
            <div className="orb-ring" />
            <div className="orb">
                <div className="orb-face">
                    <span className="orb-eye" />
                    <span className="orb-eye" />
                    <span className="orb-mouth" />
                </div>
            </div>
            <span className="orb-chip orb-chip-1">💬</span>
            <span className="orb-chip orb-chip-2">🧠</span>
            <span className="orb-chip orb-chip-3">🎵</span>
            <span className="orb-chip orb-chip-4">🛡️</span>
        </div>
    );
}
