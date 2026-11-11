// Avatar viewer (AV): "av @user" and friends, no slash command needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const av = require('../src/avatar/avatar');
const { createAvatarHandler } = require('../src/avatar/handler');

const BOT = '100000000000000000';
const A = '111111111111111111'; // author
const U = '222222222222222222';
const W = '333333333333333333';
const G = '999999999999999999';

const detect = (content, extra = {}) => av.detectAvatarRequest({ content, botId: BOT, authorId: A, ...extra });

// --------------------------------------------------------------- detection
test('every keyword works, in any case', () => {
    for (const kw of ['av', 'avatar', 'pfp', 'profile pic', 'profile picture', 'display picture', 'dp', 'show avatar', 'show pfp', 'show profile pic', 'AV', 'Avatar', 'PFP', 'Profile Pic', 'DP', 'SHOW AVATAR']) {
        assert.deepEqual(detect(`${kw} <@${U}>`)?.targets, [U], kw);
    }
});

test('the example messages all work', () => {
    const examples = [
        `av <@${U}>`, `avatar <@${U}>`, `pfp <@${U}>`, `profile pic <@${U}>`, `profile picture <@${U}>`,
        `show me the avatar of <@${U}>`, `show <@${U}> avatar`, `<@${BOT}> av <@${U}>`, `<@${BOT}> show pfp <@${U}>`,
        `<@${BOT}> profile pic <@${U}>`, `<@${BOT}> show avatar <@!${U}>`, `<@!${BOT}> pfp <@${U}>`, `<@${U}> pfp`
    ];
    for (const text of examples) assert.deepEqual(detect(text)?.targets, [U], text);
});

test('several mentions: each user, in order, once', () => {
    assert.deepEqual(detect(`av <@${U}> <@${W}> <@${U}>`).targets, [U, W]);
    assert.deepEqual(detect(`pfp <@${W}> and <@${U}>`).targets, [W, U]);
});

test('just talking about avatars does not trigger', () => {
    for (const text of [
        'I love the new avatar movie', `I love the new avatar movie <@${U}>`, `nice pfp <@${U}>`, `your dp is so cute <@${U}>`,
        'av', 'pfp', 'change your avatar', `<@${U}> where did you get that avatar`, 'avocado', 'dpi settings', 'savvy',
        `<@${BOT}> is avatar a good movie?`, `<@${BOT}> how do I change my avatar on discord`, '', null
    ]) {
        assert.equal(detect(text), null, String(text));
    }
});

test('a bot mention with a clear request but nobody named asks whose avatar', () => {
    for (const text of [`<@${BOT}> av`, `<@${BOT}> show pfp`, `<@${BOT}> avatar pls`]) {
        assert.deepEqual(detect(text), { targets: [], invalid: [], serverRequested: false, askWho: true }, text);
    }
});

test('"my pfp" shows the author; mentioning ZiGBoT later (not as the address) shows ZiGBoT', () => {
    assert.deepEqual(detect(`<@${BOT}> show my pfp`).targets, [A]);
    assert.deepEqual(detect('my avatar pls').targets, [A]);
    assert.deepEqual(detect(`av <@${BOT}>`).targets, [BOT]);
    assert.deepEqual(detect(`<@${BOT}> av <@${BOT}>`).targets, [BOT]);
});

test('server avatar is preferred when asked for', () => {
    assert.equal(detect(`server av <@${U}>`).serverRequested, true);
    assert.equal(detect(`show <@${U}> guild pfp`).serverRequested, true);
    assert.equal(detect(`av <@${U}>`).serverRequested, false);
});

test('only real user ids count: role, channel and malformed mentions are not users', () => {
    assert.equal(detect('av <@&444444444444444444>'), null);
    assert.equal(detect('av <#444444444444444444>'), null);
    assert.equal(detect('av <@12>'), null, 'too short for a Discord id');
    assert.equal(detect('av @everyone'), null);
});

