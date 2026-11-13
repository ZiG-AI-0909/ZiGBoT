const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const { executeTool, actionCatalog, destructiveActions } = require('../src/tools/router');

function fixture({ config = {}, botHas = () => true, targetOverrides = {} } = {}) {
    const calls = [];
    const makeCache = (entries = []) => {
        const cache = new Map(entries);
        cache.find = (callback) => [...cache.values()].find(callback);
        return cache;
    };
    const target = {
        id: 'target-1',
        displayName: 'Target',
        user: { id: 'target-1', username: 'Target', tag: 'Target' },
        roles: { highest: { position: 1 } },
        moderatable: true,
        bannable: true,
        kickable: true,
        manageable: true,
        async timeout(duration) { calls.push(['timeout', duration]); },
        async ban(options) { calls.push(['ban', options]); },
        async setNickname(value) { calls.push(['nickname', value]); },
        ...targetOverrides
    };
    const memberCache = makeCache([[target.id, target]]);
    const guild = {
        id: 'guild-1',
        ownerId: 'owner-1',
        roles: { everyone: { id: 'guild-1' } },
        members: {
            cache: memberCache,
            me: {
                permissions: { has: botHas },
                roles: { highest: { position: 10 } }
            },
            async unban(id, reason) { calls.push(['unban', id, reason]); }
        },
        channels: { cache: makeCache() }
    };
    const channel = {
        id: 'channel-1',
        name: 'general',
        isTextBased: () => true,
        permissionOverwrites: {
            async edit(role, permissions) { calls.push(['overwrite', role.id, permissions]); }
        },
        async setRateLimitPerUser(seconds) { calls.push(['slowmode', seconds]); },
        async bulkDelete(count, filterOld) {
            calls.push(['purge', count, filterOld]);
            return { size: count };
        }
    };
    guild.channels.cache.set(channel.id, channel);
    const auditRows = [];
    const message = {
        author: { id: 'owner-1' },
        member: { roles: { highest: { position: 10 } } },
        guild,
        channel,
        client: {
            channels: {
                async fetch() {
                    return { guildId: guild.id, isTextBased: () => true, async send(entry) { auditRows.push(entry); } };
                }
            }
        }
    };
    const records = [];
    const moderationStore = {
        async createModerationCase(guildId, record) {
            records.push({ guildId, ...record });
            return { id: records.length };
        },
        async addTemporaryPunishment(record) {
            calls.push(['persist', record.type, record.userId, record.expiresAt]);
            return { id: 'punishment-1' };
        },
        async deleteTemporaryPunishment(guildId, id) {
            calls.push(['cancel-punishment', guildId, id]);
        }
    };
    return {
        calls,
        target,
        guild,
        channel,
        message,
        records,
        auditRows,
        moderationStore,
        settings: {
            serverOwnerId: 'owner-1',
            logChannelId: 'log-1',
            guildContext: { mode: 'multi', guildId: 'guild-1', config, mappings: [] }
        }
    };
}

test('existing ban, unban, and purge actions still call Discord with their original arguments', async () => {
    const f = fixture();
    const context = { moderationStore: f.moderationStore };
    assert.match(await executeTool(f.message, f.settings, { action: 'ban_member', target: 'Target' }, context), /Banned Target/);
    assert.match(await executeTool(f.message, f.settings, { action: 'unban_member', target: '12345678901234567' }, context), /Unbanned/);
    assert.match(await executeTool(f.message, f.settings, { action: 'delete_messages', count: 4 }, context), /Deleted 4 messages/);
    assert.ok(f.calls.some(([name]) => name === 'ban'));
    assert.ok(f.calls.some(([name, id]) => name === 'unban' && id === '12345678901234567'));
    assert.ok(f.calls.some(([name, count, filterOld]) => name === 'purge' && count === 4 && filterOld === true));
    assert.deepEqual(f.records.map((record) => record.action), ['ban_member', 'unban_member', 'delete_messages']);
    assert.ok(f.auditRows.some((entry) => entry.includes('ADMIN ACTION') && entry.includes('delete_messages')));
});

test('every Section A moderation action has an explicit permission and punitive actions remain confirmed', () => {
    for (const action of [
        'untimeout_member', 'set_slowmode', 'lock_channel', 'unlock_channel',
        'set_nickname', 'temp_ban_member'
    ]) {
        assert.ok(actionCatalog.get(action)?.permission, `${action} must require a Discord permission`);
    }
    for (const action of ['untimeout_member', 'temp_ban_member']) {
        assert.equal(destructiveActions.has(action), true, `${action} must require confirmation`);
    }
});

test('untimeout checks hierarchy and clears the Discord timeout', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, { action: 'untimeout_member', target: 'Target' }, { moderationStore: f.moderationStore });
    assert.match(result, /untimeout|removed.*timeout/i);
    assert.ok(f.calls.some(([name, duration]) => name === 'timeout' && duration === null));
});

test('existing timeout keeps its response and persists its expiry before calling Discord', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, {
        action: 'timeout_member', target: 'Target', durationMinutes: 5
    }, { moderationStore: f.moderationStore });
    assert.equal(result, '✅ Timed out Target for 5 minutes.');
    const persistIndex = f.calls.findIndex(([name, type]) => name === 'persist' && type === 'timeout');
    const discordIndex = f.calls.findIndex(([name]) => name === 'timeout');
    assert.ok(persistIndex >= 0);
    assert.ok(discordIndex >= 0);
    assert.ok(persistIndex < discordIndex);
});

