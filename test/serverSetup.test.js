const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMemberBehavior, composeSystemPrompt, sanitizeStoredConfig, defaultGuildConfig } = require('../dashboard/lib/shared');
const { personaFor, languageMode } = require('../dashboard/lib/shared/personas');
const { setupRoleProblem, WELCOME_MESSAGE } = require('../src/guildConfig/setup');
const { GuildConfigStore } = require('../src/guildConfig/store');

const G = '900000000000000001';
const R_MALE = '900000000000000031';
const R_FEMALE = '900000000000000032';
const R_ADULT = '900000000000000033';
const R_MINOR = '900000000000000034';

const config = {
    ...defaultGuildConfig({ guildId: G }),
    default_tone: 'gentle',
    owner_pronouns: 'she/her',
    male_role_ids: [R_MALE],
    female_role_ids: [R_FEMALE],
    adult_role_ids: [R_ADULT],
    minor_role_ids: [R_MINOR]
};

test('18+ members are roasted, under-18 members never are', () => {
    const adult = resolveMemberBehavior({ config, memberRoleIds: [R_ADULT, R_MALE] });
    assert.equal(adult.tone, 'savage');
    assert.equal(adult.pronouns, 'he/him');
    assert.equal(adult.features.has('roast'), true);

    const minor = resolveMemberBehavior({ config, memberRoleIds: [R_MINOR, R_FEMALE] });
    assert.equal(minor.tone, 'gentle');
    assert.equal(minor.isMinor, true);
    assert.equal(minor.pronouns, 'she/her');
    assert.equal(minor.features.has('roast'), false);
    assert.match(minor.instructions[0], /UNDER 18/);
});

test('under-18 wins over the 18+ role, a savage mapping and a savage server default', () => {
    const savageConfig = { ...config, default_tone: 'savage' };
    const mappings = [{ role_id: R_MALE, tone: 'savage', allowed_features: ['roast'], priority: 999 }];
    const behavior = resolveMemberBehavior({ config: savageConfig, mappings, memberRoleIds: [R_MINOR, R_ADULT, R_MALE] });
    assert.equal(behavior.tone, 'gentle');
    assert.equal(behavior.features.has('roast'), false);
});

test('members without age roles keep the server default; the owner gets the owner pronouns', () => {
    assert.equal(resolveMemberBehavior({ config, memberRoleIds: [] }).tone, 'gentle');
    assert.equal(resolveMemberBehavior({ config, memberRoleIds: [], isGuildOwner: true }).pronouns, 'she/her');
    assert.equal(resolveMemberBehavior({ config, memberRoleIds: [] }).pronouns, null);
});

test('language picks English-only or Hinglish personas; unset keeps the original', () => {
    assert.equal(languageMode('English'), 'english');
    assert.equal(languageMode('Hinglish'), 'hinglish');
    assert.equal(languageMode('English-Hinglish mix'), null);
    assert.equal(languageMode(''), null);

    const english = personaFor('savage', 'English');
    assert.match(english, /Reply ONLY in English/);
    assert.doesNotMatch(english, /bhai|Hinglish slang|Samay Raina/);
    assert.match(personaFor('gentle', 'English'), /Reply ONLY in English/);

    assert.match(personaFor('savage', 'Hinglish'), /Reply in Hinglish by default/);
    assert.match(personaFor('savage', 'Hinglish'), /Sharma ji ka beta/);
    assert.doesNotMatch(personaFor('savage', ''), /LANGUAGE:/);
});

test('system prompt uses the language persona and states the owner pronouns', () => {
    const prompt = composeSystemPrompt({ config: { ...config, language: 'English' }, behavior: { tone: 'savage', instructions: [], pronouns: null } });
    assert.match(prompt, /Reply ONLY in English/);
    assert.match(prompt, /server's owner uses she\/her pronouns/);
    assert.doesNotMatch(prompt, /Preferred language: English/);
});

test('stored setup values are sanitized', () => {
    const row = sanitizeStoredConfig({ ...config, owner_pronouns: 'robot', minor_role_ids: [R_MINOR, 'nope'] }, { guildId: G });
    assert.equal(row.owner_pronouns, null);
    assert.deepEqual(row.minor_role_ids, [R_MINOR]);
});

test('setup rejects @everyone, bot roles and duplicate roles', () => {
    const role = (id, extra = {}) => ({ id, name: `r${id}`, managed: false, ...extra });
    assert.equal(setupRoleProblem({ guildId: G, roles: { male: role(R_MALE), female: role(R_FEMALE) } }), null);
    assert.match(setupRoleProblem({ guildId: G, roles: { male: role(G) } }), /@everyone/);
    assert.match(setupRoleProblem({ guildId: G, roles: { adult: role(R_ADULT, { managed: true }) } }), /bot or integration/);
    assert.match(setupRoleProblem({ guildId: G, roles: { male: role(R_MALE), female: role(R_MALE) } }), /different/);
    assert.match(setupRoleProblem({ guildId: G, roles: { adult: role(R_ADULT), 'under-18': role(R_ADULT) } }), /different/);
    assert.match(WELCOME_MESSAGE, /\/setup/);
});

test('saveSetup PATCHes only this guild and only the setup fields', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
        return { ok: true, status: 204, text: async () => '' };
    };
    const store = new GuildConfigStore({ settings: {}, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl, logger: { error() {} } });
    const saved = await store.saveSetup({ id: G, name: 'Test', ownerId: '900000000000000099' }, {
        language: 'English', ownerPronouns: 'he/him', maleRoleIds: [R_MALE], femaleRoleIds: [], adultRoleIds: [R_ADULT, G], minorRoleIds: ['bad']
    });
    assert.deepEqual(saved.adult_role_ids, [R_ADULT]);
    assert.deepEqual(saved.minor_role_ids, []);
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('zb_guild_configs'));
    assert.match(patch.url, new RegExp(`guild_id=eq.${G}`));
    assert.deepEqual(Object.keys(patch.body).sort(), ['adult_role_ids', 'female_role_ids', 'language', 'male_role_ids', 'minor_role_ids', 'owner_pronouns', 'updated_at']);
    // Seeding a guild never sends the setup columns (database defaults apply).
    const seed = calls.find((c) => c.method === 'POST' && c.url.includes('zb_guild_configs'));
    assert.equal('minor_role_ids' in seed.body[0], false);
});
