const test = require('node:test');
const assert = require('node:assert/strict');

const { registerSlashCommands, YOUTUBE_COMMANDS } = require('../src/slash');

// Fake client: records what gets registered globally and per guild.
function fakeClient(guilds) {
    const registered = { global: null, guilds: {} };
    const guildMap = new Map(guilds.map((guild) => [guild.id, {
        ...guild,
        commands: { set: async (json) => { registered.guilds[guild.id] = json.map((c) => c.name); } }
    }]));
    return {
        registered,
        guilds: { cache: guildMap },
        application: { commands: { set: async (json) => { registered.global = json.map((c) => c.name); } } }
    };
}

const settings = { serverOwnerId: '111111111111111111', homeGuildIds: [], slashCommandGuildIds: [] };
const home = { id: '222222222222222222', ownerId: '111111111111111111' };
const other = { id: '333333333333333333', ownerId: '444444444444444444' };

test('YouTube slash commands are never registered globally or in other servers', async () => {
    const client = fakeClient([home, other]);
    await registerSlashCommands(client, settings);
    assert.ok(client.registered.global.includes('help'));
    assert.ok(client.registered.global.every((name) => !YOUTUBE_COMMANDS.has(name)));
    assert.deepEqual(new Set(client.registered.guilds[home.id]), YOUTUBE_COMMANDS);
    assert.equal(client.registered.guilds[other.id], undefined);
});

test('per-guild registration only includes YouTube commands for home servers', async () => {
    const client = fakeClient([home, other]);
    await registerSlashCommands(client, { ...settings, slashCommandGuildIds: [home.id, other.id] });
    assert.ok(client.registered.guilds[home.id].includes('ytstatus'));
    assert.ok(client.registered.guilds[home.id].includes('help'));
    assert.ok(client.registered.guilds[other.id].includes('help'));
    assert.ok(client.registered.guilds[other.id].every((name) => !YOUTUBE_COMMANDS.has(name)));
});
