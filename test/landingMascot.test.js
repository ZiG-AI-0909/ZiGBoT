const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The ZiG mascot in the landing hero: eye maths and reactions
// (dashboard/lib/mascot.js) plus the wiring that keeps it accessible,
// reduced-motion friendly and dependency-free.
const mascot = require('../dashboard/lib/mascot');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const inside = ({ x, y }) => (x / mascot.EYE_LIMIT.x) ** 2 + (y / mascot.EYE_LIMIT.y) ** 2 <= 1 + 1e-9;
const seq = (...values) => {
    let i = 0;
    return () => values[i++ % values.length];
};

test('eyes look toward the pointer and never leave the screen', () => {
    assert.deepEqual(mascot.eyeTarget({ dx: 0, dy: 0 }), { x: 0, y: 0 });
    const right = mascot.eyeTarget({ dx: 900, dy: 0 });
    assert.ok(right.x > mascot.EYE_LIMIT.x * 0.85 && Math.abs(right.y) < 1e-9, 'far right: nearly the full reach');
    const near = mascot.eyeTarget({ dx: 20, dy: 0 });
    assert.ok(near.x > 0 && near.x < right.x / 3, 'a nearby pointer is a small glance');
    const up = mascot.eyeTarget({ dx: 0, dy: -500 });
    assert.ok(up.y < 0);
    for (const [dx, dy] of [[1e6, 1e6], [-3000, 40], [7, -9999], [NaN, 4]]) assert.ok(inside(mascot.eyeTarget({ dx, dy })));
});

test('the eye spring is snappy: overshoots a little, then settles, always inside', () => {
    const target = mascot.eyeTarget({ dx: 2000, dy: 0 });
    let state = { x: 0, y: 0, vx: 0, vy: 0 };
    let peak = 0;
    let frames = 0;
    let reachedAt = null;
    while (!mascot.isSettled(state, target) && frames < 200) {
        state = mascot.springStep(state, target);
        frames += 1;
        assert.ok(inside(state), `frame ${frames} stays inside the screen`);
        peak = Math.max(peak, state.x);
        if (reachedAt === null && state.x >= target.x * 0.95) reachedAt = frames;
    }
    assert.ok(reachedAt <= 5, `reaches 95% of the target within 5 frames (took ${reachedAt})`);
    assert.ok(peak > target.x * 1.02 || peak >= mascot.EYE_LIMIT.x * 0.999, 'a slight overshoot (or pinned at the edge)');
    assert.ok(frames < 40, `settles within 40 frames (took ${frames})`);
    // A mid-screen target can overshoot freely.
    const mid = { x: 4, y: 2 };
    let s = { x: 0, y: 0, vx: 0, vy: 0 };
    let max = 0;
    for (let i = 0; i < 30; i += 1) {
        s = mascot.springStep(s, mid);
        max = Math.max(max, s.x);
    }
    assert.ok(max > mid.x && max < mid.x * 1.25, `overshoot is slight (${(max / mid.x).toFixed(2)}x)`);
    assert.ok(Math.abs(s.x - mid.x) < 0.05);
});

test('idle glances and blink timing stay in range', () => {
    for (const r of [0, 0.25, 0.5, 0.99]) {
        assert.ok(inside(mascot.idleTarget(() => r)));
        const delay = mascot.nextBlinkDelay(() => r);
        assert.ok(delay >= 2500 && delay < 6000);
    }
});

test('reactions: random, never the same twice in a row, no spin with reduced motion', () => {
    assert.deepEqual([...mascot.RANDOM_REACTIONS].sort(), ['bounce', 'bubble', 'heart', 'spin', 'surprised', 'wink']);
    for (const name of mascot.RANDOM_REACTIONS) {
        for (let i = 0; i < 6; i += 1) {
            assert.notEqual(mascot.pickReaction({ rng: () => i / 6, last: name }), name);
        }
    }
    for (let i = 0; i < 20; i += 1) assert.notEqual(mascot.pickReaction({ rng: () => i / 20, reduced: true }), 'spin');
    assert.ok(!mascot.RANDOM_REACTIONS.includes('dizzy'), 'dizzy is the easter egg only');
    for (const [name, r] of Object.entries(mascot.REACTIONS)) assert.ok(r.ms > 0 && r.ms <= 2500 && r.expr, name);
    assert.equal(mascot.REACTIONS.dizzy.ms, 2000, 'dizzy for 2 seconds');
    assert.equal(mascot.REACTIONS.wink.expr, 'wink');
    assert.ok(mascot.LINES.includes('yo 👋') && mascot.LINES.includes('stop poking me 😤') && mascot.LINES.includes('ZiG on top 👑'));
    assert.notEqual(mascot.pickLine({ rng: () => 0, last: mascot.LINES[0] }), mascot.LINES[0]);
});

