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
        // memory_status and behavior_status intentionally have permission:
        // null — they are gated by owner/admin identity (isAuthorizedActor),
        // not a Discord permission.
        if (action !== 'memory_status' && action !== 'behavior_status') {
            assert.ok(entry.permission, `${action} must require a permission`);
        }
    }
});

test('read-only info action works without owner authorization', async () => {
    const message = fakeMessage({ author: { id: 'random-user' } });
    const result = await executeTool(message, settings, { action: 'get_server_info' });
    assert.match(result, /Members: 10/);
});

test('audit logging does not crash when message.client is missing (slash fakeMessage path)', async () => {
    // /memory via slash builds a fakeMessage WITHOUT message.client; with
    // LOG_CHANNEL_ID set, auditLog used to hit
    // "Cannot read properties of undefined (reading 'channels')".
    const message = fakeMessage({ author: { id: 'owner-123' } });
    assert.equal(message.client, undefined);
    const result = await executeTool(
        message,
        { ...settings, logChannelId: 'log-channel-1' },
        { action: 'memory_status' }
    );
    assert.match(result, /Memory diagnostics/);
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

test('voice "say" command routes the words verbatim', () => {
    const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
    const routeContext = { author: { id: 'user-1' }, guild: { ownerId: 'owner-123' } };

    for (const phrase of ['say hello everyone', 'zigbot say testing one two', 'bolo kya haal hai', "please say: it's a nice day"]) {
        const intent = buildVoiceTranscriptRoute(routeContext, phrase, settings, 'bot-id');
        assert.equal(intent.action, 'say', `expected say for "${phrase}"`);
        assert.ok(intent.message.length > 0, `expected words for "${phrase}"`);
    }
    assert.equal(buildVoiceTranscriptRoute(routeContext, 'say stop', settings, 'bot-id').message, 'stop');
    // anchored: mid-sentence "say" is not a command
    assert.equal(buildVoiceTranscriptRoute(routeContext, 'did you say something', settings, 'bot-id').action, 'chat');
});

test('say command is allowed from voice and blocked words are refused', async () => {
    const { buildVoiceTranscriptRoute } = require('../src/routing/voiceRoute');
    const routeContext = { author: { id: 'user-1' }, guild: { ownerId: 'owner-123' } };
    const intent = buildVoiceTranscriptRoute(routeContext, 'say hello there friends', settings, 'bot-id');
    assert.equal(intent.action, 'say');

    const { executeTool } = require('../src/tools/router');
    const message = fakeMessage({ author: { id: 'user-1' }, guild: { ownerId: 'owner-123', memberCount: 3, channels: { cache: { size: 2 } }, members: { me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } } } } });
    // Not connected to voice: clean refusal, no speak call.
    const result = await executeTool(message, settings, intent, { warnStore: null });
    assert.match(result, /need to be in a voice channel/);
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

    const song = buildVoiceTranscriptRoute(routeContext, 'hey zigbot play kesariya by arijit singh.', settings, 'bot-id');
    assert.equal(song.action, 'play');
    assert.equal(song.target, 'kesariya by arijit singh');

    const hinglish = buildVoiceTranscriptRoute(routeContext, 'kesariya bajao', settings, 'bot-id');
    assert.equal(hinglish.action, 'play');
    assert.equal(hinglish.target, 'kesariya');

    assert.notEqual(buildVoiceTranscriptRoute(routeContext, "let's play a game", settings, 'bot-id').action, 'play');

    const volume = buildVoiceTranscriptRoute(routeContext, 'set volume to 40', settings, 'bot-id');
    assert.equal(volume.action, 'volume_music');
    assert.equal(volume.volume, 40);
});

// ZIGBOT-001 regression. discord.js v14 channel.send() takes ONE argument;
// a second options argument is silently ignored, so allowedMentions must
// travel inside the payload object or @everyone/role pings go through.
test('send_message locks mentions down inside the single send() payload', async () => {
    const calls = [];
    const message = fakeMessage({ channel: { name: 'general', send: async (...args) => { calls.push(args); } } });
    const result = await executeTool(message, settings, { action: 'send_message', message: '@everyone <@&123456789012345678> hi <@234567890123456789>' });
    assert.match(result, /Message sent/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'send() must get exactly one argument (discord.js v14 ignores a second)');
    const payload = calls[0][0];
    assert.equal(typeof payload, 'object');
    assert.match(payload.content, /hi/);
    assert.deepEqual(payload.allowedMentions?.parse, ['users']);
});

// ---------------------------------------------------------------------------
// ZIGBOT-011 regression: role hierarchy of the PERSON ASKING.
// Discord lets anyone but the server owner act only on members and roles
// BELOW their own highest role. The bot must not lend its higher position.
// Multi-server mode: Administrator members are authorized actors.
const { PermissionFlagsBits: P } = require('discord.js');