test('at most 5 users per message', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `55555555555555555${i}`);
    const found = detect(`av ${ids.map((id) => `<@${id}>`).join(' ')}`);
    assert.equal(found.targets.length, av.MAX_TARGETS);
    assert.equal(found.truncated, true);
});

// ------------------------------------------------------------------- URLs
function fakeUser({ id = U, username = 'bhavesh', globalName = 'Bhavesh', avatar = 'abc123', bot = false } = {}) {
    return {
        id, username, globalName, avatar, bot,
        defaultAvatarURL: 'https://cdn.discordapp.com/embed/avatars/3.png',
        avatarURL: (o = {}) => (avatar ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.${!o.forceStatic && avatar.startsWith('a_') ? 'gif' : o.extension || 'webp'}?size=${o.size}` : null)
    };
}
function fakeMember({ id = U, displayName = 'Bhav', avatar = null } = {}) {
    return {
        id, displayName, avatar,
        avatarURL: (o = {}) => (avatar ? `https://cdn.discordapp.com/guilds/${G}/users/${id}/avatars/${avatar}.${!o.forceStatic && avatar.startsWith('a_') ? 'gif' : o.extension || 'webp'}?size=${o.size}` : null)
    };
}

test('custom avatar: full size (4096) plus PNG, JPG and WEBP links', () => {
    const urls = av.avatarUrls(fakeUser());
    assert.equal(urls.isDefault, false);
    assert.match(urls.main, /abc123\.webp\?size=4096$/);
    assert.match(urls.png, /\.png\?size=4096$/);
    assert.match(urls.jpg, /\.jpg\?size=4096$/);
    assert.match(urls.webp, /\.webp\?size=4096$/);
    assert.equal(urls.gif, null);
});

test('animated avatar: shown as GIF, with a GIF link too', () => {
    const urls = av.avatarUrls(fakeUser({ avatar: 'a_anim' }));
    assert.match(urls.main, /a_anim\.gif\?size=4096$/);
    assert.match(urls.gif, /\.gif\?size=4096$/);
    assert.match(urls.png, /\.png\?size=4096$/, 'still a static PNG link');
});

test('no custom avatar: Discord\'s default avatar, never an error', () => {
    const urls = av.avatarUrls(fakeUser({ avatar: null }));
    assert.equal(urls.isDefault, true);
    assert.equal(urls.main, 'https://cdn.discordapp.com/embed/avatars/3.png');
    assert.equal(urls.png, urls.main);
});

test('server avatar only when the member has one', () => {
    assert.equal(av.avatarUrls(fakeMember(), { member: true }), null);
    assert.match(av.avatarUrls(fakeMember({ avatar: 'srv1' }), { member: true }).main, /guilds\/.*srv1\.webp\?size=4096$/);
});

// ------------------------------------------------------------------ embeds
const entry = (user, member = null) => ({ user, member, global: av.avatarUrls(user), server: member ? av.avatarUrls(member, { member: true }) : null });

test('embed: title, tagged user, info, links and the full-size image', () => {
    const reply = av.buildAvatarReply([entry(fakeUser(), fakeMember())], {});
    assert.equal(reply.embeds.length, 1, 'no server avatar: one card');
    const e = reply.embeds[0];
    assert.match(e.title, /AVATAR VIEWER/);
    assert.match(e.description, new RegExp(`<@${U}>`));
    assert.match(e.description, /Username: bhavesh/);
    assert.match(e.description, /Display Name: Bhav/);
    assert.match(e.description, new RegExp(`User ID: \`${U}\``));
    assert.match(e.description, /\[PNG\]\(https:[^)]+\.png[^)]*\) · \[JPG\]\([^)]+\) · \[WEBP\]\([^)]+\)/);
    assert.match(e.image.url, /size=4096/);
    assert.equal(e.url, e.image.url, 'the title opens the original');
    assert.equal(e.color, av.COLOR);
    // A link button opens the full-resolution original.
    const button = reply.components[0].components[0];
    assert.equal(button.style, 5);
    assert.equal(button.url, e.image.url);
    assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
});

