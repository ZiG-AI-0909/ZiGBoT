'use client';

import { useEffect, useRef, useState } from 'react';

// "Demo — sample conversation": types out the scenes from lib/landing.js.
// Pauses while off-screen or in a background tab. With reduced motion every
// scene shows complete and nothing auto-advances; the tabs still switch.
// The window has a fixed height, so typing never shifts the page.

const TYPE_MS = 28;
const TYPE_MAX_MS = 1400;
const BOT_THINK_MS = 900;
const LINE_GAP_MS = 500;
const SCENE_PAUSE_MS = 3200;

// **bold** and `code` only, rendered as elements (no HTML injection).
function Rich({ text }) {
    const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
        return <span key={i}>{part}</span>;
    });
}

function Line({ line, typed }) {
    const isBot = line.from === 'bot';
    const text = typed ?? line.text;
    return (
        <div className={`demo-line ${isBot ? 'demo-bot' : 'demo-user'}`}>
            {isBot
                ? <img className="demo-avatar" src="/zigbot.png" alt="" width="36" height="36" />
                : <span className="demo-avatar demo-avatar-user" aria-hidden="true">{line.name[0].toUpperCase()}</span>}
            <div className="demo-body">
                <div className="demo-name">
                    {isBot ? <>ZiGBoT <span className="demo-app">APP</span></> : line.name}
                </div>
                <div className={line.ephemeral ? 'demo-ephemeral' : ''}>
                    <div className="demo-text"><Rich text={text} /></div>
                    {typed === undefined && line.items ? (
                        <ul className="demo-items">{line.items.map((item) => <li key={item}><Rich text={item} /></li>)}</ul>
                    ) : null}
                    {typed === undefined && line.buttons ? (
                        <div className="demo-buttons">{line.buttons.map((b) => <span key={b} className="demo-button">{b}</span>)}</div>
                    ) : null}
                    {line.ephemeral ? <div className="demo-only-you">👁 Only you can see this</div> : null}
                </div>
            </div>
        </div>
    );
}

export default function ChatDemo({ scenes }) {
    const [sceneIndex, setSceneIndex] = useState(0);
    // The first scene starts complete: the server HTML (and no-JS visitors)
    // get a full conversation; typing begins with the next scene.
    const [shown, setShown] = useState(scenes[0].lines.length); // fully shown lines
    const [typing, setTyping] = useState(null); // { chars } for a user line being typed, or { thinking: true }
    const [active, setActive] = useState(false);
    const [reduced, setReduced] = useState(false);
    const windowRef = useRef(null);
    const scene = scenes[sceneIndex];

    useEffect(() => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReduced(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    // Run only while the demo is on screen and the tab is visible.
    useEffect(() => {
        const element = windowRef.current;
        if (!element) return undefined;
        let onScreen = false;
        const sync = () => setActive(onScreen && document.visibilityState === 'visible');
        const observer = new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            sync();
        }, { threshold: 0.25 });
        observer.observe(element);
        document.addEventListener('visibilitychange', sync);
        return () => {
            observer.disconnect();
            document.removeEventListener('visibilitychange', sync);
        };
    }, []);

    // The typing timeline.
    useEffect(() => {
        if (reduced) {
            setShown(scene.lines.length);
            setTyping(null);
            return undefined;
        }
        if (!active) return undefined;
        let timer;
        if (shown >= scene.lines.length) {
            timer = setTimeout(() => {
                setSceneIndex((i) => (i + 1) % scenes.length);
                setShown(0);
                setTyping(null);
            }, SCENE_PAUSE_MS);
            return () => clearTimeout(timer);
        }
        const next = scene.lines[shown];
        if (next.from === 'bot') {
            if (!typing) {
                timer = setTimeout(() => setTyping({ thinking: true }), LINE_GAP_MS);
            } else {
                timer = setTimeout(() => {
                    setTyping(null);
                    setShown((n) => n + 1);
                }, BOT_THINK_MS);
            }
        } else {
            const step = Math.max(8, Math.min(TYPE_MS, TYPE_MAX_MS / next.text.length));
            const chars = typing?.chars ?? 0;
            if (chars < next.text.length) {
                timer = setTimeout(() => setTyping({ chars: chars + 1 }), chars === 0 ? LINE_GAP_MS : step);
            } else {
                timer = setTimeout(() => {
                    setTyping(null);
                    setShown((n) => n + 1);
                }, 250);
            }
        }
        return () => clearTimeout(timer);
    }, [active, reduced, scene, scenes.length, shown, typing]);

    // Keep the newest line in view inside the fixed-height window.
    useEffect(() => {
        const element = windowRef.current;
        if (element) element.scrollTop = element.scrollHeight;
    }, [shown, typing, sceneIndex]);

    const pick = (index) => {
        setSceneIndex(index);
        setShown(reduced ? scenes[index].lines.length : 0);
        setTyping(null);
    };

    const pending = scene.lines[shown];
    return (
        <div className="demo">
            <div className="demo-tabs" role="tablist" aria-label="Demo scenes">
                {scenes.map((s, i) => (
                    <button key={s.id} type="button" role="tab" aria-selected={i === sceneIndex} className="demo-tab" onClick={() => pick(i)}>
                        {s.label}{s.badge ? <span className="demo-tab-badge">{s.badge}</span> : null}
                    </button>
                ))}
            </div>
            <div className="demo-frame">
                <div className="demo-topbar"><span className="demo-hash">#</span> general <span className="demo-flag">Demo — sample conversation</span></div>
                <div className="demo-window" ref={windowRef} aria-label={`Demo conversation: ${scene.label}`}>
                    {scene.lines.slice(0, shown).map((line, i) => <Line key={`${scene.id}-${i}`} line={line} />)}
                    {pending && typing?.chars !== undefined ? <Line line={pending} typed={pending.text.slice(0, typing.chars)} /> : null}
                    {pending && typing?.thinking ? <div className="demo-thinking">ZiGBoT is typing<span className="demo-dots"><i /><i /><i /></span></div> : null}
                </div>
            </div>
            <p className="small muted demo-caption">{scene.caption}</p>
        </div>
    );
}
