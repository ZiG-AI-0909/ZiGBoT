const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The landing page (dashboard/app/page.js) renders dashboard/lib/landing.js.
// These tests keep every claim on it tied to the real code: the Premium
// comparison, badges, demo reply formats, retention, commands, and the AI
// providers — and block made-up stats, testimonials, and features that do
// not exist (e.g. XP/levels).
const landing = require('../dashboard/lib/landing');
const { FREE_LIMITS, PREMIUM_ONLY_FEATURES, PREMIUM_PERKS } = require('../dashboard/lib/shared/premium');
const { LIMITS } = require('../dashboard/lib/shared/constants');
const { buildMemoryAnswer } = require('../src/ai/client');
const brain = require('../src/db/brain');
const { buildDefinitions } = require('../src/slash');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Every string the landing data can show.
function allCopy() {
    const out = [];
    const walk = (value) => {
        if (typeof value === 'string') out.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.entries(value).forEach(([key, v]) => { if (key !== 'sources') walk(v); });
    };
    walk({ ...landing, comparison: landing.premiumComparison() });
    return out;
}

test('every feature, step and demo scene names source files that exist', () => {
    for (const item of [...landing.features, ...landing.steps, ...landing.demoScenes]) {
        assert.ok(item.sources.length > 0, `${item.id || item.title} needs a source`);
        for (const file of item.sources) assert.ok(fs.existsSync(path.join(root, file)), `${file} (for ${item.id || item.title}) does not exist`);
    }
});

test('the Free vs Premium comparison is built from premium.js and constants.js', () => {
    const rows = landing.premiumComparison();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.deepEqual([byId.role_mappings.free, byId.role_mappings.premium], [`Up to ${FREE_LIMITS.roleMappings}`, `Up to ${LIMITS.roleMappingsPerGuild}`]);
    for (const feature of PREMIUM_ONLY_FEATURES) {
        const row = rows.find((r) => r.feature === feature);
        assert.ok(row, `Premium-only feature "${feature}" is missing from the comparison`);
        assert.equal(row.free, false);
        assert.equal(row.premium, true);
    }
    const perksShown = new Set(rows.map((r) => r.perk).filter(Boolean));
    for (const perk of PREMIUM_PERKS) assert.ok(perksShown.has(perk.key), `Premium perk "${perk.key}" is missing from the comparison`);
    for (const row of rows.filter((r) => !r.perk)) {
        assert.equal(row.free, true, `${row.label}: rows without a Premium perk must be free`);
        assert.equal(row.premium, true);
    }
    assert.equal(byId.custom_persona.free, false);
});

test('Premium and opt-in badges match the code', () => {
    const premiumCards = landing.features.filter((f) => f.badge === landing.PREMIUM_LABEL);
    assert.deepEqual(premiumCards.map((f) => f.premiumFeature).sort(), [...PREMIUM_ONLY_FEATURES].sort(), 'exactly the Premium-only features are badged Premium');
    assert.ok(landing.features.every((f) => !f.premiumFeature || f.badge === landing.PREMIUM_LABEL));
    const summaries = landing.features.find((f) => f.id === 'summaries');
    assert.equal(summaries.badge, 'Opt-in · when enabled');
    assert.match(summaries.text, /only if the bot has the feature on and you opt in/);
    assert.equal(landing.demoScenes.find((s) => s.id === 'music').badge, landing.PREMIUM_LABEL);
    assert.match(landing.faq.find((f) => f.q === 'Does it work in voice?').a, /Premium/);
});

test('the copy claims no stats, testimonials, rivals, or features the bot lacks', () => {
    const forbidden = [
        /\bXP\b/i, /\blevel(s|ling| up)?\b/i, /\bleaderboards?\b/i, /trusted by/i, /testimonial/i, /\b\d[\d,.]*\s*[kKmM]?\+?\s*(servers|users|members|guilds)\b/i,
        /★|\bstars?\b|\brating\b/i, /\baward/i, /\b(MEE6|Dyno|Carl-?bot|Arcane|ProBot|Dank Memer|Tatsu)\b/i
    ];
    for (const text of allCopy()) {
        for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `landing copy "${text.slice(0, 60)}…" matches ${pattern}`);
    }
});

