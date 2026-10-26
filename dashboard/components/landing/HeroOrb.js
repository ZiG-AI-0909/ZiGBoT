'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import mascot from '@/lib/mascot';

// The ZiG mascot (reference: public/zigbot.png) as inline SVG so its parts
// can move: hood with "ZIG", glossy screen face, glowing eyes, "Z"
// headphones, crown, neon flame ring. Styles and keyframes: landing.css (.zig-*).
//  - Eyes follow the pointer anywhere on the page every animation frame
//    (spring with a slight overshoot, lib/mascot.js); touch: they follow the
//    finger, otherwise glance around. Random blinks.
//  - It is a button ("Poke ZiG"): each poke plays one random reaction,
//    replacing any reaction still playing. 5 quick pokes: dizzy.
//  - Reduced motion: no tracking, blinking or movement; pokes only change
//    the expression (or show the speech bubble).
// The animation loop runs only while the eyes are moving.

const { FACE_CENTER, eyeTarget, springStep, isSettled, idleTarget, nextBlinkDelay, REACTIONS, pickReaction, pickLine, createPokeCounter, flameRingPath } = mascot;

const FLAMES_OUTER = flameRingPath({ r: 166, tongues: 30, height: 24 });
const FLAMES_INNER = flameRingPath({ r: 160, tongues: 24, height: 14 });
const heart = (x, y) => `M${x} ${y + 9} C${x - 15} ${y - 2} ${x - 9} ${y - 15} ${x} ${y - 6} C${x + 9} ${y - 15} ${x + 15} ${y - 2} ${x} ${y + 9} Z`;
const spiral = (x, y) => `M${x} ${y} m-2 0 a2 2 0 1 1 4 0 a4 4 0 1 1 -8 0 a6 6 0 1 1 12 0 a8 8 0 1 1 -16 0 a10 10 0 1 1 20 0`;

