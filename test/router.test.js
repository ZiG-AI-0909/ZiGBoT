const test = require('node:test');
const assert = require('node:assert/strict');

const {
    executeTool,
    adminActions,
    destructiveActions,
    actionCatalog,
    normalizeAction
} = require('../src/tools/router');

// Minimal stand-ins for discord.js objects. Only the fields the router reads.
function fakeMessage(overrides = {}) {
    return {
        author: { id: 'owner-123' },
        channel: { name: 'general', send: async () => {} },
        guild: {
            ownerId: 'owner-123',
            memberCount: 10,
            channels: { cache: { size: 5 } },
            members: { me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } } }
        },
        ...overrides
    };
}

const settings = { serverOwnerId: 'owner-123' };

test('non-owner cannot trigger an admin action', async () => {
    const message = fakeMessage({ author: { id: 'random-user' }, guild: { ownerId: 'owner-123', members: fakeMessage().guild.members } });
    const result = await executeTool(message, settings, { action: 'kick_member', target: 'someone' });
    assert.match(result, /Only the server owner/);
});

test('destructive action set includes every punitive action', () => {
    for (const action of ['kick_member', 'ban_member', 'delete_role', 'remove_role', 'delete_channel', 'timeout_member', 'delete_messages', 'unban_member']) {
        assert.equal(destructiveActions.has(action), true, `${action} must be destructive`);
    }
    assert.equal(destructiveActions.has('send_message'), false);
    assert.equal(destructiveActions.has('play'), false);
});

test('every admin action has a permission entry in the catalog', () => {
    for (const action of adminActions) {
        const entry = actionCatalog.get(action);
        assert.ok(entry, `${action} missing from catalog`);
        assert.ok(entry.permission, `${action} must require a permission`);
    }
});

test('read-only info action works without owner authorization', async () => {
    const message = fakeMessage({ author: { id: 'random-user' } });
    const result = await executeTool(message, settings, { action: 'get_server_info' });
    assert.match(result, /Members: 10/);
});

test('music and help actions work without owner authorization', async () => {
    const message = fakeMessage({ author: { id: 'random-user' } });
    assert.doesNotMatch(await executeTool(message, settings, { action: 'queue_music' }), /Only the server owner/);
    assert.match(await executeTool(message, settings, { action: 'bot_help' }), /ZiGBoT actions/);
});

test('normalizeAction canonicalizes aliases and rejects unknown actions', () => {
    assert.equal(normalizeAction('Kick'), 'kick_member');
    assert.equal(normalizeAction('ban'), 'ban_member');
    assert.equal(normalizeAction('play_music'), 'play');
    assert.equal(normalizeAction('Now-Playing'), 'now_playing');
    assert.equal(normalizeAction('help'), 'bot_help');
    assert.equal(normalizeAction('shutdown_the_server'), null);
    assert.equal(normalizeAction(undefined), null);
});

test('bot cannot manage a role at or above its highest role', async () => {
    const message = fakeMessage({
        author: { id: 'owner-123' },
        guild: {
            ownerId: 'owner-123',
            roles: {
                cache: {
                    get: () => null,
                    find: (fn) => {
                        const role = { name: 'Owner Role', position: 100, managed: false };
                        return fn(role) ? role : null;
                    }
                }
            },
            members: {
                me: {
                    permissions: { has: () => true },
                    roles: { highest: { position: 50 } }
                }
            }
        }
    });
    const result = await executeTool(message, settings, { action: 'delete_role', target: 'Owner Role' });
    assert.match(result, /cannot manage that role/);
});

test('voice path blocks destructive actions', () => {
    const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
    const routeContext = { author: { id: 'owner-123' }, guild: { ownerId: 'owner-123' } };

    const kick = buildVoiceTranscriptRoute(routeContext, 'kick him from the server', settings, 'bot-id');
    assert.equal(kick.action, 'chat');
    assert.ok(kick.voiceNotice);

    const ban = buildVoiceTranscriptRoute(routeContext, 'ban that guy', settings, 'bot-id');
    assert.equal(ban.action, 'chat');
    assert.ok(ban.voiceNotice);
});

test('voice path allows playback and info commands', () => {
    const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
    const routeContext = { author: { id: 'owner-123' }, guild: { ownerId: 'owner-123' } };

    assert.equal(buildVoiceTranscriptRoute(routeContext, 'pause the music', settings, 'bot-id').action, 'pause_music');
    assert.equal(buildVoiceTranscriptRoute(routeContext, 'skip this track', settings, 'bot-id').action, 'skip_music');
    assert.equal(buildVoiceTranscriptRoute(routeContext, 'what can you do', settings, 'bot-id').action, 'bot_help');

    const play = buildVoiceTranscriptRoute(
        routeContext,
        'play https://audio.example/track.mp3',
        settings,
        'bot-id'
    );
    assert.equal(play.action, 'play');
    assert.equal(play.target, 'https://audio.example/track.mp3');

    const volume = buildVoiceTranscriptRoute(routeContext, 'set volume to 40', settings, 'bot-id');
    assert.equal(volume.action, 'volume_music');
    assert.equal(volume.volume, 40);
});
