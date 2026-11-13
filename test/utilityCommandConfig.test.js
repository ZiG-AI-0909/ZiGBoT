const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { defaultGuildConfig, validateGuildConfig, sanitizeStoredConfig } = require('../dashboard/lib/shared');

test('custom utility commands default to none and validate unique safe names and bounded replies', () => {
    const defaults = defaultGuildConfig({ guildId: '12345678901234567' });
    assert.deepEqual(defaults.utility_commands, []);

    const valid = validateGuildConfig({
        ...defaults,
        utility_commands: [
            { name: 'rules', response: 'Read #rules.' },
            { name: 'server-info', response: 'Ask me for server information.' }
        ]
    }, { guildId: '12345678901234567' });
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.value.utility_commands, [
        { name: 'rules', response: 'Read #rules.' },
        { name: 'server-info', response: 'Ask me for server information.' }
    ]);

    const duplicate = validateGuildConfig({
        utility_commands: [
            { name: 'rules', response: 'one' },
            { name: 'RULES', response: 'two' }
        ]
    }, { guildId: '12345678901234567' });
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.errors.utility_commands);
});

test('custom utility command validation rejects malformed entries and sanitization drops bad stored data', () => {
    const malformed = validateGuildConfig({
        utility_commands: [{ name: 'not a command!', response: 'x'.repeat(1901) }]
    }, { guildId: '12345678901234567' });
    assert.equal(malformed.ok, false);
    assert.ok(malformed.errors.utility_commands);

    const sanitized = sanitizeStoredConfig({
        guild_id: '12345678901234567',
        utility_commands: [{ name: 'bad name', response: 'unsafe' }]
    }, { guildId: '12345678901234567' });
    assert.deepEqual(sanitized.utility_commands, []);
});

test('guild editor exposes a saved Utilities tab for custom commands', () => {
    const source = fs.readFileSync(path.join(__dirname, '../dashboard/components/GuildEditor.js'), 'utf8');
    assert.match(source, /\{ id: 'utilities', label: 'Utilities' \}/);
    assert.match(source, /tab === 'utilities' \? <UtilitiesTab/);
    assert.match(source, /set\('utility_commands'\)/);
});