test('easter egg: 5 fast pokes → dizzy; slow pokes never', () => {
    const fast = mascot.createPokeCounter();
    assert.deepEqual([0, 200, 400, 600, 800].map((t) => fast(t)), [false, false, false, false, true]);
    assert.equal(fast(900), false, 'the count starts over after the easter egg');
    const slow = mascot.createPokeCounter();
    assert.ok([0, 500, 1000, 1500, 2000, 2500, 3000].every((t) => !slow(t)));
});

test('the flame ring path is deterministic and closed', () => {
    const a = mascot.flameRingPath();
    assert.equal(a, mascot.flameRingPath(), 'same on server and client (no hydration mismatch)');
    assert.match(a, /^M [\d. ]+ Q /);
    assert.match(a, / Z$/);
    assert.doesNotMatch(a, /NaN/);
});

test('the hero mascot: SVG parts, a real button, no new dependencies, reduced motion respected', () => {
    const component = read('dashboard/components/landing/HeroOrb.js');
    assert.match(component, /<button type="button" className="zig-poke" aria-label="Poke ZiG" onClick=\{poke\}>/);
    for (const part of ['zig-hood-text', '>ZIG<', 'zig-cup-l', 'zig-cup-r', '>Z<', 'zig-crown', 'zig-screen', 'zig-flames', 'zig-x-wink', 'zig-tongue', 'zig-x-heart', 'zig-x-surprised', 'zig-x-dizzy', 'zig-x-happy']) {
        assert.ok(component.includes(part), `mascot has ${part}`);
    }
    assert.match(component, /clipPath="url\(#zig-screen-clip\)"/, 'eyes are clipped to the screen');
    assert.match(component, /requestAnimationFrame\(tick\)/);
    assert.match(component, /if \(reduced\) \{\s*place\(0, 0\);\s*return undefined;/, 'no eye tracking with reduced motion');
    assert.match(component, /if \(!wrap \|\| reduced\) return undefined;/, 'no blinking with reduced motion');
    assert.doesNotMatch(component, /new Audio|AudioContext|\.play\(\)/, 'no sound');
    const imports = [...component.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['@/lib/mascot', 'react']);

    const css = read('dashboard/app/landing.css');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['.zig-ring', '.zig-flames', '.zig-float', '.zig-body', '.zig-cup', '.zig-spiral', '.orb-chip']) {
        assert.ok(reduced.includes(cls), `${cls} stops under reduced motion`);
    }
    assert.match(css, /\.zig-wrap \{ position: relative; width: min\(100%, 380px\); aspect-ratio: 1;/, 'fixed square: no layout shift');
    assert.match(css, /\.zig-poke:focus-visible \{ outline:/, 'visible focus');
    assert.deepEqual(Object.keys(JSON.parse(read('dashboard/package.json')).dependencies).sort(),
        ['@supabase/ssr', '@supabase/supabase-js', 'next', 'react', 'react-dom', 'server-only', 'sharp']);
});

test('the hero headline keeps a real space between words', () => {
    const page = read('dashboard/app/page.js');
    assert.match(page, /\{i > 0 \? ' ' : null\}\s*<span className="l-word" style=\{\{ '--i': i \}\}>\{word\}<\/span>/);
    assert.doesNotMatch(page, /\{word\} <\/span>/, 'no trailing space inside the inline-block word');
});

test('the "fr fr" sticker no longer rises through the mascot column', () => {
    const background = read('dashboard/components/HomeBackground.js');
    const left = Number(background.match(/text: 'fr fr', left: '(\d+)%'/)[1]);
    assert.ok(left < 40, `fr fr is at ${left}%`);
});