function MascotSvg({ eyesRef, mouthRef }) {
    return (
        <svg className="zig-svg" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
            <defs>
                <radialGradient id="zig-bg" cx="50%" cy="45%" r="55%">
                    <stop offset="0" stopColor="#1c0736" />
                    <stop offset="1" stopColor="#06000d" />
                </radialGradient>
                <linearGradient id="zig-hood" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#2b2a36" />
                    <stop offset="0.45" stopColor="#121218" />
                    <stop offset="1" stopColor="#07070a" />
                </linearGradient>
                <linearGradient id="zig-screen" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#1d1d27" />
                    <stop offset="1" stopColor="#040406" />
                </linearGradient>
                <filter id="zig-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <clipPath id="zig-circle"><circle cx="200" cy="200" r="150" /></clipPath>
                <clipPath id="zig-screen-clip"><rect x="136" y="170" width="128" height="98" rx="30" /></clipPath>
            </defs>

            {/* Solid backdrop: nothing behind (e.g. the floating stickers) shows through. */}
            <circle cx="200" cy="200" r="198" fill="url(#zig-bg)" />

            <g clipPath="url(#zig-circle)">
                <circle cx="200" cy="200" r="150" fill="#0a0014" />
                {/* Hood and shoulders */}
                <path d="M200 66 C122 72 86 146 88 226 C90 296 72 332 58 400 L342 400 C328 332 310 296 312 226 C314 146 278 72 200 66 Z" fill="url(#zig-hood)" />
                <path d="M200 66 C150 70 116 104 102 150 C126 112 160 92 200 90 C240 92 274 112 298 150 C284 104 250 70 200 66 Z" fill="#ffffff" opacity="0.06" />
                <path d="M200 134 C144 138 118 180 120 228 C122 280 158 304 200 304 C242 304 278 280 280 228 C282 180 256 138 200 134 Z" fill="#020203" />
                <text className="zig-hood-text" x="200" y="124" textAnchor="middle" transform="rotate(-5 200 116)" filter="url(#zig-glow)">ZIG</text>
            </g>

            {/* Headphones */}
            <g className="zig-cup zig-cup-l">
                <rect x="70" y="182" width="46" height="74" rx="21" fill="#140824" stroke="#c084fc" strokeWidth="4" filter="url(#zig-glow)" />
                <text className="zig-cup-text" x="93" y="230" textAnchor="middle">Z</text>
            </g>
            <g className="zig-cup zig-cup-r">
                <rect x="284" y="182" width="46" height="74" rx="21" fill="#140824" stroke="#c084fc" strokeWidth="4" filter="url(#zig-glow)" />
                <text className="zig-cup-text" x="307" y="230" textAnchor="middle">Z</text>
            </g>

            {/* Crown */}
            <path className="zig-crown" d="M262 70 L266 44 L280 60 L292 38 L302 60 L316 48 L314 74 Z" transform="rotate(16 290 58)" filter="url(#zig-glow)" />

            {/* Screen face */}
            <rect x="136" y="170" width="128" height="98" rx="30" fill="url(#zig-screen)" stroke="#2e2e3b" strokeWidth="1.5" />
            <g clipPath="url(#zig-screen-clip)">
                <g ref={eyesRef} className="zig-eyes">
                    <g className="zig-blink" filter="url(#zig-glow)">
                        <g className="zig-x zig-x-normal">
                            <rect x="163" y="198" width="18" height="30" rx="9" />
                            <rect x="219" y="198" width="18" height="30" rx="9" />
                        </g>
                        <g className="zig-x zig-x-wink">
                            <path className="zig-stroke" d="M162 202 L182 213 L162 224" />
                            <rect x="219" y="198" width="18" height="30" rx="9" />
                        </g>
                        <g className="zig-x zig-x-happy">
                            <path className="zig-stroke" d="M161 218 Q172 200 183 218" />
                            <path className="zig-stroke" d="M217 218 Q228 200 239 218" />
                        </g>
                        <g className="zig-x zig-x-heart">
                            <path className="zig-heart" d={heart(172, 212)} />
                            <path className="zig-heart" d={heart(228, 212)} />
                        </g>
                        <g className="zig-x zig-x-surprised">
                            <circle cx="172" cy="212" r="15" />
                            <circle cx="228" cy="212" r="15" />
                            <circle cx="172" cy="212" r="6" fill="#0a0014" />
                            <circle cx="228" cy="212" r="6" fill="#0a0014" />
                        </g>
                        <g className="zig-x zig-x-dizzy">
                            <path className="zig-stroke zig-spiral" d={spiral(172, 212)} />
                            <path className="zig-stroke zig-spiral" d={spiral(228, 212)} />
                        </g>
                    </g>
                </g>
                <g ref={mouthRef} className="zig-mouth" filter="url(#zig-glow)">
                    <path className="zig-x zig-x-normal zig-stroke" d="M188 246 Q200 255 212 246" />
                    <g className="zig-x zig-x-wink">
                        <path className="zig-stroke" d="M186 244 Q200 256 214 244" />
                        <path className="zig-tongue" d="M195 250 Q200 266 207 250 Z" />
                    </g>
                    <path className="zig-x zig-x-happy zig-stroke" d="M182 242 Q200 262 218 242" />
                    <path className="zig-x zig-x-heart zig-stroke" d="M186 245 Q200 258 214 245" />
                    <ellipse className="zig-x zig-x-surprised zig-stroke" cx="200" cy="250" rx="6" ry="8" />
                    <path className="zig-x zig-x-dizzy zig-stroke" d="M182 250 q4.5 -6 9 0 t9 0 t9 0 t9 0" />
                </g>
            </g>
            {/* Screen gloss */}
            <path d="M150 180 C170 174 196 173 214 175 C188 182 166 194 154 212 Z" fill="#ffffff" opacity="0.1" />
        </svg>
    );
}

