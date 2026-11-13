const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { executeTool, actionCatalog } = require('../src/tools/router');
const { classifyIntent } = require('../src/ai/client');

const USER_ID = '111111111111111111';
const GUILD_ID = '999999999999999999';

function fixture({ memberOverrides = {}, clientOverrides = {} } = {}) {
    const user = {
        id: USER_ID,
        username: 'test-user',
        createdTimestamp: 1_700_000_000_000,
        banner: null,
        bannerURL: () => null,
        ...memberOverrides.user
    };
    const member = {
        id: USER_ID,
        displayName: 'Test User',
        joinedTimestamp: 1_710_000_000_000,
        permissions: { toArray: () => ['ViewChannel', 'SendMessages'] },
        ...memberOverrides,
        user
    };
    const guild = {
        id: GUILD_ID,
        name: 'Test Guild',
        memberCount: 12,
        createdTimestamp: 1_600_000_000_000,
        channels: { cache: { size: 4 } },
        members: { cache: new Map([[USER_ID, member]]) }
    };
    const client = {
        user: { id: '222222222222222222', username: 'ZiGBoT', tag: 'ZiGBoT#0001' },
        uptime: 3_661_000,
        ws: { ping: 42 },
        guilds: { cache: new Map([[GUILD_ID, guild], ['888888888888888888', {}]]) },
        users: { fetch: async (id) => id === USER_ID ? user : null },
        ...clientOverrides
    };
    const message = {
        author: { id: '333333333333333333' },
        member: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
        channel: { id: 'channel-1' },
        guild,
        client
    };
    return { message, member, user, client, settings: { serverOwnerId: 'owner-1' } };
}

test('member information returns display name, ID, and join date', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_info',
        target: USER_ID
    });
    assert.match(result, /\*\*Test User\*\*/);
    assert.match(result, new RegExp(`ID: ${USER_ID}`));
    assert.match(result, /Joined: <t:1710000000:D>/);
});

test('member join date uses the exact Discord joined timestamp', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_info',
        target: USER_ID
    });
    assert.ok(result.includes(`<t:${Math.floor(f.member.joinedTimestamp / 1000)}:D>`));
});

test('member profile includes account creation date and fetched banner URL', async () => {
    const f = fixture({
        clientOverrides: {
            users: {
                fetch: async (id, options) => {
                    assert.equal(id, USER_ID);
                    assert.deepEqual(options, { force: true });
                    return {
                        banner: 'banner-hash',
                        bannerURL: ({ size }) => `https://cdn.discordapp.com/banners/${USER_ID}/banner-hash.webp?size=${size}`
                    };
                }
            }
        }
    });
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_profile',
        target: USER_ID
    });
    assert.match(result, /Account created: <t:1700000000:D>/);
    assert.match(result, new RegExp(`https://cdn\\.discordapp\\.com/banners/${USER_ID}/banner-hash\\.webp\\?size=1024`));
});

test('member profile reports when no banner is set', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_profile',
        target: USER_ID
    });
    assert.match(result, /No banner is set/);
});

test('member profile reports banner lookup failures explicitly', async () => {
    const f = fixture({
        clientOverrides: { users: { fetch: async () => { throw new Error('Discord unavailable'); } } }
    });
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_profile',
        target: USER_ID
    });
    assert.match(result, /Banner lookup failed/);
});

test('member permissions reports effective server permissions', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, {
        action: 'get_member_permissions',
        target: USER_ID
    });
    assert.match(result, /ViewChannel/);
    assert.match(result, /SendMessages/);
});

test('bot information reports identity, uptime, server count, and gateway ping', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, { action: 'get_bot_info' });
    assert.match(result, /ZiGBoT/);
    assert.match(result, /222222222222222222/);
    assert.match(result, /Servers: 2/);
    assert.match(result, /Uptime: 1 hour 1 minute/);
    assert.match(result, /Gateway ping: 42 ms/);
});

test('intent schema exposes the new utility actions', async () => {
    let request;
    const ai = {
        chat: {
            completions: {
                create: async (value) => {
                    request = value;
                    return { choices: [{ message: { content: JSON.stringify({
                        action: 'get_bot_info',
                        target: null,
                        role: null,
                        channel: null,
                        message: null,
                        reason: null,
                        count: null,
                        durationMinutes: null,
                        volume: null
                    }) } }] };
                }
            }
        }
    };
    const intent = await classifyIntent(ai, 'test-model', 'show me bot info');
    assert.equal(intent.action, 'get_bot_info');
    for (const action of ['get_bot_info', 'get_member_profile', 'get_member_permissions']) {
        assert.equal(actionCatalog.has(action), true);
        assert.ok(request.response_format.json_schema.schema.properties.action.enum.includes(action));
    }
});

test('configured custom utility commands respond only to exact prefix invocations without pinging', async () => {
    const { createCustomUtilityCommandHandler } = require('../src/utilities/customCommands');
    const handler = createCustomUtilityCommandHandler({ logger: { error() {} } });
    const replies = [];
    const message = {
        content: '!rules',
        author: { id: '333333333333333333', bot: false },
        guild: { id: GUILD_ID },
        reply: async (payload) => replies.push(payload)
    };
    assert.equal(await handler.handle(message, []), false);
    assert.equal(await handler.handle(message, [{ name: 'rules', response: 'Read #rules @everyone' }]), true);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, 'Read #rules @everyone');
    assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
    message.content = '!rules extra';
    assert.equal(await handler.handle(message, [{ name: 'rules', response: 'Read #rules' }]), false);
});

test('custom utility commands use the existing message listener after AFK and avatar handling', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    assert.equal((source.match(/client\.on\(Events\.MessageCreate/g) || []).length, 1);
    const afk = source.indexOf('if ((await afkHandler.handle(message)).handled) return;');
    const avatar = source.indexOf('if (await avatarHandler.handle(message)) return;');
    const utility = source.indexOf('if (await utilityCommandHandler.handle(message, guildCtx?.config?.utility_commands || [])) return;');
    assert.ok(afk >= 0 && avatar > afk && utility > avatar);
});

test('custom utility reply errors are logged and do not fall through into AI chat', async () => {
    const errors = [];
    const { createCustomUtilityCommandHandler } = require('../src/utilities/customCommands');
    const handler = createCustomUtilityCommandHandler({ logger: { error: (error) => errors.push(error) } });
    const message = {
        content: '!rules',
        author: { id: '333333333333333333', bot: false },
        guild: { id: GUILD_ID },
        reply: async () => { throw new Error('Missing Permissions'); }
    };
    assert.equal(await handler.handle(message, [{ name: 'rules', response: 'Read #rules' }]), true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Missing Permissions/);
});
