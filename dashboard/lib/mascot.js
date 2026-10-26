/**
 * The ZiG mascot on the landing page (components/landing/HeroOrb.js): the
 * maths and choices behind its eyes and click reactions, kept free of the
 * DOM so the root test suite can check them. CommonJS like lib/landing.js.
 * Coordinates are SVG user units in the mascot's 400x400 viewBox.
 */

// Centre of the screen-face, and how far the eyes may move inside it.
const FACE_CENTER = Object.freeze({ x: 200, y: 218 });
const EYE_LIMIT = Object.freeze({ x: 13, y: 9 });
// Stiff and lightly damped: the eyes reach the target in a few frames and
// overshoot a touch before settling, so they feel quicker than the cursor.
const SPRING = Object.freeze({ stiffness: 0.42, damping: 0.55 });

function clampToEllipse({ x, y }, limit = EYE_LIMIT) {
    const k = (x / limit.x) ** 2 + (y / limit.y) ** 2;
    if (k <= 1) return { x, y };
    const s = 1 / Math.sqrt(k);
    return { x: x * s, y: y * s };
}

/** Where the eyes should look for a pointer `dx`/`dy` CSS px from the face centre. */
function eyeTarget({ dx, dy }) {
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist < 0.5) return { x: 0, y: 0 };
    const reach = dist / (dist + 120); // close = small glance, far = full look
    return clampToEllipse({ x: (dx / dist) * reach * EYE_LIMIT.x, y: (dy / dist) * reach * EYE_LIMIT.y });
}

/** One animation frame of the eye spring. Never leaves the screen. */
function springStep(state, target, { stiffness, damping } = SPRING) {
    const vx = (state.vx + (target.x - state.x) * stiffness) * damping;
    const vy = (state.vy + (target.y - state.y) * stiffness) * damping;
    const next = clampToEllipse({ x: state.x + vx, y: state.y + vy });
    return { x: next.x, y: next.y, vx, vy };
}

function isSettled(state, target, epsilon = 0.05) {
    return Math.abs(target.x - state.x) < epsilon && Math.abs(target.y - state.y) < epsilon
        && Math.abs(state.vx) < epsilon && Math.abs(state.vy) < epsilon;
}

/** A random glance for touch screens when nobody is touching. */
function idleTarget(rng = Math.random) {
    const angle = rng() * Math.PI * 2;
    const r = 0.25 + rng() * 0.5;
    return { x: Math.cos(angle) * EYE_LIMIT.x * r, y: Math.sin(angle) * EYE_LIMIT.y * r };
}

function nextBlinkDelay(rng = Math.random) {
    return 2500 + Math.floor(rng() * 3500);
}

// Click reactions. `expr` is the face shown; `motion` reactions are only
// movement, so they are skipped when the visitor prefers reduced motion.
const REACTIONS = Object.freeze({
    wink: { expr: 'wink', ms: 1400 },
    bounce: { expr: 'happy', ms: 1200 },
    spin: { expr: 'normal', ms: 700, motion: true },
    heart: { expr: 'heart', ms: 1500 },
    surprised: { expr: 'surprised', ms: 1100 },
    bubble: { expr: 'happy', ms: 2200 },
    dizzy: { expr: 'dizzy', ms: 2000 } // easter egg only
});
const RANDOM_REACTIONS = Object.freeze(['wink', 'bounce', 'spin', 'heart', 'surprised', 'bubble']);
const LINES = Object.freeze(['yo 👋', 'stop poking me 😤', 'ZiG on top 👑', 'that tickles 😭', 'no cap 🧢']);
const DIZZY_POKES = 5;
const DIZZY_WINDOW_MS = 1600;

function pickFrom(list, rng, last) {
    const pool = list.length > 1 ? list.filter((item) => item !== last) : list;
    return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** A random reaction, never the same one twice in a row. */
function pickReaction({ rng = Math.random, reduced = false, last = null } = {}) {
    return pickFrom(RANDOM_REACTIONS.filter((name) => !(reduced && REACTIONS[name].motion)), rng, last);
}

function pickLine({ rng = Math.random, last = null } = {}) {
    return pickFrom(LINES, rng, last);
}

/** Returns poke(now) → true on the 5th poke within the window (then starts over). */
function createPokeCounter({ count = DIZZY_POKES, windowMs = DIZZY_WINDOW_MS } = {}) {
    let times = [];
    return (now) => {
        times = times.filter((t) => now - t < windowMs);
        times.push(now);
        if (times.length >= count) {
            times = [];
            return true;
        }
        return false;
    };
}

/** The neon flame ring behind the mascot: a closed path of flame tongues around (cx, cy). */
function flameRingPath({ cx = 200, cy = 200, r = 168, tongues = 30, height = 22 } = {}) {
    const point = (angle, radius) => `${(cx + Math.cos(angle) * radius).toFixed(1)} ${(cy + Math.sin(angle) * radius).toFixed(1)}`;
    const step = (Math.PI * 2) / tongues;
    let d = `M ${point(0, r)}`;
    for (let i = 0; i < tongues; i += 1) {
        const a = i * step;
        // Deterministic variety (same path on server and client).
        const tall = height * (0.55 + 0.45 * Math.abs(Math.sin(i * 2.399)));
        const lean = step * 0.18 * Math.sin(i * 1.7);
        d += ` Q ${point(a + step * 0.35 + lean, r + tall * 0.6)} ${point(a + step * 0.5 + lean, r + tall)}`;
        d += ` Q ${point(a + step * 0.65 + lean, r + tall * 0.35)} ${point(a + step, r)}`;
    }
    return `${d} Z`;
}

module.exports = {
    FACE_CENTER,
    EYE_LIMIT,
    SPRING,
    clampToEllipse,
    eyeTarget,
    springStep,
    isSettled,
    idleTarget,
    nextBlinkDelay,
    REACTIONS,
    RANDOM_REACTIONS,
    LINES,
    DIZZY_POKES,
    DIZZY_WINDOW_MS,
    pickReaction,
    pickLine,
    createPokeCounter,
    flameRingPath
};
