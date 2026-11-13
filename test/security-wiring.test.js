const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSecurityEventHandlers } = require('../src/security/eventHandlers');

class FakeClient {
    constructor() {
        this.handlers = new Map();
    }

    on(event, handler) {
        const listeners = this.handlers.get(event) || [];
        listeners.push(handler);
        this.handlers.set(event, listeners);
    }

    async dispatch(event, payload) {
        await Promise.all((this.handlers.get(event) || []).map((handler) => handler(payload)));
    }
}

test('one message and one join event invoke their security evaluator once', async () => {
    const calls = { message: [], join: [] };
    const integration = {
        evaluateMessage: async (message) => calls.message.push(message.id),
        evaluateGuildMemberAdd: async (member) => calls.join.push(member.id)
    };
    const handlers = createSecurityEventHandlers(integration);
    const client = new FakeClient();
    client.on('messageCreate', handlers.messageCreate);
    client.on('guildMemberAdd', handlers.guildMemberAdd);

    await client.dispatch('messageCreate', { id: 'm-1' });
    await client.dispatch('guildMemberAdd', { id: 'u-1' });

    assert.deepEqual(calls, { message: ['m-1'], join: ['u-1'] });
});

test('the live bot has one security dispatch point and integration does not self-register', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
    const integration = fs.readFileSync(path.join(root, 'src/security/integration.js'), 'utf8');

    assert.doesNotMatch(index, /securityIntegration\.register\s*\(/);
    assert.equal((index.match(/securityEventHandlers\.messageCreate\s*\(/g) || []).length, 1);
    assert.equal((index.match(/securityEventHandlers\.guildMemberAdd\s*\(/g) || []).length, 1);
    assert.match(index, /client\.on\(Events\.ChannelDelete,\s*securityEventHandlers\.channelDelete\)/);
    assert.match(index, /client\.on\(Events\.GuildRoleDelete,\s*securityEventHandlers\.roleDelete\)/);
    assert.match(index, /client\.on\(Events\.GuildBanAdd,\s*securityEventHandlers\.guildBanAdd\)/);
    assert.match(index, /client\.on\(Events\.WebhooksUpdate,\s*securityEventHandlers\.webhookUpdate\)/);
    assert.doesNotMatch(integration, /client(?:Instance)?\.on\s*\(/);
});
