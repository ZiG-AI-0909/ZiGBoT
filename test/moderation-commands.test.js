const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { buildDefinitions } = require('../src/slash');
const { createModerationCommands } = require('../src/moderation/commands');

function interaction({ command = 'appeal', subcommand = 'submit', mod = false, options = {} } = {}) {
    const replies = [];
    return {
        commandName: command,
        guildId: 'guild-1',
        guild: { id: 'guild-1' },
        user: { id: 'member-1' },
        memberPermissions: { has: (permission) => mod && [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.Administrator].includes(permission) },
        options: {
            getSubcommand: () => subcommand,
            getString: (name) => options[name] ?? null
        },
        async reply(payload) { replies.push(payload); },
        replies
    };
}

test('Section A adds one appeal intake and one moderation case/review command without duplicate names', () => {
    const definitions = buildDefinitions().map((definition) => typeof definition.toJSON === 'function' ? definition.toJSON() : definition);
    const names = definitions.map((definition) => definition.name);
    assert.equal(names.filter((name) => name === 'appeal').length, 1);
    assert.equal(names.filter((name) => name === 'moderation').length, 1);
    assert.ok(definitions.find((definition) => definition.name === 'appeal').options.some((option) => option.name === 'submit'));
    assert.deepEqual(
        definitions.find((definition) => definition.name === 'moderation').options.map((option) => option.name),
        ['logs', 'case', 'review']
    );
});

test('/appeal is disabled by default and creates a guild-scoped appeal when enabled', async () => {
    let writes = 0;
    let appealsEnabled = false;
    const store = {
        async createModerationAppeal(guildId, caseId, userId, reason) {
            writes += 1;
            return { id: 8, guildId, caseId, userId, reason };
        }
    };
    const commands = createModerationCommands({
        store,
        getGuildConfig: async () => ({ moderation_appeals_enabled: appealsEnabled }),
        auditLog: async () => {}
    });
    const disabled = interaction({ options: { case: '4', reason: 'I disagree' } });
    await commands.handleAppeal(disabled);
    assert.match(disabled.replies[0].content, /disabled/i);
    assert.equal(writes, 0);

    appealsEnabled = true;
    const enabled = interaction({ options: { case: '4', reason: 'I disagree' } });
    await commands.handleAppeal(enabled);
    assert.match(enabled.replies[0].content, /appeal #8/i);
    assert.equal(writes, 1);
});

test('/moderation case review is permission-gated, guild-scoped, and audited', async () => {
    const audits = [];
    const store = {
        async getModerationCase(guildId, caseId) { return { id: Number(caseId), guildId, action: 'warn_member' }; },
        async listModerationCases() { return [{ id: 1, action: 'warn_member' }]; },
        async reviewModerationAppeal(guildId, appealId, reviewerId, decision, note) {
            return { id: Number(appealId), guildId, reviewerId, decision, note };
        }
    };
    const commands = createModerationCommands({
        store,
        getGuildConfig: async () => ({ moderation_appeals_enabled: true }),
        auditLog: async (entry) => audits.push(entry)
    });
    const denied = interaction({ command: 'moderation', subcommand: 'logs', mod: false });
    await commands.handleModeration(denied);
    assert.match(denied.replies[0].content, /permission/i);

    const reviewed = interaction({
        command: 'moderation',
        subcommand: 'review',
        mod: true,
        options: { appeal: '8', decision: 'reject', note: 'insufficient detail' }
    });
    await commands.handleModeration(reviewed);
    assert.match(reviewed.replies[0].content, /reviewed/i);
    assert.equal(audits.length, 1);
});
