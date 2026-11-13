const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultGuildConfig, validateGuildConfig, sanitizeStoredConfig } = require('../dashboard/lib/shared');

test('new per-server moderation behavior defaults off and validates explicit opt-ins', () => {
    const defaults = defaultGuildConfig({ guildId: '12345678901234567' });
    for (const key of [
        'warning_escalation_enabled',
        'temporary_bans_enabled',
        'moderation_spam_filter_enabled',
        'moderation_caps_filter_enabled',
        'moderation_mentions_filter_enabled',
        'moderation_invites_filter_enabled',
        'moderation_word_filter_enabled',
        'moderation_appeals_enabled'
    ]) {
        assert.equal(defaults[key], false, `${key} must be off by default`);
    }

    const result = validateGuildConfig({
        ...defaults,
        warning_escalation_enabled: true,
        moderation_invites_filter_enabled: true,
        moderation_word_filter_enabled: true,
        moderation_filtered_words: 'forbiddenword\notherword',
        moderation_appeals_enabled: true
    }, { guildId: '12345678901234567' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.value.warning_escalation_enabled, true);
    assert.equal(result.value.moderation_filtered_words, 'forbiddenword\notherword');
});

test('stored moderation settings are sanitized without enabling malformed values', () => {
    const config = sanitizeStoredConfig({
        warning_escalation_enabled: 'true',
        moderation_invites_filter_enabled: true,
        moderation_filtered_words: 'https://example.test\nword'
    }, { guildId: '12345678901234567' });
    assert.equal(config.warning_escalation_enabled, false);
    assert.equal(config.moderation_invites_filter_enabled, true);
    assert.equal(config.moderation_filtered_words, 'https://example.test\nword');
});