test('server avatar: shown next to the global one; first when asked for', () => {
    const both = entry(fakeUser(), fakeMember({ avatar: 'srv1' }));
    const normal = av.buildAvatarReply([both], {});
    assert.equal(normal.embeds.length, 2);
    assert.doesNotMatch(normal.embeds[0].title, /Server/);
    assert.match(normal.embeds[1].title, /Server avatar/);
    const asked = av.buildAvatarReply([both], { serverRequested: true });
    assert.match(asked.embeds[0].title, /Server avatar/);
    const none = av.buildAvatarReply([entry(fakeUser(), fakeMember())], { serverRequested: true });
    assert.match(none.content, /no server avatar/i);
});

test('default avatar card says so and links only the PNG', () => {
    const e = av.buildAvatarReply([entry(fakeUser({ avatar: null }))], {}).embeds[0];
    assert.match(e.description, /default Discord avatar/i);
    assert.doesNotMatch(e.description, /\[JPG\]|\[WEBP\]/);
});

test('names cannot inject markdown or mass mentions', () => {
    const e = av.buildAvatarReply([entry(fakeUser({ username: 'x_y', globalName: '@everyone **boss**' }))], {}).embeds[0];
    assert.doesNotMatch(e.description, /@everyone/);
    assert.doesNotMatch(e.description, /\*\*boss\*\*/);
});

test('five users with server avatars stay inside Discord\'s limits (10 embeds, 5 buttons)', () => {
    const many = Array.from({ length: 5 }, (_, i) => entry(fakeUser({ id: `66666666666666666${i}` }), fakeMember({ id: `66666666666666666${i}`, avatar: 'srv' })));
    const reply = av.buildAvatarReply(many, {});
    assert.ok(reply.embeds.length <= 10);
    assert.ok(reply.components.every((row) => row.components.length <= 5));
    assert.ok(reply.components.length <= 5);
});

// ----------------------------------------------------------------- handler
function fakeMessage({ content, authorId = A, users = [], members = [], guild = true, id = `m${Math.random()}` }) {
    const replies = [];
    return {
        replies,
        message: {
            id, content,
            author: { id: authorId, bot: false },
            guild: guild ? { id: G, members: { fetch: async (uid) => members.find((m) => m.id === uid) || Promise.reject(new Error('Unknown Member')) } } : null,
            mentions: { users: new Map(users.map((u) => [u.id, u])), members: new Map(members.map((m) => [m.id, m])) },
            reply: async (payload) => { replies.push(payload); }
        }
    };
}

function setup({ fetchUser = async () => { throw new Error('Unknown User'); } } = {}) {
    let t = 1_000_000;
    const handler = createAvatarHandler({ botId: BOT, fetchUser, now: () => t, logger: { error() {} } });
    return { handler, advance: (ms) => { t += ms; } };
}

test('handler: "av @user" replies with the avatar card', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()], members: [fakeMember()] });
    assert.equal(await handler.handle(m.message), true);
    assert.equal(m.replies.length, 1);
    assert.match(m.replies[0].embeds[0].title, /AVATAR VIEWER/);
});

test('handler: ordinary messages are left alone', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `nice pfp <@${U}>`, users: [fakeUser()] });
    assert.equal(await handler.handle(m.message), false);
    assert.equal(m.replies.length, 0);
});

test('handler: asks whose avatar when nobody is named', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `<@${BOT}> av` });
    assert.equal(await handler.handle(m.message), true);
    assert.equal(m.replies[0].content, "👀 Whose avatar do you want to see? Mention a user!");
});

test('handler: a mention Discord could not resolve gets a friendly error', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `av <@${W}>` }); // W is not in message.mentions
    assert.equal(await handler.handle(m.message), true);
    assert.match(m.replies[0].content, /couldn't find/i);
    assert.equal(m.replies[0].embeds, undefined);
});

