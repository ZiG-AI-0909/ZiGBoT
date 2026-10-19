const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGuildConfig, sanitizeStoredConfig, defaultGuildConfig } = require('../dashboard/lib/shared');
const sarvam = require('../src/voice/sarvamSpeech');

const G = '900000000000000001';
const R1 = '900000000000000031';
const R2 = '900000000000000032';
const ctx = { guildId: G, channelIds: new Set(), roleIds: new Set([R1, R2]) };
const base = () => ({ ...defaultGuildConfig({ guildId: G }) });

test('dashboard saves voice settings and the /setup answers', () => {
    const result = validateGuildConfig({
        ...base(),
        voice_speaker: 'priya', voice_pace: 120, voice_language: 'en-IN', voice_speak_replies: false,
        owner_pronouns: 'she/her', male_role_ids: [R1], minor_role_ids: [R2]
    }, ctx);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.voice_speaker, 'priya');
    assert.equal(result.value.voice_pace, 120);
    assert.equal(result.value.voice_language, 'en-IN');
    assert.equal(result.value.voice_speak_replies, false);
    assert.equal(result.value.owner_pronouns, 'she/her');
    assert.deepEqual(result.value.male_role_ids, [R1]);
    assert.deepEqual(result.value.minor_role_ids, [R2]);
    // "Default voice" and "not set" are allowed.
    const blank = validateGuildConfig({ ...base(), voice_speaker: '', owner_pronouns: '' }, ctx);
    assert.equal(blank.ok, true);
    assert.equal(blank.value.voice_speaker, '');
    assert.equal(blank.value.owner_pronouns, null);
});

test('bad voice and setup values are rejected', () => {
    const errors = validateGuildConfig({
        ...base(),
        voice_speaker: 'darth_vader', voice_pace: 400, voice_language: 'fr-FR',
        owner_pronouns: 'robot', adult_role_ids: [R1], minor_role_ids: [R1], male_role_ids: ['900000000000000099']
    }, ctx).errors;
    for (const field of ['voice_speaker', 'voice_pace', 'voice_language', 'owner_pronouns', 'minor_role_ids', 'male_role_ids']) {
        assert.ok(errors[field], `expected an error for ${field}`);
    }
    const both = validateGuildConfig({ ...base(), male_role_ids: [R1], female_role_ids: [R1] }, ctx);
    assert.match(both.errors.female_role_ids, /both male and female/);
});

test('stored voice settings are sanitized', () => {
    const row = sanitizeStoredConfig({ ...base(), voice_speaker: 'nobody', voice_pace: 999, voice_language: 'xx' }, { guildId: G });
    assert.equal(row.voice_speaker, '');
    assert.equal(row.voice_pace, 200);
    assert.equal(row.voice_language, 'auto');
});

test('the server voice settings beat the bot-wide defaults', () => {
    const settings = { sarvamVoice: 'shubh', sarvamPace: '1.0', guildContext: { config: { voice_speaker: 'kavya', voice_pace: 80, voice_language: 'en-IN', language: 'Hinglish' } } };
    const body = sarvam.requestBody(settings, 'hello');
    assert.equal(body.speaker, 'kavya');
    assert.equal(body.pace, 0.8);
    assert.equal(body.language_code, 'en-IN');
    const defaults = sarvam.requestBody({ sarvamVoice: 'rahul', guildContext: { config: { voice_speaker: '', voice_pace: 100, voice_language: 'auto' } } }, 'hello');
    assert.equal(defaults.speaker, 'rahul');
    assert.equal(defaults.pace, 1);
    assert.equal(defaults.language_code, 'hi-IN');
});

test('"Roast the owner too" is off by default and can be switched on', () => {
    assert.equal(defaultGuildConfig({ guildId: G }).owner_roast, false);
    const on = validateGuildConfig({ ...base(), owner_roast: true }, ctx);
    assert.equal(on.ok, true);
    assert.equal(on.value.owner_roast, true);
    assert.equal(sanitizeStoredConfig({ ...base(), owner_roast: true }, { guildId: G }).owner_roast, true);
});