export default function HeroOrb() {
    const wrapRef = useRef(null);
    const eyesRef = useRef(null);
    const mouthRef = useRef(null);
    const timerRef = useRef(0);
    const lastRef = useRef({ reaction: null, line: null });
    const pokeRef = useRef(null);
    const [reduced, setReduced] = useState(false);
    const [reaction, setReaction] = useState(null); // { name, expr, line }

    useEffect(() => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReduced(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    // Eye tracking: every frame while the eyes are moving.
    useEffect(() => {
        const wrap = wrapRef.current;
        const eyes = eyesRef.current;
        const mouth = mouthRef.current;
        if (!wrap || !eyes || !mouth) return undefined;
        const place = (x, y) => {
            eyes.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
            mouth.setAttribute('transform', `translate(${(x * 0.4).toFixed(2)} ${(y * 0.4).toFixed(2)})`);
        };
        if (reduced) {
            place(0, 0);
            return undefined;
        }
        let state = { x: 0, y: 0, vx: 0, vy: 0 };
        let target = { x: 0, y: 0 };
        let frame = 0;
        let idleTimer = 0;
        let lastInput = 0;
        const tick = () => {
            state = springStep(state, target);
            place(state.x, state.y);
            frame = isSettled(state, target) ? 0 : requestAnimationFrame(tick);
        };
        const wake = () => {
            if (!frame) frame = requestAnimationFrame(tick);
        };
        const aimAt = (clientX, clientY) => {
            const rect = wrap.getBoundingClientRect();
            const scale = rect.width / 400;
            target = eyeTarget({ dx: clientX - (rect.left + FACE_CENTER.x * scale), dy: clientY - (rect.top + FACE_CENTER.y * scale) });
            lastInput = performance.now();
            wake();
        };
        const onPointer = (event) => aimAt(event.clientX, event.clientY);
        const onTouch = (event) => {
            const touch = event.touches[0];
            if (touch) aimAt(touch.clientX, touch.clientY);
        };
        window.addEventListener('pointermove', onPointer, { passive: true });
        window.addEventListener('pointerdown', onPointer, { passive: true });
        window.addEventListener('touchstart', onTouch, { passive: true });
        window.addEventListener('touchmove', onTouch, { passive: true });
        // Touch screens: glance around when no finger has moved for a while.
        const finePointer = window.matchMedia('(pointer: fine)').matches;
        const idle = () => {
            if (!document.hidden && performance.now() - lastInput > 2500) {
                target = idleTarget();
                wake();
            }
            idleTimer = setTimeout(idle, 1600 + Math.random() * 1800);
        };
        if (!finePointer) idleTimer = setTimeout(idle, 1200);
        return () => {
            window.removeEventListener('pointermove', onPointer);
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('touchstart', onTouch);
            window.removeEventListener('touchmove', onTouch);
            cancelAnimationFrame(frame);
            clearTimeout(idleTimer);
        };
    }, [reduced]);

    // Random blinks.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap || reduced) return undefined;
        let timer = 0;
        const blink = () => {
            wrap.classList.add('is-blinking');
            timer = setTimeout(() => {
                wrap.classList.remove('is-blinking');
                timer = setTimeout(blink, nextBlinkDelay());
            }, 140);
        };
        timer = setTimeout(blink, nextBlinkDelay());
        return () => {
            clearTimeout(timer);
            wrap.classList.remove('is-blinking');
        };
    }, [reduced]);

    useEffect(() => () => clearTimeout(timerRef.current), []);

    const play = useCallback((name) => {
        clearTimeout(timerRef.current);
        const line = name === 'bubble' ? pickLine({ last: lastRef.current.line }) : null;
        lastRef.current = { reaction: name, line: line || lastRef.current.line };
        // Clear first so the same reaction twice restarts its animation cleanly.
        setReaction(null);
        requestAnimationFrame(() => {
            setReaction({ name, expr: REACTIONS[name].expr, line });
            timerRef.current = setTimeout(() => setReaction(null), REACTIONS[name].ms);
        });
    }, []);

    const poke = () => {
        if (!pokeRef.current) pokeRef.current = createPokeCounter();
        if (pokeRef.current(performance.now())) play('dizzy');
        else play(pickReaction({ reduced, last: lastRef.current.reaction }));
    };

    return (
        <div className="zig-wrap" ref={wrapRef} data-reaction={reaction?.name || undefined} data-expr={reaction?.expr || 'normal'}>
            <div className="zig-ring" aria-hidden="true" />
            <div className="zig-flames" aria-hidden="true">
                <svg viewBox="0 0 400 400" focusable="false">
                    <path d={FLAMES_OUTER} fill="#7c3aed" opacity="0.55" />
                    <path d={FLAMES_INNER} fill="#e040fb" opacity="0.6" />
                </svg>
            </div>
            <div className="zig-float">
                <button type="button" className="zig-poke" aria-label="Poke ZiG" onClick={poke}>
                    <span className="zig-body">
                        <MascotSvg eyesRef={eyesRef} mouthRef={mouthRef} />
                    </span>
                </button>
            </div>
            <span className={`zig-bubble ${reaction?.line ? 'is-on' : ''}`} role="status" aria-live="polite">{reaction?.line || ''}</span>
            <span className="orb-chip orb-chip-1" aria-hidden="true">💬</span>
            <span className="orb-chip orb-chip-2" aria-hidden="true">🧠</span>
            <span className="orb-chip orb-chip-3" aria-hidden="true">🎵</span>
            <span className="orb-chip orb-chip-4" aria-hidden="true">🛡️</span>
        </div>
    );
}
