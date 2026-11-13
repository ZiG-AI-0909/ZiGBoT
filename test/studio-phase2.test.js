// ZiGBoT Studio Phase 2: project generators, file storage rules, zip export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { generateProject, settingsFile, isSafePath, TEMPLATE_PARTS } = require('../dashboard/lib/studio/generators');
const { FRAMEWORKS, TEMPLATES } = require('../dashboard/lib/studio/projects');
const { exportable, fileRows } = require('../dashboard/lib/studio/files');
const { createZip, readZip, crc32 } = require('../dashboard/lib/studio/zip');

const ROOT = path.join(__dirname, '..');
const project = (framework, template) => ({ name: `My ${template} bot`, botName: 'Helper', description: 'Test', framework, template });
const ALL = FRAMEWORKS.flatMap((f) => TEMPLATES.map((t) => [f.id, t.id]));

// Compiles CommonJS source without running it (no require, no side effects).
const compiles = (src, file) => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file });

test('every framework x template generates the required project structure', () => {
    const required = {
        discordjs: ['package.json', 'src/index.js', 'src/config.js', 'src/deploy-commands.js', 'src/settings.json', 'src/events/ready.js', 'src/events/interactionCreate.js', 'test/commands.test.js'],
        'discordjs-ts': ['package.json', 'tsconfig.json', 'src/index.ts', 'src/config.ts', 'src/settings.ts', 'src/settings.json', 'src/deploy-commands.ts', 'src/commands/index.ts', 'src/types.ts', 'src/tests/commands.test.ts'],
        discordpy: ['requirements.txt', 'bot.py', 'config.py', 'settings.json', 'commands/__init__.py', 'events/errors.py', 'tests/test_commands.py']
    };
    for (const [fw, tpl] of ALL) {
        const paths = generateProject(project(fw, tpl)).map((f) => f.path);
        for (const file of [...required[fw], '.env.example', 'README.md', '.gitignore']) assert.ok(paths.includes(file), `${fw}/${tpl} lacks ${file}`);
        const ext = { discordjs: 'js', 'discordjs-ts': 'ts', discordpy: 'py' }[fw];
        const dir = fw === 'discordpy' ? 'commands' : 'src/commands';
        for (const cmd of TEMPLATE_PARTS[tpl].commands) assert.ok(paths.includes(`${dir}/${cmd}.${ext}`), `${fw}/${tpl} lacks the ${cmd} command`);
    }
});

test('every generated JavaScript file compiles and every JSON file parses (syntax check, nothing executed)', () => {
    let checked = 0;
    for (const [fw, tpl] of ALL) {
        for (const file of generateProject(project(fw, tpl))) {
            if (file.path.endsWith('.js')) { compiles(file.content, `${fw}/${tpl}/${file.path}`); checked += 1; }
            if (file.path.endsWith('.json')) { JSON.parse(file.content); checked += 1; }
        }
    }
    assert.ok(checked >= 70, `${checked} files checked`);
});

test('generated package files are correct for each framework', () => {
    const js = JSON.parse(generateProject(project('discordjs', 'blank')).find((f) => f.path === 'package.json').content);
    assert.equal(js.name, 'my-blank-bot');
    assert.equal(js.scripts.test, 'node --test');
    assert.match(js.dependencies['discord.js'], /^\^14\.28/);
    const ts = JSON.parse(generateProject(project('discordjs-ts', 'blank')).find((f) => f.path === 'package.json').content);
    assert.equal(ts.scripts.typecheck, 'tsc --noEmit');
    assert.ok(ts.devDependencies.typescript);
    assert.equal(JSON.parse(generateProject(project('discordjs-ts', 'blank')).find((f) => f.path === 'tsconfig.json').content).compilerOptions.strict, true);
    const req = generateProject(project('discordpy', 'ai-assistant')).find((f) => f.path === 'requirements.txt').content;
    assert.match(req, /discord\.py>=2\.4,<3/);
    assert.match(req, /aiohttp/);
    assert.doesNotMatch(generateProject(project('discordpy', 'blank')).find((f) => f.path === 'requirements.txt').content, /aiohttp/);
});