class Coll extends Map {
    find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
    some(fn) { for (const v of this.values()) if (fn(v)) return true; return false; }
}

function hierarchyFixture() {
    const role = (id, name, position) => ({ id, name, position, managed: false, delete: async () => { calls.push(['deleteRole', id]); } });
    const calls = [];
    const roles = new Coll([
        ['900000000000000001', role('900000000000000001', 'Admin', 50)],
        ['900000000000000002', role('900000000000000002', 'Mod', 30)],
        ['900000000000000003', role('900000000000000003', 'Member', 10)]
    ]);
    const member = (id, name, highest) => ({
        id, displayName: name, user: { id, username: name, tag: name },
        kickable: true, bannable: true,
        roles: { highest: { position: highest }, cache: new Coll(), add: async (r) => calls.push(['add', id, r.id]), remove: async (r) => calls.push(['remove', id, r.id]) },
        permissions: { has: (perm) => perm === P.Administrator },
        kick: async () => calls.push(['kick', id]),
        ban: async () => calls.push(['ban', id]),
        timeout: async () => calls.push(['timeout', id])
    });
    const actor = member('100000000000000001', 'actor', 30); // highest role: Mod
    const members = new Coll([
        [actor.id, actor],
        ['100000000000000002', member('100000000000000002', 'boss', 50)],
        ['100000000000000003', member('100000000000000003', 'peer', 30)],
        ['100000000000000004', member('100000000000000004', 'newbie', 10)]
    ]);
    const guild = {
        id: '200000000000000001', ownerId: '100000000000000009', name: 'G', memberCount: 4,
        channels: { cache: { size: 1 } },
        roles: { cache: roles },
        members: { cache: members, me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } } }
    };
    const message = { author: { id: actor.id }, member: actor, guild, channel: { name: 'general', send: async () => {} } };
    const ctx = { mode: 'multi', guildId: guild.id, config: {}, roleMappings: [] };
    return { message, calls, settings: { serverOwnerId: 'someone-else', guildContext: ctx } };
}

for (const [action, extra] of [['kick_member', {}], ['ban_member', {}], ['timeout_member', { durationMinutes: 5 }]]) {
    test(`${action}: refuses a target at or above the requester's highest role`, async () => {
        const { message, calls, settings: s } = hierarchyFixture();
        for (const target of ['boss', 'peer']) {
            const result = await executeTool(message, s, { action, target, ...extra });
            assert.match(result, /higher than|same as|role hierarchy/i, `${target}: ${result}`);
        }
        assert.deepEqual(calls, []);
    });

    test(`${action}: still works on a member below the requester`, async () => {
        const { message, calls, settings: s } = hierarchyFixture();
        const result = await executeTool(message, s, { action, target: 'newbie', ...extra });
        assert.match(result, /✅/, result);
        assert.equal(calls.length, 1);
    });
}

test('add_role: cannot hand out a role at or above the requester\'s highest role', async () => {
    const { message, calls, settings: s } = hierarchyFixture();
    for (const role of ['Admin', 'Mod']) {
        const result = await executeTool(message, s, { action: 'add_role', target: 'actor', role });
        assert.match(result, /higher than|same as|role hierarchy/i, `${role}: ${result}`);
    }
    assert.deepEqual(calls, []);
    assert.match(await executeTool(message, s, { action: 'add_role', target: 'newbie', role: 'Member' }), /✅/);
});

test('remove_role and delete_role respect the requester\'s hierarchy', async () => {
    const { message, calls, settings: s } = hierarchyFixture();
    assert.match(await executeTool(message, s, { action: 'remove_role', target: 'boss', role: 'Admin' }), /higher than|same as|role hierarchy/i);
    assert.match(await executeTool(message, s, { action: 'delete_role', role: 'Admin' }), /higher than|same as|role hierarchy/i);
    assert.deepEqual(calls, []);
    assert.match(await executeTool(message, s, { action: 'delete_role', role: 'Member' }), /✅/);
});

test('the real server owner is not limited by role hierarchy', async () => {
    const { message, calls, settings: s } = hierarchyFixture();
    message.guild.ownerId = message.author.id;
    assert.match(await executeTool(message, s, { action: 'kick_member', target: 'boss' }), /✅/);
    assert.match(await executeTool(message, s, { action: 'add_role', target: 'actor', role: 'Admin' }), /✅/);
    assert.equal(calls.length, 2);
});

test('nobody but the owner can act on the server owner', async () => {
    const { message, calls, settings: s } = hierarchyFixture();
    message.guild.ownerId = '100000000000000004'; // newbie owns the server
    assert.match(await executeTool(message, s, { action: 'kick_member', target: 'newbie' }), /server owner/i);
    assert.deepEqual(calls, []);
});