test('slowmode and channel lock actions update only the requested channel controls', async () => {
    const f = fixture();
    assert.match(await executeTool(f.message, f.settings, { action: 'set_slowmode', channel: 'general', durationSeconds: 30 }, { moderationStore: f.moderationStore }), /slowmode/i);
    assert.match(await executeTool(f.message, f.settings, { action: 'lock_channel', channel: 'general' }, { moderationStore: f.moderationStore }), /locked/i);
    assert.match(await executeTool(f.message, f.settings, { action: 'unlock_channel', channel: 'general' }, { moderationStore: f.moderationStore }), /unlocked/i);
    assert.ok(f.calls.some(([name, seconds]) => name === 'slowmode' && seconds === 30));
    assert.ok(f.calls.some(([name, roleId, permissions]) => name === 'overwrite' && roleId === 'guild-1' && permissions.SendMessages === false));
    assert.ok(f.calls.some(([name, roleId, permissions]) => name === 'overwrite' && roleId === 'guild-1' && permissions.SendMessages === null));
});

test('nickname management checks manageable target and sets the requested nickname', async () => {
    const f = fixture();
    const result = await executeTool(f.message, f.settings, { action: 'set_nickname', target: 'Target', nickname: 'New Name' }, { moderationStore: f.moderationStore });
    assert.match(result, /nickname/i);
    assert.ok(f.calls.some(([name, nickname]) => name === 'nickname' && nickname === 'New Name'));
});

test('warning escalation is opt-in and applies the configured third-warning timeout', async () => {
    const f = fixture({ config: { warning_escalation_enabled: true } });
    const warnStore = {
        async addWarning() { return { id: 3 }; },
        async countWarnings() { return 3; }
    };
    await executeTool(f.message, f.settings, { action: 'warn_member', target: 'Target', reason: 'repeat spam' }, {
        warnStore,
        moderationStore: f.moderationStore
    });
    assert.ok(f.calls.some(([name, duration]) => name === 'timeout' && duration === 10 * 60 * 1000));

    const disabled = fixture({ config: { warning_escalation_enabled: false } });
    await executeTool(disabled.message, disabled.settings, { action: 'warn_member', target: 'Target', reason: 'manual warning' }, {
        warnStore,
        moderationStore: disabled.moderationStore
    });
    assert.equal(disabled.calls.some(([name]) => name === 'timeout'), false);
});

test('temporary ban is off unless enabled and persists its expiry before banning', async () => {
    const disabled = fixture();
    const refusal = await executeTool(disabled.message, disabled.settings, {
        action: 'temp_ban_member', target: 'Target', durationMinutes: 60
    }, { moderationStore: disabled.moderationStore });
    assert.match(refusal, /disabled|enable/i);
    assert.equal(disabled.calls.some(([name]) => name === 'ban'), false);

    const enabled = fixture({ config: { temporary_bans_enabled: true } });
    const result = await executeTool(enabled.message, enabled.settings, {
        action: 'temp_ban_member', target: 'Target', durationMinutes: 60
    }, { moderationStore: enabled.moderationStore });
    assert.match(result, /temporar/i);
    const persistIndex = enabled.calls.findIndex(([name]) => name === 'persist');
    const banIndex = enabled.calls.findIndex(([name]) => name === 'ban');
    assert.ok(persistIndex >= 0);
    assert.ok(banIndex >= 0);
    assert.ok(persistIndex < banIndex);
});

test('missing bot permission prevents a moderation mutation and hierarchy is enforced', async () => {
    const missingPermission = fixture({ botHas: () => false });
    const denied = await executeTool(missingPermission.message, missingPermission.settings, {
        action: 'set_slowmode', channel: 'general', durationSeconds: 10
    }, { moderationStore: missingPermission.moderationStore });
    assert.match(denied, /permission/i);
    assert.equal(missingPermission.calls.some(([name]) => name === 'slowmode'), false);

    const missingActorPermission = fixture();
    missingActorPermission.message.author.id = 'moderator-1';
    missingActorPermission.message.guild.ownerId = 'owner-1';
    missingActorPermission.message.member = {
        permissions: { has: () => false },
        roles: {
            highest: { position: 10 },
            cache: new Map([['moderator-role', { id: 'moderator-role', position: 10 }]])
        }
    };
    missingActorPermission.settings.guildContext.mappings = [{
        role_id: 'moderator-role',
        tier: 'moderator',
        priority: 1,
        allowed_features: ['moderation'],
        denied_features: []
    }];
    const actorDenied = await executeTool(missingActorPermission.message, missingActorPermission.settings, {
        action: 'set_slowmode', channel: 'general', durationSeconds: 10
    }, { moderationStore: missingActorPermission.moderationStore });
    assert.match(actorDenied, /permission/i);
    assert.equal(missingActorPermission.calls.some(([name]) => name === 'slowmode'), false);

    const outranked = fixture({ targetOverrides: { roles: { highest: { position: 20 } } } });
    outranked.message.author.id = 'moderator-1';
    outranked.message.guild.ownerId = 'owner-1';
    outranked.settings.guildOwnerIds = new Map();
    outranked.settings.guildContext.mappings = [{
        role_id: 'moderator-role',
        tier: 'moderator',
        priority: 1,
        allowed_features: ['moderation'],
        denied_features: []
    }];
    outranked.message.member = {
        permissions: { has: (permission) => permission === PermissionFlagsBits.ModerateMembers },
        roles: {
            highest: { position: 10 },
            cache: new Map([['moderator-role', { id: 'moderator-role', position: 10 }]])
        }
    };
    const hierarchyResult = await executeTool(outranked.message, outranked.settings, {
        action: 'untimeout_member', target: 'Target'
    }, { moderationStore: outranked.moderationStore });
    assert.match(hierarchyResult, /higher than yours|role hierarchy/i);
    assert.equal(outranked.calls.some(([name]) => name === 'timeout'), false);
});
