const test = require('node:test');
const assert = require('node:assert/strict');
const { createPunishmentExpiryService } = require('../src/moderation/expiry');

test('persisted temporary bans are unbanned after expiry and completed once after restart', async () => {
    const due = [{
        id: 'ban-1',
        guildId: 'guild-1',
        userId: 'user-1',
        type: 'ban',
        expiresAt: 1000
    }];
    const completed = [];
    const calls = [];
    const service = createPunishmentExpiryService({
        now: () => 1001,
        store: {
            async listDueTemporaryPunishments() { return due; },
            async completeTemporaryPunishment(guildId, id) { completed.push([guildId, id]); }
        },
        client: {
            guilds: {
                cache: new Map([['guild-1', {
                    members: { async unban(userId, reason) { calls.push([userId, reason]); } }
                }]])
            }
        },
        logger: { error() {} }
    });
    await service.runOnce();
    await service.runOnce();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'user-1');
    assert.deepEqual(completed, [['guild-1', 'ban-1']]);
});

test('expired temporary timeouts are cleared through Discord after process restart', async () => {
    const calls = [];
    const service = createPunishmentExpiryService({
        now: () => 2000,
        store: {
            async listDueTemporaryPunishments() {
                return [{ id: 'timeout-1', guildId: 'guild-2', userId: 'user-2', type: 'timeout', expiresAt: 1999 }];
            },
            async completeTemporaryPunishment() {}
        },
        client: {
            guilds: {
                cache: new Map([['guild-2', {
                    members: {
                        cache: new Map([['user-2', { async timeout(duration) { calls.push(duration); } }]])
                    }
                }]])
            }
        },
        logger: { error() {} }
    });
    await service.runOnce();
    assert.deepEqual(calls, [null]);
});
