const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTrigger, TriggerTracker } = require('../src/ai/triggerDetector');
const { ConversationMemory } = require('../src/ai/memory');
const { isGentleMember, normalizeRoleName } = require('../src/ai/roleDetector');
const { loadSettings } = require('../src/config/settings');
const { isCreatorQuestion, creatorResponse } = require('../src/ai/client');

test('creator questions identify ZiG and provide the portfolio details', () => {
    assert.equal(isCreatorQuestion('Who created you?'), true);
    assert.equal(isCreatorQuestion('who made this bot'), true);
    assert.equal(isCreatorQuestion('Who made it?'), true);
    assert.equal(isCreatorQuestion('Tell me a joke'), false);
    assert.match(creatorResponse, /ZiG/);
    assert.match(creatorResponse, /1296202178263912448/);
    assert.match(creatorResponse, /portfolio-eight-neon-70\.vercel\.app/);
    assert.match(creatorResponse, /Bhavesh Kumar Tiwari/);
});

test('detectTrigger identifies stress keywords correctly in English and Hinglish', () => {
    const stressCases = [
        "I am so stressed about my finals",
        "Feeling completely burnt out today",
        "I'm exhausted from this project",
        "The deadline is tomorrow and I'm dying",
        "I hate my job right now",
        "Send help, exams are killing me",
        // Hinglish
        "bhai bohot stress hai life me",
        "aaj to dimag kharab ho gaya",
        "exams aa rahe hai aur padhai nahi hui",
        "kaam karke pura thak gaya hu",
        "kuch samajh nahi aa raha lag gaye"
    ];

    for (const msg of stressCases) {
        const result = detectTrigger(msg);
        assert.equal(result.matched, true, `Expected "${msg}" to match trigger`);
        assert.equal(result.type, 'stress');
    }
});

test('detectTrigger identifies fun and mingle keywords correctly in English and Hinglish', () => {
    const funCases = [
        "Can you tell me a funny joke?",
        "Please roast me",
        "Make me laugh, having a dull day",
        "Cheer me up",
        "I am so bored right now",
        // Hinglish
        "bhai ek joke sunao",
        "mujhe hasao please",
        "roast karo mujhe",
        "kya scene hai aaj ka",
        "bore ho raha hu koi baat karo"
    ];

    for (const msg of funCases) {
        const result = detectTrigger(msg);
        assert.equal(result.matched, true, `Expected "${msg}" to match trigger`);
        assert.equal(result.type, 'fun');
    }
});

test('detectTrigger ignores ordinary neutral messages', () => {
    const neutralCases = [
        "Hey everyone",
        "What time is the meeting?",
        "Check out this cool website",
        "Let's play some games tonight",
        "sab theek hai"
    ];

    for (const msg of neutralCases) {
        const result = detectTrigger(msg);
        assert.equal(result.matched, false, `Expected "${msg}" not to match`);
    }
});

test('TriggerTracker enforces cooldowns per channel and user', () => {
    const tracker = new TriggerTracker();
    const channelId = 'chan-123';
    const userId = 'user-456';

    assert.equal(tracker.canTrigger(channelId, userId, 10), true);

    tracker.recordTrigger(channelId, userId);

    // Immediately after, it should be blocked by cooldown
    assert.equal(tracker.canTrigger(channelId, userId, 10), false);
    // Another user in the same channel should also be blocked by channel cooldown
    assert.equal(tracker.canTrigger(channelId, 'user-789', 10), false);
    // Same user in another channel should be blocked by user cooldown
    assert.equal(tracker.canTrigger('chan-999', userId, 10), false);

    tracker.reset();
    assert.equal(tracker.canTrigger(channelId, userId, 10), true);
});

test('ConversationMemory buffers and limits sliding history window', () => {
    const memory = new ConversationMemory({ maxMessages: 4, ttlMs: 60000 });
    const channelId = 'chan-test';

    memory.addMessage(channelId, 'user', 'Hello bot', 'Alice');
    memory.addMessage(channelId, 'assistant', 'Hello Alice!');
    memory.addMessage(channelId, 'user', 'How are you?', 'Alice');
    memory.addMessage(channelId, 'assistant', 'Living the digital dream.');
    memory.addMessage(channelId, 'user', 'Tell me more', 'Alice');

    const history = memory.getHistory(channelId);
    assert.equal(history.length, 4); // Max 4
    assert.equal(history[0].content, 'Hello Alice!');
    assert.equal(history[3].content, '[Alice]: Tell me more');

    memory.clear(channelId);
    assert.equal(memory.getHistory(channelId).length, 0);
});

test('isGentleMember detects Unicode and standard she/her / girl roles', () => {
    const createMemberWithRoles = (roleNames) => ({
        roles: {
            cache: new Map(roleNames.map((name, i) => [`${i}`, { name }]))
        }
    });

    // Unicode aesthetic she/her role
    assert.equal(isGentleMember(createMemberWithRoles(['ｓｈｅ ﹒ ｈｅｒ'])), true);
    assert.equal(isGentleMember(createMemberWithRoles(['she/her'])), true);
    assert.equal(isGentleMember(createMemberWithRoles(['🏷️ Heer Tag']), ['🏷️ Heer Tag']), true);
    assert.equal(isGentleMember({
        user: { primaryGuild: { identityEnabled: true, identityGuildId: 'guild-123', tag: 'Heer' } },
        roles: { cache: new Map() }
    }, ['🏷️ Heer Tag'], 'guild-123'), true);
    assert.equal(isGentleMember({
        user: { primaryGuild: { identityEnabled: true, identityGuildId: 'other-guild', tag: 'Heer' } },
        roles: { cache: new Map() }
    }, ['🏷️ Heer Tag'], 'guild-123'), false);
    assert.equal(isGentleMember(createMemberWithRoles(['Girl', 'VIP'])), true);
    assert.equal(isGentleMember(createMemberWithRoles(['Queen'])), true);
    assert.equal(isGentleMember(createMemberWithRoles(['Gentle Mode'])), true);

    // Regular member without gentle roles
    assert.equal(isGentleMember(createMemberWithRoles(['Member', 'Gamer', 'Dude'])), false);
    assert.equal(isGentleMember(createMemberWithRoles(['VIP']), ['🏷️ Heer Tag']), false);
    assert.equal(isGentleMember(null), false);
});

test('loadSettings parses auto-reply configuration options', () => {
    process.env.DISCORD_TOKEN = 'mock-token';
    process.env.NVIDIA_API_KEY = 'mock-key';
    process.env.CHAT_CHANNEL_IDS = '123456789, 987654321';
    process.env.COOLDOWN_SECONDS = '20';
    process.env.AUTO_REPLY_KEYWORDS = 'true';

    const settings = loadSettings();
    assert.deepEqual(settings.chatChannelIds, ['123456789', '987654321']);
    assert.equal(settings.cooldownSeconds, 20);
    assert.equal(settings.autoReplyKeywords, true);
    assert.equal(settings.humorStyle, 'witty_stress_relief');
    assert.ok(settings.gentleRoleNames.includes('ｓｈｅ ﹒ ｈｅｒ'));
});
