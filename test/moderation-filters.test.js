const test = require('node:test');
const assert = require('node:assert/strict');
const { createModerationFilterEngine } = require('../src/moderation/messageFilters');

function message(content, overrides = {}) {
    let deletions = 0;
    const auditEntries = [];
    const guild = {
        id: 'guild-1',
        members: {
            me: {
                permissions: { has: () => true },
                roles: { highest: { comparePositionTo: () => 1 } }
            }
        },
        owner: { send: async () => { auditEntries.push({ alert: true }); } }
    };
    const value = {
        id: `m-${Math.random()}`,
        guild,
        author: { id: 'user-1', bot: false },
        content,
        deletable: true,
        member: { roles: { highest: { position: 1 } } },
        mentions: { users: { size: 0 }, roles: { size: 0 } },
        async delete() { deletions += 1; },
        ...overrides
    };
    return { value, auditEntries, deleted: () => deletions };
}

function engine(config, now = () => 1000) {
    const auditEntries = [];
    const filterEngine = createModerationFilterEngine({
        getGuildConfig: async () => config,
        auditLog: async (entry) => auditEntries.push(entry),
        now,
        logger: { error() {} }
    });
    return { filterEngine, auditEntries };
}

test('all new message moderation filters are disabled by default', async () => {
    const { defaultGuildConfig } = require('../dashboard/lib/shared');
    const config = defaultGuildConfig({ guildId: 'guild-1' });
    const { filterEngine, auditEntries } = engine(config);
    const candidate = message('DISCORD INVITE https://discord.gg/example');
    const result = await filterEngine.processMessage(candidate.value);
    assert.equal(result.matched, false);
    assert.equal(candidate.deleted(), 0);
    assert.equal(auditEntries.length, 0);
});

test('opt-in auto moderation quarantines violating messages and audits/alerts moderators', async () => {
    const { filterEngine, auditEntries } = engine({
        moderation_spam_filter_enabled: false,
        moderation_caps_filter_enabled: false,
        moderation_mentions_filter_enabled: false,
        moderation_invites_filter_enabled: true,
        moderation_word_filter_enabled: false,
        moderation_filtered_words: []
    });
    const candidate = message('Join https://discord.gg/example');
    const result = await filterEngine.processMessage(candidate.value);
    assert.equal(result.rule, 'invite');
    assert.equal(candidate.deleted(), 1);
    assert.equal(auditEntries.length, 1);
    assert.equal(candidate.auditEntries.some((entry) => entry.alert), true);
});

test('filter configuration is isolated by guild', async () => {
    const auditEntries = [];
    const filterEngine = createModerationFilterEngine({
        getGuildConfig: async (guild) => ({
            moderation_invites_filter_enabled: guild.id === 'guild-a'
        }),
        auditLog: async (entry) => auditEntries.push(entry),
        logger: { error() {} }
    });
    const enabled = message('https://discord.gg/example');
    enabled.value.guild.id = 'guild-a';
    const disabled = message('https://discord.gg/example', {
        guild: {
            id: 'guild-b',
            members: { me: { permissions: { has: () => true } } },
            owner: { send: async () => {} }
        }
    });
    assert.equal((await filterEngine.processMessage(enabled.value)).deleted, true);
    assert.equal((await filterEngine.processMessage(disabled.value)).matched, false);
    assert.equal(disabled.deleted(), 0);
    assert.equal(auditEntries.length, 1);
});

test('opt-in word, caps, and mention filters are per-guild and independent', async () => {
    const filteredWords = engine({
        moderation_word_filter_enabled: true,
        moderation_filtered_words: ['forbiddenword']
    });
    const wordMessage = message('This has forbiddenword in it');
    assert.equal((await filteredWords.filterEngine.processMessage(wordMessage.value)).rule, 'word');
    assert.equal(wordMessage.deleted(), 1);

    const caps = engine({ moderation_caps_filter_enabled: true });
    const capsMessage = message('THIS MESSAGE IS DEFINITELY TOO LOUD');
    assert.equal((await caps.filterEngine.processMessage(capsMessage.value)).rule, 'caps');
    assert.equal(capsMessage.deleted(), 1);

    const mentions = engine({ moderation_mentions_filter_enabled: true });
    const mentionMessage = message('hello', {
        mentions: { users: { size: 5 }, roles: { size: 0 } }
    });
    assert.equal((await mentions.filterEngine.processMessage(mentionMessage.value)).rule, 'mentions');
    assert.equal(mentionMessage.deleted(), 1);
});

test('opt-in anti-spam flags repeated rapid messages from the same member', async () => {
    let now = 1000;
    const { filterEngine } = engine({ moderation_spam_filter_enabled: true }, () => now);
    const results = [];
    for (let index = 0; index < 5; index += 1) {
        now += 500;
        const candidate = message('same repeated content');
        results.push(await filterEngine.processMessage(candidate.value));
    }
    assert.equal(results.slice(0, 4).every((result) => !result.matched), true);
    assert.equal(results[4].rule, 'spam');
});

test('filters fail closed without bot ManageMessages and report the failed quarantine', async () => {
    const errors = [];
    const auditEntries = [];
    const filterEngine = createModerationFilterEngine({
        getGuildConfig: async () => ({ moderation_invites_filter_enabled: true }),
        auditLog: async (entry) => auditEntries.push(entry),
        logger: { error: (error) => errors.push(error) }
    });
    const candidate = message('https://discord.gg/example', {
        guild: { id: 'guild-1', members: { me: { permissions: { has: () => false } } } }
    });
    const result = await filterEngine.processMessage(candidate.value);
    assert.equal(result.rule, 'invite');
    assert.equal(result.deleted, false);
    assert.equal(candidate.deleted(), 0);
    assert.equal(auditEntries.length, 1);
    assert.equal(errors.length, 1);
});