test('handler: falls back to fetching the user when the mention was not resolved', async () => {
    const { handler } = setup({ fetchUser: async (id) => fakeUser({ id }) });
    const m = fakeMessage({ content: `av <@${W}>` });
    await handler.handle(m.message);
    assert.match(m.replies[0].embeds[0].description, new RegExp(`<@${W}>`));
});

test('handler: server avatar from a member fetch when the mention had no member', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `server av <@${U}>`, users: [fakeUser()], members: [] });
    m.message.guild.members.fetch = async () => fakeMember({ avatar: 'srv9' });
    await handler.handle(m.message);
    assert.match(m.replies[0].embeds[0].title, /Server avatar/);
});

test('handler: works in DMs (no server avatars there)', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()], guild: false });
    assert.equal(await handler.handle(m.message), true);
    assert.equal(m.replies[0].embeds.length, 1);
});

test('handler: the same message is never answered twice; spam is slowed down', async () => {
    const { handler, advance } = setup();
    const m = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()], id: 'same' });
    await handler.handle(m.message);
    await handler.handle(m.message);
    assert.equal(m.replies.length, 1, 'duplicate event');
    const again = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()] });
    assert.equal(await handler.handle(again.message), true, 'still "handled" so the AI does not answer it');
    assert.equal(again.replies.length, 0, 'cooldown');
    advance(av.COOLDOWN_MS + 1);
    const later = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()] });
    await handler.handle(later.message);
    assert.equal(later.replies.length, 1);
});

test('handler: bots, webhooks and ZiGBoT itself are ignored', async () => {
    const { handler } = setup();
    for (const patch of [{ bot: true }, { webhook: true }, { self: true }]) {
        const m = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()], authorId: patch.self ? BOT : A });
        if (patch.bot) m.message.author.bot = true;
        if (patch.webhook) m.message.webhookId = '777777777777777777';
        assert.equal(await handler.handle(m.message), false, JSON.stringify(patch));
        assert.equal(m.replies.length, 0);
    }
});

test('handler: a failed reply never throws', async () => {
    const { handler } = setup();
    const m = fakeMessage({ content: `av <@${U}>`, users: [fakeUser()] });
    m.message.reply = async () => { throw new Error('Missing Permissions'); };
    assert.equal(await handler.handle(m.message), true);
});

// ------------------------------------------------------- living with AFK
test('with AFK: "afk ..." is AFK\'s, "av @afkUser" gets both the AFK notice and the avatar', async () => {
    const { createAfkStore } = require('../src/afk/store');
    const { createAfkHandler } = require('../src/afk/handler');
    const store = createAfkStore({ getCollection: () => null });
    const afkHandler = createAfkHandler({ store, botId: BOT, logger: { error() {} } });
    const { handler: avHandler } = setup();
    // Same order as src/index.js: AFK first; it stops only its own command.
    const route = async (m) => ((await afkHandler.handle(m.message)).handled ? 'afk' : (await avHandler.handle(m.message)) ? 'avatar' : 'bot');
    const sent = [];
    const withChannel = (m) => { m.message.channel = { id: 'c', send: async (p) => sent.push(p) }; m.message.member = { id: m.message.author.id, displayName: 'x', manageable: false }; return m; };

    assert.equal(await route(withChannel(fakeMessage({ content: 'afk avatar shopping', authorId: U }))), 'afk', 'not an avatar request');
    const ask = withChannel(fakeMessage({ content: `av <@${U}>`, users: [fakeUser()] }));
    assert.equal(await route(ask), 'avatar');
    assert.match(sent.at(-1).content, /AFK NOTIFICATION/);
    assert.equal(ask.replies.length, 1);
});

test('src/index.js runs AFK first, then the avatar viewer, before the AI reply gate', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const afkAt = src.indexOf('afkHandler.handle(message)');
    const avAt = src.indexOf('avatarHandler.handle(message)');
    const gateAt = src.indexOf('const shouldReply =');
    assert.ok(afkAt > 0 && avAt > afkAt && gateAt > avAt, `${afkAt} < ${avAt} < ${gateAt}`);
});
