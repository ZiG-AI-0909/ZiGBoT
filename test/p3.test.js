const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RateLimiter } = require('../src/ai/rateLimiter');
const { openDatabase, WarnStore } = require('../src/db');
const { isAuthorizedActor, executeTool, destructiveActions } = require('../src/tools/router');
const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
const { interactionToIntent, slashActionByCommand } = require('../src/slash');

// ---------- Rate limiter ----------

test('rate limiter allows up to max then blocks within the window', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
    const user = 'user-1';

    assert.equal(limiter.attempt(user, 0), true);
    assert.equal(limiter.attempt(user, 10), true);
    assert.equal(limiter.attempt(user, 20), true);
    assert.equal(limiter.attempt(user, 30), false); // over the 3-max

    // After the window slides past, the user gets quota back.
    assert.equal(limiter.attempt(user, 1500), true);
});

test('rate limiter tracks users independently', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 });
    assert.equal(limiter.attempt('a', 0), true);
    assert.equal(limiter.attempt('a', 1), false);
    assert.equal(limiter.attempt('b', 2), true);
});

// ---------- SQLite warn store ----------

function temporaryDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zigbot-test-'));
    const dbPath = path.join(directory, 'test.db');
    return { dbPath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('warn store persists warnings and counts per guild+user', () => {
    const { dbPath, cleanup } = temporaryDatabase();
    try {
        const db = openDatabase(dbPath);
        const warns = new WarnStore(db);

        const first = warns.addWarning('guild-1', 'user-1', 'spamming', 'mod-1');
        const second = warns.addWarning('guild-1', 'user-1', 'ban evasion', 'mod-2');
        warns.addWarning('guild-2', 'user-1', 'other guild', 'mod-1');

        assert.equal(first.id > 0, true);
        assert.notEqual(first.id, second.id);
        assert.equal(warns.countWarnings('guild-1', 'user-1'), 2);
        assert.equal(warns.countWarnings('guild-2', 'user-1'), 1);

        const list = warns.listWarnings('guild-1', 'user-1');
        assert.equal(list.length, 2);
        assert.equal(list[0].reason, 'spamming'); // ordered oldest first
        assert.equal(list[1].reason, 'ban evasion');

        // Migrations are idempotent: reopening the same file must not fail.
        const reopened = openDatabase(dbPath);
        const reloaded = new WarnStore(reopened);
        assert.equal(reloaded.countWarnings('guild-1', 'user-1'), 2);
    } finally {
        cleanup();
    }
});

// ---------- Per-guild owners / admin roles ----------

function fakeMessage(authorId, guildId, options = {}) {
    const roles = (options.roles || []).map((name) => ({ name }));
    return {
        author: { id: authorId },
        guild: { id: guildId, ownerId: options.guildOwnerId || 'real-guild-owner' },
        member: {
            roles: {
                // Mimic the discord.js Collection surface the router uses.
                cache: {
                    some: (predicate) => roles.some((role) => predicate(role)),
                    map: (fn) => roles.map((role) => fn(role))
                }
            }
        }
    };
}

const strictSettings = { serverOwnerId: 'owner-123' };

test('strict SERVER_OWNER_ID fallback still authorizes the single-server owner', () => {
    const message = fakeMessage('owner-123', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(message, strictSettings).allowed, true);
});

test('strict owner check is unchanged for non-owners', () => {
    const message = fakeMessage('admin-9', 'guild-1', { guildOwnerId: 'owner-123' });
    assert.equal(isAuthorizedActor(message, strictSettings).allowed, false);
});

test('per-guild owner from GUILD_CONFIG is authorized in their own guild only', () => {
    const settings = {
        serverOwnerId: 'owner-123',
        guildOwnerIds: new Map([['guild-2', 'guild2-owner']]),
        guildAdminRoleNames: new Map()
    };

    assert.equal(isAuthorizedActor(fakeMessage('guild2-owner', 'guild-2'), settings).allowed, true);
    // Same person has no power in another guild.
    assert.equal(isAuthorizedActor(fakeMessage('guild2-owner', 'guild-1'), settings).allowed, false);
});

test('per-guild admin role grants access, wrong role does not', () => {
    const settings = {
        serverOwnerId: 'owner-123',
        guildOwnerIds: new Map(),
        guildAdminRoleNames: new Map([['guild-3', ['ZiG Admin', 'Mods']]])
    };

    assert.equal(
        isAuthorizedActor(fakeMessage('member-7', 'guild-3', { roles: ['zig admin', 'Member'] }), settings).allowed,
        true
    );
    assert.equal(
        isAuthorizedActor(fakeMessage('member-8', 'guild-3', { roles: ['Member'] }), settings).allowed,
        false
    );
    // Admin role only applies in the guild that configured it.
    assert.equal(
        isAuthorizedActor(fakeMessage('member-7', 'guild-9', { roles: ['zig admin'] }), settings).allowed,
        false
    );
});

// ---------- Warn routing ----------

test('warn_member is destructive and list_warnings is not admin-gated', () => {
    assert.equal(destructiveActions.has('warn_member'), true);
    assert.equal(destructiveActions.has('list_warnings'), false);
});

test('list_warnings works without owner auth and reports storage state', async () => {
    const message = fakeMessage('random-user', 'guild-1');
    message.guild.members = {
        cache: {
            get: () => null,
            find: () => ({ id: 'target-1', displayName: 'Target' })
        }
    };

    const result = await executeTool(message, strictSettings, { action: 'list_warnings', target: 'Target' }, { warnStore: null });
    assert.match(result, /storage is not configured|could not find/);
});

// ---------- Slash command conversion ----------

test('slash commands map to canonical router actions', () => {
    assert.equal(slashActionByCommand.get('play'), 'play');
    assert.equal(slashActionByCommand.get('kick'), 'kick_member');
    assert.equal(slashActionByCommand.get('ban'), 'ban_member');
    assert.equal(slashActionByCommand.get('help'), 'bot_help');
});

test('interactionToIntent converts options into validated intent fields', async () => {
    const kickIntent = await interactionToIntent({
        commandName: 'kick',
        options: { getString: () => { throw new Error('not used'); }, getUser: () => ({ id: 'user-5' }) }
    });
    assert.equal(kickIntent.action, 'kick_member');
    assert.equal(kickIntent.target, '<@user-5>');

    const playIntent = await interactionToIntent({
        commandName: 'play',
        options: { getString: () => '  https://audio.example/song.mp3  ', getUser: () => null }
    });
    assert.equal(playIntent.action, 'play');
    assert.equal(playIntent.target, 'https://audio.example/song.mp3');

    assert.equal(await interactionToIntent({ commandName: 'nope', options: {} }), null);
});

test('voice route still blocks destructive actions after P3 changes', () => {
    const intent = buildVoiceTranscriptRoute(
        { author: { id: 'owner-123' }, guild: { ownerId: 'owner-123' } },
        'kick him',
        strictSettings,
        'bot-id'
    );
    assert.equal(intent.action, 'chat');
    assert.ok(intent.voiceNotice);
});
