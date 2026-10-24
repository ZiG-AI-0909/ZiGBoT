const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The dashboard's /commands page reads dashboard/data/commands.json, which is
// generated from the real slash definitions. These tests fail whenever that
// JSON drifts from src/slash.js, or when a "Talk to ZiGBoT" example would not
// actually be handled the way the page says.
const { buildCatalog, TALK, OUTPUT } = require('../scripts/export-commands');
const { buildDefinitions, YOUTUBE_COMMANDS } = require('../src/slash');
const { isMemoryQuestion, isReputationQuestion, isCreatorQuestion, isCrisisMessage } = require('../src/ai/client');
const { actionCatalog, adminActions, destructiveActions } = require('../src/tools/router');

const committed = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
const allCommands = (catalog) => catalog.categories.flatMap((category) => category.commands);

test('dashboard/data/commands.json is in sync with src/slash.js (run `npm run export-commands` if this fails)', () => {
    assert.deepEqual(committed, buildCatalog());
});

test('every public slash command is listed once; owner-only YouTube commands never are', () => {
    const listed = allCommands(committed).map((command) => command.name);
    const expected = buildDefinitions().map((d) => d.name).filter((name) => !YOUTUBE_COMMANDS.has(name));
    assert.deepEqual([...listed].sort(), [...expected].sort());
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    for (const name of YOUTUBE_COMMANDS) assert.ok(!listed.includes(name), `${name} must not be listed`);
    assert.deepEqual(committed.categories.map((c) => c.name), ['Memory', 'Music & voice', 'Moderation', 'Server setup', 'Help']);
});

test('admin-only marking matches Discord default permissions, plus /memory diagnostics', () => {
    const definitions = new Map(buildDefinitions().map((d) => [d.name, d]));
    for (const command of allCommands(committed)) {
        const restricted = definitions.get(command.name).default_member_permissions != null;
        assert.equal(command.audience, restricted ? 'admin' : 'everyone', command.name);
        assert.equal(Boolean(command.permission), restricted, command.name);
    }
    const byName = Object.fromEntries(allCommands(committed).map((c) => [c.name, c]));
    assert.equal(byName.summarychannels.permission, 'Manage Server');
    assert.equal(byName.setup.permission, 'Manage Server');
    assert.equal(byName.kick.permission, 'Kick Members');
    assert.equal(byName.ban.permission, 'Ban Members');
    assert.equal(byName.reputation.permission, 'Administrator');
    const diagnostics = byName.memory.subcommands.find((s) => s.name === 'diagnostics');
    assert.equal(diagnostics.audience, 'admin');
    assert.match(diagnostics.note, /refused unless you are the server owner or an admin/);
    assert.ok(byName.memory.subcommands.filter((s) => s.name !== 'diagnostics').every((s) => s.audience === 'everyone'));
});

test('examples use the real command shape and include every required option', () => {
    const byName = Object.fromEntries(allCommands(committed).map((c) => [c.name, c]));
    assert.equal(byName.memory.subcommands.find((s) => s.name === 'remember').example, '/memory remember text:my favourite game is chess');
    for (const command of allCommands(committed)) {
        const entries = command.subcommands
            ? command.subcommands.map((sub) => ({ prefix: `/${command.name} ${sub.name}`, ...sub }))
            : [{ prefix: `/${command.name}`, ...command }];
        for (const entry of entries) {
            assert.ok(entry.example === entry.prefix || entry.example.startsWith(`${entry.prefix} `), entry.example);
            for (const option of entry.options.filter((o) => o.required)) {
                assert.ok(entry.example.includes(` ${option.name}:`), `${entry.prefix} example lacks required ${option.name}`);
            }
        }
    }
});

test('/memory and /summarychannels carry a plain explanation and a privacy link', () => {
    const byName = Object.fromEntries(allCommands(committed).map((c) => [c.name, c]));
    for (const name of ['memory', 'summarychannels']) {
        assert.ok(byName[name].about && byName[name].about.length > 40, name);
        assert.equal(byName[name].privacyLink, true, name);
    }
});

test('the catalog exposes nothing secret: known fields only, no IDs, URLs, or credential names', () => {
    const allowed = {
        root: ['categories', 'generatedBy', 'talk'],
        category: ['commands', 'id', 'name'],
        command: ['about', 'audience', 'description', 'example', 'name', 'options', 'permission', 'privacyLink', 'subcommands'],
        sub: ['audience', 'description', 'example', 'name', 'note', 'options'],
        option: ['choices', 'description', 'max', 'maxLength', 'min', 'name', 'required', 'type'],
        talk: ['message', 'what']
    };
    const check = (object, kind) => Object.keys(object).forEach((key) => assert.ok(allowed[kind].includes(key), `${kind}.${key} is not an allowed field`));
    check(committed, 'root');
    committed.talk.forEach((t) => check(t, 'talk'));
    for (const category of committed.categories) {
        check(category, 'category');
        for (const command of category.commands) {
            check(command, 'command');
            (command.options || []).forEach((o) => check(o, 'option'));
            for (const sub of command.subcommands || []) {
                check(sub, 'sub');
                sub.options.forEach((o) => check(o, 'option'));
            }
        }
    }
    const raw = JSON.stringify(committed);
    assert.doesNotMatch(raw, /\d{15,}/, 'no Discord IDs');
    assert.doesNotMatch(raw, /https?:\/\//, 'no URLs');
    assert.doesNotMatch(raw, /[A-Z]+_(KEY|TOKEN|SECRET|URI|ID)\b/, 'no environment variable names');
});

test('"Talk to ZiGBoT" examples are handled by the code path the page describes', () => {
    assert.ok(TALK.length >= 4 && TALK.length <= 6);
    assert.deepEqual(committed.talk, TALK.map(({ message, what }) => ({ message, what })));
    for (const example of TALK) {
        assert.match(example.message, /^@ZiGBoT /, 'examples are mentions');
        const text = example.message.replace(/^@ZiGBoT /, '');
        const memory = isMemoryQuestion(text);
        const reputation = isReputationQuestion(text);
        const creator = isCreatorQuestion(text);
        assert.equal(isCrisisMessage(text), false, `${text}: never a crisis example`);
        if (example.kind === 'memory-question') {
            assert.ok(memory, text);
        } else if (example.kind === 'reputation-question') {
            assert.ok(reputation && !memory, `${text}: must reach the reputation handler (memory is checked first)`);
        } else if (example.kind === 'creator-question') {
            assert.ok(creator && !memory && !reputation, text);
        } else if (example.kind === 'chat') {
            assert.ok(!memory && !reputation && !creator, `${text}: must reach the normal chat reply`);
        } else if (example.kind === 'action') {
            assert.ok(actionCatalog.has(example.action), `${example.action} is a real router action`);
            assert.ok(!adminActions.has(example.action) && !destructiveActions.has(example.action), `${example.action} must be usable by members`);
            assert.ok(!memory && !reputation && !creator, `${text}: must reach the intent classifier`);
        } else {
            assert.fail(`unknown kind ${example.kind}`);
        }
    }
});

test('the dashboard page uses the generated data and is linked from the navigation', () => {
    const dashboard = path.join(__dirname, '..', 'dashboard');
    const read = (file) => fs.readFileSync(path.join(dashboard, file), 'utf8');
    assert.match(read('app/commands/page.js'), /from '@\/data\/commands\.json'/);
    assert.match(read('components/TopBar.js'), /href="\/commands"/);
    assert.match(read('components/SiteFooter.js'), /href="\/commands"/);
    assert.match(read('components/CommandsBrowser.js'), /href="\/privacy"/);
});