test('no secrets are generated: .env.example has empty placeholders, .env is git-ignored, tokens only come from the environment', () => {
    for (const [fw, tpl] of ALL) {
        const files = generateProject(project(fw, tpl));
        const env = files.find((f) => f.path === '.env.example').content;
        assert.match(env, /^DISCORD_TOKEN=$/m);
        assert.doesNotMatch(env, /^DISCORD_TOKEN=.+$/m);
        assert.match(files.find((f) => f.path === '.gitignore').content, /^\.env$/m);
        assert.ok(!files.some((f) => f.path === '.env'));
        for (const file of files) assert.doesNotMatch(file.content, /[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/, `${file.path} contains a token-shaped string`);
    }
    // Config never crashes on import, so the offline tests run without a .env.
    const config = generateProject(project('discordjs', 'ai-assistant')).find((f) => f.path === 'src/config.js').content;
    assert.match(config, /config\.check = function check\(\)/);
    assert.doesNotMatch(config, /token: required\(/);
});

test('generated bots handle errors, never mass-ping, and check role hierarchy for moderation', () => {
    const files = Object.fromEntries(generateProject(project('discordjs', 'moderation')).map((f) => [f.path, f.content]));
    assert.match(files['src/index.js'], /unhandledRejection/);
    assert.match(files['src/events/interactionCreate.js'], /settings\.messages\.error/);
    for (const cmd of ['kick', 'ban', 'timeout']) assert.match(files[`src/commands/${cmd}.js`], /outranks\(interaction\.member, member\)/, cmd);
    for (const [fw, tpl] of ALL) {
        for (const file of generateProject(project(fw, tpl))) assert.doesNotMatch(file.content, /parse:\s*\[[^\]]*'everyone'|everyone=True/, `${fw}/${tpl}/${file.path}`);
    }
});

test('settings.json carries the customizable bits, and only that file changes when settings change', () => {
    const base = generateProject(project('discordjs', 'community'));
    const custom = generateProject({ ...project('discordjs', 'community'), settings: { embedColor: '#ff0000', disabledCommands: ['poll'], messages: { welcome: 'Hey {user}' } } });
    const changed = custom.filter((f, i) => f.content !== base[i].content).map((f) => f.path);
    assert.deepEqual(changed, ['src/settings.json']);
    const settings = JSON.parse(custom.find((f) => f.path === 'src/settings.json').content);
    assert.deepEqual([settings.embedColor, settings.disabledCommands, settings.messages.welcome, settings.messages.goodbye], ['#ff0000', ['poll'], 'Hey {user}', '{user} left {server}.']);
    assert.equal(settingsFile({ framework: 'discordpy' }).path, 'settings.json');
});

test('paths: only relative, no traversal, no backslashes, no hidden tricks', () => {
    for (const ok of ['src/index.js', '.env.example', 'commands/__init__.py']) assert.equal(isSafePath(ok), true, ok);
    for (const bad of ['../x', 'a/../b', '/etc/passwd', 'a\\b', 'a//b', './a', '', 'x'.repeat(201), 'a b', 'C:/x']) assert.equal(isSafePath(bad), false, bad);
});

test('zip export: valid archive with every file intact, secrets left out', () => {
    const files = [...generateProject(project('discordpy', 'blank')), { path: '.env', content: 'DISCORD_TOKEN=real-secret' }, { path: 'keys/bot.pem', content: 'secret' }];
    const included = exportable(files);
    assert.ok(included.some((f) => f.path === '.env.example'));
    assert.ok(!included.some((f) => f.path === '.env' || f.path.endsWith('.pem')));
    const archive = createZip(included, { folder: 'my-bot' });
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const back = readZip(archive);
    assert.equal(back.length, included.length);
    for (const file of included) {
        const found = back.find((b) => b.path === `my-bot/${file.path}`);
        assert.equal(found.content, file.content, file.path);
        assert.equal(found.crc, crc32(Buffer.from(file.content, 'utf8')));
    }
    assert.doesNotMatch(archive.toString('latin1'), /real-secret/);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'standard CRC-32 check value');
});

test('file rows carry the session owner and the project id only', () => {
    const rows = fileRows([{ path: 'a.js', content: 'x' }], { projectId: 'p', ownerId: 'o' });
    assert.deepEqual(rows, [{ project_id: 'p', owner_id: 'o', path: 'a.js', content: 'x' }]);
});

test('routes: export and file list are owner-only; create stores the generated files or rolls back', () => {
    const read = (...p) => fs.readFileSync(path.join(ROOT, 'dashboard', 'app', 'api', 'studio', 'projects', ...p), 'utf8');
    for (const file of [['[projectId]', 'files', 'route.js']]) {
        const src = read(...file);
        assert.match(src, /getOwnedProject\(supabase, ownerId, projectId\)/);
        assert.match(src, /\.eq\('owner_id', ownerId\)/);
    }
    // The .zip download was switched off at the owner's request: owner-checked 410, no files read.
    const exportRoute = read('[projectId]', 'export', 'route.js');
    assert.match(exportRoute, /getOwnedProject\(supabase, ownerId, projectId\)/);
    assert.match(exportRoute, /HttpError\(410/);
    assert.doesNotMatch(exportRoute, /studio_project_files|createZip/);
    const create = read('route.js');
    assert.match(create, /generators\.generateProject\(/);
    assert.match(create, /if \(filesError\) \{\s*await supabase\.from\('studio_projects'\)\.delete\(\)/);
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /tsc --noEmit -p \./);
    assert.match(ci, /python -m py_compile/);
});