test('demo replies quote the bot\'s real output formats', () => {
    const memory = landing.demoScenes.find((s) => s.id === 'memory');
    assert.equal(memory.lines[1].text, buildMemoryAnswer({ capabilities: { persistentMemory: true }, count: 3 }), 'the public memory answer is the real count-only text');
    assert.ok(memory.lines[3].ephemeral, '/memory view is shown as private');
    const music = landing.demoScenes.find((s) => s.id === 'music');
    const panel = read('src/music/panel.js');
    assert.ok(panel.includes('**Now playing:**'));
    for (const label of ['Pause', 'Skip', 'Stop', 'Loop: Off']) assert.ok(panel.includes(`'${label}'`), `music panel has a "${label}" button`);
    assert.ok(music.lines[1].buttons.every((b) => ['Pause', 'Skip', 'Stop', 'Loop: Off'].some((label) => b.endsWith(label))));
    const moderation = landing.demoScenes.find((s) => s.id === 'moderation');
    assert.ok(read('src/security/confirmation.js').includes('This action is destructive'));
    assert.ok(read('src/security/confirmation.js').includes('Only the requesting owner or an authorized admin can confirm it.'));
    assert.match(moderation.lines[1].text, /^⚠️ This action is destructive: \*\*warn_member\*\*/);
    assert.ok(read('src/tools/router.js').includes('They now have ${warningCount} warning(s).'));
    assert.match(moderation.lines[2].text, /^⚠️ Warned \S+ \(warning #\d+\): .+\. They now have \d+ warning\(s\)\.$/);
});

test('commands, retention and AI providers named in the copy are real', () => {
    const definitions = buildDefinitions();
    const memorySubs = new Set(definitions.find((d) => d.name === 'memory').options.map((o) => o.name));
    const copy = allCopy().join('\n');
    for (const [, sub] of copy.matchAll(/\/memory (\w+)/g)) assert.ok(memorySubs.has(sub), `/memory ${sub} does not exist`);
    for (const [, name] of copy.matchAll(/(?:^|\s)\/(setup|commands|summarychannels)\b/g)) {
        if (name !== 'commands') assert.ok(definitions.some((d) => d.name === name), `/${name} does not exist`);
    }
    assert.equal(brain.MEMORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
    assert.match(copy, /30 days/);
    const ai = landing.faq.find((f) => f.q === 'Which AI does it use?').a;
    const privacy = read('dashboard/app/privacy/page.js');
    for (const provider of ['Groq', 'NVIDIA']) {
        assert.ok(ai.includes(provider));
        assert.ok(privacy.includes(provider), `privacy page also names ${provider}`);
    }
    // "Never asks for Administrator": the invite permission bits exclude it (bit 3).
    const discord = read('dashboard/lib/discord.js');
    const bits = discord.match(/INVITE_PERMISSIONS = \[([^\]]+)\]/)[1].split(',').map((b) => b.trim().replace('n', ''));
    assert.ok(!bits.includes('3'), 'invite never requests Administrator');
});

test('the landing page renders this data, shows to everyone, and links the real flows', () => {
    const page = read('dashboard/app/page.js');
    assert.match(page, /from '@\/lib\/landing'/);
    assert.match(page, /landing\.premiumComparison\(\)/);
    assert.match(page, /inviteUrl\(\)/, 'Add to Discord uses the real invite link');
    assert.doesNotMatch(page, /redirect\(/, 'signed-in visitors see the landing too');
    assert.match(page, /href="\/commands"/);
    assert.match(page, /'\/dashboard' : '\/auth\/login'/, 'Get Premium goes to the existing dashboard flow');
    assert.match(page, /Demo — sample conversation|ChatDemo/);
    assert.match(read('dashboard/components/landing/ChatDemo.js'), /Demo — sample conversation/);
    const css = read('dashboard/app/landing.css');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.doesNotMatch(css, /^\.btn\s*\{/m, 'landing styles never restyle buttons on other pages');
});
