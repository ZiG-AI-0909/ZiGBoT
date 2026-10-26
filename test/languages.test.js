const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Server reply language: one list (dashboard/lib/shared/languages.js) for the
// dashboard dropdown, /setup and the config validator.
const { SUPPORTED_LANGUAGES, LANGUAGE_VALUES, DEFAULT_LANGUAGE, normalizeLanguage, validateGuildConfig, sanitizeStoredConfig } = require('../dashboard/lib/shared');
const { languageMode, personaFor } = require('../dashboard/lib/shared/personas');
const { buildDefinitions } = require('../src/slash');
const { GuildConfigStore } = require('../src/guildConfig/store');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const G = '900000000000000001';

test('only languages the bot has a persona for are offered, with the values /setup always stored', () => {
    assert.deepEqual(LANGUAGE_VALUES, ['English', 'Hinglish']);
    assert.equal(DEFAULT_LANGUAGE, 'English');
    for (const lang of SUPPORTED_LANGUAGES) {
        assert.ok(languageMode(lang.value), `${lang.value} has its own persona (languageMode)`);
        assert.ok(lang.label && lang.icon && lang.help, `${lang.value} has a label, icon and hint`);
    }
    assert.notEqual(personaFor('savage', 'English'), personaFor('savage', 'Hinglish'));
    assert.match(personaFor('savage', 'English'), /Reply ONLY in English/);
});

test('old or unknown saved values are shown as English and flagged, never broken', () => {
    assert.deepEqual(normalizeLanguage('Hinglish'), { value: 'Hinglish', supported: true, stored: 'Hinglish' });
    for (const stored of ['', null, undefined, 'English-Hinglish mix', 'French', 'english ', 42]) {
        const result = normalizeLanguage(stored);
        assert.equal(result.value, 'English', String(stored));
        assert.equal(result.supported, false, `${String(stored)} is flagged`);
    }
    assert.equal(normalizeLanguage(' English ').supported, true, 'surrounding spaces are fine');
    assert.equal(normalizeLanguage('English-Hinglish mix').supported, false);
    assert.equal(normalizeLanguage('english').supported, false, 'values are matched exactly, as /setup stores them');
    // The bot keeps reading what is stored (no migration, no behaviour change until an admin saves).
    assert.equal(sanitizeStoredConfig({ guild_id: G, language: 'English-Hinglish mix' }, { guildId: G }).language, 'English-Hinglish mix');
});

test('the server-side validator is the source of truth: only the supported list can be saved', () => {
    for (const value of LANGUAGE_VALUES) assert.equal(validateGuildConfig({ language: value }, { guildId: G }).value.language, value);
    assert.equal(validateGuildConfig({ language: '' }, { guildId: G }).value.language, '', '"not chosen yet" (a new server\'s default) stays valid');
    for (const bad of ['French', 'english', ' ', 'Hindi', 'English-Hinglish mix', '<script>']) {
        const result = validateGuildConfig({ language: bad }, { guildId: G });
        assert.equal(result.ok, false, `"${bad}" is refused`);
        assert.equal(result.errors.language, 'Must be one of: English, Hinglish.');
    }
    assert.equal(validateGuildConfig({}, { guildId: G }).value.language, 'English', 'missing → the default');
});

test('/setup offers the same list, and saveSetup stores only listed values', async () => {
    const setup = buildDefinitions().find((d) => d.name === 'setup');
    const language = setup.options.find((o) => o.name === 'language');
    assert.deepEqual(language.choices.map((c) => c.value), LANGUAGE_VALUES);
    assert.deepEqual(language.choices.map((c) => c.name), SUPPORTED_LANGUAGES.map((l) => l.label));

    const bodies = [];
    const fetchImpl = async (url, init = {}) => {
        if (init.method === 'PATCH' && url.includes('zb_guild_configs')) bodies.push(JSON.parse(init.body));
        return { ok: true, status: 204, text: async () => '' };
    };
    const store = new GuildConfigStore({ settings: {}, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl, logger: { error() {} } });
    for (const language of ['Hinglish', 'English', 'Klingon']) {
        await store.saveSetup({ id: G, name: 'Test', ownerId: '900000000000000099' }, { language, ownerPronouns: 'they/them' });
    }
    assert.deepEqual(bodies.map((b) => b.language), ['Hinglish', 'English', 'English']);
});

test('the dashboard dropdown reads the shared list and replaced the free-text field', () => {
    const page = read('dashboard/app/dashboard/[guildId]/page.js');
    assert.match(page, /languages: SUPPORTED_LANGUAGES, defaultLanguage: DEFAULT_LANGUAGE/);
    const editor = read('dashboard/components/GuildEditor.js');
    assert.match(editor, /<LanguageSelect\s+id="language"/);
    assert.match(editor, /options=\{meta\.languages\}/);
    assert.doesNotMatch(editor, /<input id="language"/, 'no free-text language input any more');
    assert.match(editor, /staleLanguage === null \? null :/, 'unsupported saved values are flagged');
    const select = read('dashboard/components/LanguageSelect.js');
    for (const a11y of ['aria-haspopup="listbox"', 'role="listbox"', 'role="option"', 'aria-activedescendant', "'Escape'", "'Home'", "'End'"]) {
        assert.ok(select.includes(a11y), `dropdown supports ${a11y}`);
    }
    const css = read('dashboard/app/globals.css');
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(reduced, /\.choice-list[^{]*\{ transition: none; \}/, 'no open/close animation with reduced motion');
    assert.match(css, /\.choice-button \{[^}]*min-height: 44px/, 'big tap target');
});
