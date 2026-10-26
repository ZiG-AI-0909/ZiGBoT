const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Ready-made custom personas (dashboard/lib/shared/personaTemplates.js).
const {
    PERSONA_TEMPLATES, applyPersonaTemplate, personaTemplateWouldReplace, defaultGuildConfig, validateGuildConfig,
    validateGifStyle, resolveGifRules, applyPlanToConfig, composeSystemPrompt, sanitizeStoredConfig
} = require('../dashboard/lib/shared');

const G = '900000000000000001';
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const draftFor = (template) => applyPersonaTemplate({ ...defaultGuildConfig({ guildId: G }) }, template.id);

test('exactly the three requested templates, from one shared list', () => {
    assert.deepEqual(PERSONA_TEMPLATES.map((t) => [t.emoji, t.name, t.fields.default_tone, t.gifStyle]), [
        ['🎮', 'Hype Gamer Coach', 'savage', 'gaming'],
        ['🌸', 'Chill Bestie', 'gentle', 'wholesome'],
        ['🏴‍☠️', 'Pirate Captain', 'neutral', 'pirate']
    ]);
    for (const t of PERSONA_TEMPLATES) {
        assert.ok(t.description.length <= 100 && t.sample.length <= 160, `${t.name}: short description and sample`);
        assert.equal(t.fields.replace_base_persona, false, `${t.name} is layered on ZiGBoT's persona, so platform safety stays`);
    }
    assert.match(PERSONA_TEMPLATES[2].fields.custom_system_prompt, /call the members your crew/);
});

test('each template passes the same validation as admin-written text', () => {
    for (const t of PERSONA_TEMPLATES) {
        const draft = draftFor(t);
        const result = validateGuildConfig(draft, { guildId: G });
        assert.equal(result.ok, true, `${t.name}: ${JSON.stringify(result.errors)}`);
        assert.equal(result.value.custom_system_prompt, t.fields.custom_system_prompt);
        assert.equal(result.value.response_style, t.fields.response_style);
        assert.equal(result.value.default_tone, t.fields.default_tone);
        assert.equal(result.value.gif_settings.custom_style, t.gifStyle);
        assert.deepEqual(validateGifStyle(t.gifStyle), { value: t.gifStyle, error: null });
    }
});

test('templates never override the under-18 gentle rule, the roast limits or the safety layer', () => {
    for (const t of PERSONA_TEMPLATES) {
        const text = `${t.fields.custom_system_prompt} ${t.fields.response_style}`;
        assert.doesNotMatch(text, /under.?18|minor|kids?\b|no (limits|rules|filters)|ignore|override|bypass|anything goes|sexual|slur/i, `${t.name} says nothing about limits`);
        const config = sanitizeStoredConfig(draftFor(t), { guildId: G });
        const prompt = composeSystemPrompt({ config, behavior: { tone: t.fields.default_tone, instructions: [], pronouns: null }, isHomeGuild: false });
        assert.match(prompt, /PLATFORM RULES/, `${t.name}: platform rules still lead the prompt`);
        assert.ok(prompt.indexOf('PLATFORM RULES') < prompt.indexOf(t.fields.custom_system_prompt.slice(0, 30)), 'the template comes after the platform rules');
        // Under-18 members get Gentle GIF rules even under the savage template.
        const minor = resolveGifRules({ settings: config.gif_settings, tone: t.fields.default_tone, isMinor: true, customPersona: true });
        assert.equal(minor.mode, 'gentle');
        assert.equal(minor.customStyle, null);
    }
    // The bot's tone rules: under-18 first, and savage still needs the "roast" feature.
    const index = read('src/index.js');
    assert.match(index, /if \(behavior\?\.isMinor \|\| isOwner\) tone = 'gentle';/);
    assert.match(index, /if \(tone === 'savage' && !ownerRoast && behavior && !hasFeature\(behavior, 'roast'\)\) tone = 'gentle';/);
});

test('free servers: a template does nothing at runtime (same as a custom persona)', () => {
    for (const t of PERSONA_TEMPLATES) {
        const free = applyPlanToConfig(sanitizeStoredConfig(draftFor(t), { guildId: G }), false);
        assert.equal(free.custom_system_prompt, '');
        assert.equal(free.gif_settings.custom_style, '');
    }
    const component = read('dashboard/components/PersonaTemplates.js');
    assert.match(component, /disabled=\{!premium\}/);
    assert.match(component, /aria-label="Premium only"/);
    assert.match(component, /if \(!premium\) return;/);
});

test('applying a template fills only its fields, and asks before replacing typed text', () => {
    const base = { ...defaultGuildConfig({ guildId: G }), server_rules: 'No spoilers.', response_instructions: 'Point to #help.' };
    const pirate = applyPersonaTemplate(base, 'pirate_captain');
    assert.equal(pirate.server_rules, 'No spoilers.', 'other fields are untouched');
    assert.equal(pirate.response_instructions, 'Point to #help.');
    assert.deepEqual(pirate.gif_settings.modes, base.gif_settings.modes, 'GIF mode settings are untouched');
    assert.equal(pirate.gif_settings.custom_style, 'pirate');
    assert.equal(applyPersonaTemplate(base, 'nope'), base);

    assert.equal(personaTemplateWouldReplace(base, 'pirate_captain'), false, 'empty fields: no confirmation needed');
    assert.equal(personaTemplateWouldReplace({ ...base, custom_system_prompt: 'My own words' }, 'pirate_captain'), true);
    assert.equal(personaTemplateWouldReplace({ ...base, response_style: 'formal' }, 'chill_bestie'), true);
    assert.equal(personaTemplateWouldReplace({ ...base, gif_settings: { ...base.gif_settings, custom_style: 'anime' } }, 'chill_bestie'), true);
    assert.equal(personaTemplateWouldReplace(pirate, 'pirate_captain'), false, 're-applying the same template asks nothing');
    assert.equal(personaTemplateWouldReplace(pirate, 'chill_bestie'), true, 'switching templates replaces the earlier template text');
});

test('the editor shows the cards in the custom persona card, accessible and reduced-motion aware', () => {
    const editor = read('dashboard/components/GuildEditor.js');
    assert.match(editor, /<PersonaTemplates draft=\{draft\} updateDraft=\{updateDraft\} premium=\{premium\} \/>/);
    assert.ok(editor.indexOf('<PersonaTemplates') < editor.indexOf('<TextArea id="prompt"'), 'cards sit above the persona text box');
    const component = read('dashboard/components/PersonaTemplates.js');
    assert.match(component, /<button\s+key=\{template\.id\}\s+type="button"\s+className="template-card"/, 'cards are real buttons (keyboard and screen readers)');
    assert.match(component, /role="alertdialog"/);
    assert.match(component, /e\.key === 'Escape'/);
    assert.match(component, /from '@\/lib\/shared\/personaTemplates'/, 'reads the one shared list');
    const css = read('dashboard/app/globals.css');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.template-card \{ animation: none; transition: none; \}/);
});
