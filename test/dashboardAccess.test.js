const test = require('node:test');
const assert = require('node:assert/strict');
const { discordIdFromUser, decideGuildAccess, isSameOrigin, PERMISSIONS } = require('../dashboard/lib/shared');

const ME = '100000000000000001';
const OTHER = '100000000000000002';
const G = '200000000000000001';
const R_MANAGER = '300000000000000001';
const R_HELPER = '300000000000000002';

const guild = {
    id: G,
    owner_id: OTHER,
    roles: [
        { id: G, permissions: '0' },
        { id: R_MANAGER, permissions: String(PERMISSIONS.MANAGE_GUILD) },
        { id: R_HELPER, permissions: String(PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_MESSAGES) }
    ]
};

test('Discord id comes only from Supabase identities, never editable user_metadata', () => {
    const user = {
        user_metadata: { provider_id: OTHER, sub: OTHER },
        identities: [{ provider: 'discord', id: ME, identity_data: { provider_id: ME, sub: ME } }]
    };
    assert.equal(discordIdFromUser(user), ME);
    assert.equal(discordIdFromUser({ user_metadata: { provider_id: OTHER }, identities: [] }), null, 'metadata alone is not trusted');
    assert.equal(discordIdFromUser({ identities: [{ provider: 'email', id: 'x' }] }), null);
    assert.equal(discordIdFromUser({ identities: [{ provider: 'discord', identity_data: { sub: 'not-a-snowflake' } }] }), null);
});

test('access decision: managers allowed, helpers and strangers denied, bot-missing reported', () => {
    assert.equal(decideGuildAccess({ guild, member: { user: { id: ME }, roles: [R_MANAGER] }, discordUserId: ME }).allowed, true);
    const helper = decideGuildAccess({ guild, member: { user: { id: ME }, roles: [R_HELPER] }, discordUserId: ME });
    assert.equal(helper.allowed, false);
    assert.equal(helper.status, 403);
    assert.equal(decideGuildAccess({ guild, member: null, discordUserId: ME }).code, 'not_member');
    assert.equal(decideGuildAccess({ guild: null, member: null, discordUserId: ME }).code, 'bot_not_installed');
    assert.equal(decideGuildAccess({ guild, member: { user: { id: ME }, roles: [] }, discordUserId: null }).status, 401);
    const owner = decideGuildAccess({ guild, member: { user: { id: OTHER }, roles: [] }, discordUserId: OTHER });
    assert.equal(owner.allowed, true);
    assert.equal(owner.isOwner, true);
});

test('access decision: a member object for someone else is rejected (identity mismatch)', () => {
    const result = decideGuildAccess({ guild, member: { user: { id: OTHER }, roles: [R_MANAGER] }, discordUserId: ME });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'identity_mismatch');
});

test('access decision: role ids not defined in the guild grant nothing', () => {
    const forged = decideGuildAccess({ guild, member: { user: { id: ME }, roles: ['999999999999999999'] }, discordUserId: ME });
    assert.equal(forged.allowed, false);
});

test('same-origin check blocks cross-site and missing origins', () => {
    assert.equal(isSameOrigin({ origin: 'https://dash.example.com', host: 'dash.example.com' }), true);
    assert.equal(isSameOrigin({ origin: 'https://evil.example.com', host: 'dash.example.com' }), false);
    assert.equal(isSameOrigin({ origin: null, host: 'dash.example.com' }), false);
    assert.equal(isSameOrigin({ origin: 'not a url', host: 'x' }), false);
    assert.equal(isSameOrigin({ origin: 'https://zig.vercel.app', host: 'internal-host', allowedOrigins: ['https://zig.vercel.app/'] }), true);
});
