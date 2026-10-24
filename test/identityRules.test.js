const test = require('node:test');
const assert = require('node:assert/strict');

// Custom bot identity: the name/bio rules, real-type detection, the desired
// state (who gets reverted), and the save decision. dashboard/lib/shared/identity.js
const {
    IDENTITY_LIMITS,
    DEFAULT_IDENTITY,
    parseIdentityGuilds,
    identityAllowedInGuild,
    validateIdentityName,
    validateIdentityBio,
    detectImageType,
    identityDesired,
    identityApplied,
    identityPatch,
    identityImagePath,
    decideIdentitySave,
    premiumPerks,
    PREMIUM_PERKS,
    CUSTOM_IDENTITY_PERK
} = require('../dashboard/lib/shared');
const { detectProfanityAtBot, PROFANITY_TERMS, EXCLUDED_TERMS } = require('../src/ai/profanityDetector');

const G = '123456789012345678';
const SHA = 'b'.repeat(64);
const nameError = (name) => validateIdentityName(name).error;

test('ordinary names pass, trimmed and with whitespace collapsed', () => {
    for (const name of ['Zed', 'Chai Bot', 'Moonlight ✨', 'Rāju', 'カフェ bot', 'Bot 2000', 'Grandma’s Helper', 'Therapist Bot', 'Skill Up', 'Phở Bot', 'हैं दोस्त']) {
        assert.equal(nameError(name), null, `"${name}" should be allowed`);
    }
    assert.deepEqual(validateIdentityName('   Chai    Bot  '), { value: 'Chai Bot', error: null });
    assert.deepEqual(validateIdentityName(''), { value: null, error: null }, 'empty keeps the default name');
    assert.deepEqual(validateIdentityName('   '), { value: null, error: null });
});

test('name length, characters and Discord-reserved strings', () => {
    assert.equal(nameError('x'.repeat(IDENTITY_LIMITS.nickMax)), null);
    assert.match(nameError('x'.repeat(IDENTITY_LIMITS.nickMax + 1)), /at most 32/);
    for (const bad of ['Zed​', 'Zed‮', 'Zed\u0007', 'ㅤㅤ', 'Ź̂̃ed', '⠀']) {
        assert.ok(nameError(bad), `${JSON.stringify(bad)} should be refused`);
    }
    assert.match(nameError('...'), /letter or number/);
    for (const bad of ['Zed@home', 'Zed#1', 'Zed: bot', 'a```b']) assert.match(nameError(bad), /@, #, :/);
    assert.ok(nameError('everyone'));
    assert.ok(nameError('HERE'));
    assert.equal(nameError(42), 'Name must be text.');
});

test('names cannot impersonate Discord, its staff, ZiGBoT staff, or well-known bots (look-alikes included)', () => {
    for (const bad of ['Discord', 'D1sc0rd Helper', 'dіscord', 'Disc ord Staff', 'Clyde', 'C1yde', 'Discord Staff']) {
        assert.match(nameError(bad), /Discord|Clyde/, bad);
    }
    for (const bad of ['ZiGBoT Staff', 'ZiGB0T Support', 'zigbot team', 'Zig Bot Admin', 'ZIGBOT OFFICIAL']) {
        assert.match(nameError(bad), /ZiGBoT staff|official/, bad);
    }
    for (const bad of ['System', 'Official Bot', 'Trust & Safety', 'AutoMod', 'Verified', 'Support Team']) {
        assert.match(nameError(bad), /official, staff or system/, bad);
    }
    for (const bad of ['MEE6', 'mee6 helper', 'Dyno', 'Carl-bot', 'ProBot ✨', 'Dank Memer', 'Midjourney Bot', 'Rythm']) {
        assert.match(nameError(bad), /well-known bot/, bad);
    }
    assert.equal(nameError('ZiGBoT'), null, 'the default name itself is fine');
    assert.equal(nameError('Dynamo'), null, 'short bot names only match as whole words');
});

test('names with profanity or slurs are refused, including hidden or spaced-out spellings', () => {
    for (const bad of ['Fuck Bot', 'xXfuckXx', 'f.u.c.k', 'Sh1t Head', 'chutiya', 'Madarchod', 'bsdk bot', 'B1tch']) {
        assert.match(nameError(bad), /profanity or slurs/, bad);
    }
});

test('bio rules: length, lines, links, mentions, staff claims, profanity', () => {
    assert.deepEqual(validateIdentityBio('  Your friendly\r\n\r\n chai bot  '), { value: 'Your friendly\nchai bot', error: null });
    assert.deepEqual(validateIdentityBio(''), { value: null, error: null });
    assert.match(validateIdentityBio('x'.repeat(IDENTITY_LIMITS.bioMax + 1)).error, /at most 190/);
    assert.match(validateIdentityBio('a\nb\nc\nd\ne').error, /at most 4 lines/);
    for (const link of ['join discord.gg/abc', 'https://evil.example', 'see www.example.com', 'discord.com/invite/x']) {
        assert.match(validateIdentityBio(link).error, /links or invites/, link);
    }
    for (const mention of ['hi @everyone', 'ping <@123456789012345678>', 'role <@&123456789012345678>']) {
        assert.match(validateIdentityBio(mention).error, /mentions/, mention);
    }
    assert.match(validateIdentityBio('Official Discord Staff account').error, /Discord or ZiGBoT staff/);
    assert.match(validateIdentityBio('ZiGBoT support here, DM me').error, /Discord or ZiGBoT staff/);
    assert.match(validateIdentityBio('I am a bitch').error, /profanity or slurs/);
});

test('the real image type comes from the bytes, not the name', () => {
    const bytes = (...b) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
    assert.equal(detectImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'png');
    assert.equal(detectImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpeg');
    assert.equal(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
    assert.equal(detectImageType(Buffer.from('GIF89a......')), 'gif');
    assert.equal(detectImageType(Buffer.from('MZ\x90\0 not an image at all')), null, 'a renamed .exe');
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null, 'SVG is not accepted');
    assert.equal(detectImageType(Buffer.alloc(4)), null);
    assert.equal(detectImageType('not bytes'), null);
});

test('desired state: untouched without a row; default when not Premium or blocked; pending avatars never applied', () => {
    const row = { guild_id: G, nick: 'Zed', bio: 'hi', avatar_sha256: SHA, pending_avatar_sha256: 'c'.repeat(64) };
    assert.equal(identityDesired({ row: null, premium: true, blocked: false }), null);
    assert.deepEqual(identityDesired({ row, premium: true, blocked: false }), { nick: 'Zed', bio: 'hi', avatarSha: SHA });
    assert.equal(identityDesired({ row, premium: false, blocked: false }), DEFAULT_IDENTITY);
    assert.equal(identityDesired({ row, premium: true, blocked: true }), DEFAULT_IDENTITY);
    assert.deepEqual(identityDesired({ row: { guild_id: G, nick: 'Zed', pending_avatar_sha256: SHA }, premium: true, blocked: false }), { nick: 'Zed', bio: null, avatarSha: null });
    assert.equal(identityDesired({ row, premium: true, blocked: false, allowed: false }), DEFAULT_IDENTITY, 'not in CUSTOM_IDENTITY_GUILDS');
});

test('CUSTOM_IDENTITY_GUILDS: parsed strictly; empty means every server', () => {
    assert.deepEqual(parseIdentityGuilds(` ${G}, 999999999999999999,,${G}, abc, 123 `), [G, '999999999999999999']);
    assert.deepEqual(parseIdentityGuilds(undefined), []);
    assert.equal(identityAllowedInGuild(G, []), true);
    assert.equal(identityAllowedInGuild(G, [G]), true);
    assert.equal(identityAllowedInGuild(G, ['999999999999999999']), false);
});

test('patch: only changed fields are sent; nothing when already in sync', () => {
    const desired = { nick: 'Zed', bio: null, avatarSha: SHA };
    assert.deepEqual(identityPatch(desired, DEFAULT_IDENTITY), { nick: 'Zed', avatarSha: SHA });
    assert.deepEqual(identityPatch(desired, identityApplied({ applied_nick: 'Zed', applied_avatar_sha256: SHA })), {});
    assert.deepEqual(identityPatch(DEFAULT_IDENTITY, identityApplied({ applied_nick: 'Zed', applied_bio: 'x' })), { nick: null, bio: null });
    assert.deepEqual(identityPatch(null, identityApplied({ applied_nick: 'Zed' })), {}, 'servers without a row are never touched');
});

test('storage paths are always <guild>/<sha256>.png', () => {
    assert.equal(identityImagePath(G, SHA), `${G}/${SHA}.png`);
    assert.throws(() => identityImagePath('../x', SHA), /Invalid identity image path/);
    assert.throws(() => identityImagePath(G, 'nothex'), /Invalid identity image path/);
});

test('save decision: feature flag, blocks, Premium and cooldown', () => {
    const ok = { enabled: true, premium: true, guildBlocked: false, userBlocked: false, changesLastHour: 0, changesLastDay: 0 };
    assert.deepEqual(decideIdentitySave(ok), { allowed: true });
    assert.equal(decideIdentitySave({ ...ok, enabled: false }).code, 'identity_disabled');
    assert.equal(decideIdentitySave({ ...ok, guildBlocked: true }).status, 403);
    assert.equal(decideIdentitySave({ ...ok, userBlocked: true }).code, 'identity_blocked');
    assert.equal(decideIdentitySave({ ...ok, premium: false }).code, 'premium_required');
    assert.equal(decideIdentitySave({ ...ok, changesLastHour: IDENTITY_LIMITS.changesPerHour }).status, 429);
    assert.equal(decideIdentitySave({ ...ok, changesLastHour: IDENTITY_LIMITS.changesPerHour - 1 }).allowed, true);
    assert.equal(decideIdentitySave({ ...ok, changesLastDay: IDENTITY_LIMITS.changesPerDay }).status, 429);
    assert.equal(decideIdentitySave({ ...ok, premium: false, guildBlocked: true }).code, 'identity_blocked', 'a block is reported before Premium');
});

test('the custom_identity perk is only offered where the feature is switched on', () => {
    assert.equal(CUSTOM_IDENTITY_PERK.key, 'custom_identity');
    assert.ok(!PREMIUM_PERKS.some((p) => p.key === 'custom_identity'), 'not advertised (landing, Premium tab) until it ships');
    assert.equal(premiumPerks(), PREMIUM_PERKS);
    assert.deepEqual(premiumPerks({ customIdentity: true }).map((p) => p.key), [...PREMIUM_PERKS.map((p) => p.key), 'custom_identity']);
    assert.match(CUSTOM_IDENTITY_PERK.text, /APP tag always stays/);
});

test('moving the profanity lists to lib/shared left the comeback detector unchanged', () => {
    assert.ok(PROFANITY_TERMS.includes('chutiya') && EXCLUDED_TERMS.includes('madarchod'));
    assert.equal(detectProfanityAtBot('you are a chutiya').category, 'profanity');
    assert.equal(detectProfanityAtBot('madarchod').category, 'excluded');
    assert.equal(detectProfanityAtBot('this shit is funny').matched, false);
});
