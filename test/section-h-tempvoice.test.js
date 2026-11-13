// Section H: temporary voice channels ("join to create").
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../dashboard/lib/shared');
const { MemoryFeatureStore } = require('../src/features/store');
const { createScheduler } = require('../src/features/scheduler');
const { createTempVoice, MAX_PER_GUILD } = require('../src/features/tempVoice');

const G = '900000000000000001';
const U = '111111111111111111';
const V = '222222222222222222';
const HUB = '300000000000000001';
const CAT = '300000000000000002';

class Coll extends Map {}

function fixture(voice = {}, { botPerms = true } = {}) {
    let t = 1_000_000;
    let nextId = 10;
    const audits = [];
    const created = [];
    const deleted = [];
    const channels = new Coll();
    const voiceChannel = (id, extra = {}) => {
        const ch = {
            id, name: `vc-${id.slice(-2)}`, members: new Coll(), overwrites: new Map(), userLimit: 0, ...extra,
            delete: async () => { deleted.push(id); channels.delete(id); },
            setUserLimit: async (n) => { ch.userLimit = n; },
            setName: async (n) => { ch.name = n; },
            permissionOverwrites: { edit: async (target, perms) => ch.overwrites.set(target, perms), delete: async (target) => ch.overwrites.delete(target) }
        };
        channels.set(id, ch);
        return ch;
    };
    voiceChannel(HUB, { parentId: CAT });
    const guild = {
        id: G,
        channels: {
            cache: channels,
            create: async (options) => { const ch = voiceChannel(`40000000000000${String(nextId++).padStart(4, '0')}`, { name: options.name, parentId: options.parent, userLimit: options.userLimit || 0 }); created.push({ id: ch.id, options }); return ch; }
        },
        members: { me: { permissions: { has: () => botPerms } } }
    };
    const member = (id, name = `user${id.slice(-1)}`) => {
        const m = { id, displayName: name, user: { id, bot: false }, guild, voice: { channel: null } };
        m.voice.setChannel = async (target) => {
            const ch = typeof target === 'string' ? channels.get(target) : target;
            for (const c of channels.values()) c.members.delete(id);
            ch.members.set(id, m);
            m.voice.channel = ch;
        };
        m.voice.disconnect = async () => { for (const c of channels.values()) c.members.delete(id); m.voice.channel = null; };
        return m;
    };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    Object.assign(config.feature_settings.voice, { tempvoice_enabled: true, tempvoice_hub_channel_id: HUB, ...voice });
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const tv = createTempVoice({ store, scheduler, now: () => t, logger: { error() {} },
        resolveContext: async () => ({ config, settings: {} }), auditLog: async (e) => audits.push(e),
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } }) });
    // A member moves from one channel to another: Discord moves them, then fires the event.
    const move = async (m, toId) => {
        const fromId = m.voice.channel?.id || null;
        for (const c of channels.values()) c.members.delete(m.id);
        if (toId) { channels.get(toId).members.set(m.id, m); m.voice.channel = channels.get(toId); } else m.voice.channel = null;
        await tv.onVoiceState({ guild, member: m, channelId: fromId }, { guild, member: m, channelId: toId });
    };
    const interaction = (m, sub, options = {}) => {
        const replies = [];
        return { replies, commandName: 'tempvoice', guild, member: m, user: m.user, options: { getSubcommand: () => sub, getInteger: (k) => options[k] ?? null, getString: (k) => options[k] ?? null, getUser: (k) => options[k] ?? null }, reply: async (p) => replies.push(p) };
    };
    return { tv, store, scheduler, guild, channels, created, deleted, audits, member, move, interaction, config, advance: (ms) => { t += ms; } };
}

test('settings: off by default, and the hub channel is required to switch it on', () => {
    assert.equal(shared.defaultFeatureSettings().voice.tempvoice_enabled, false);
    const result = shared.validateFeatureSettings({ voice: { tempvoice_enabled: true } }, { channelIds: new Set(), roleIds: new Set(), guildId: G });
    assert.match(Object.values(result.errors).join(), /join to create/);
});

test('joining the hub creates a channel for the member, moves them in and makes them its owner', async () => {
    const f = fixture({ tempvoice_name: "{user}'s room @everyone", tempvoice_limit: 5 });
    const u = f.member(U, 'Star');
    await f.move(u, HUB);
    assert.equal(f.created.length, 1);
    const { id, options } = f.created[0];
    assert.equal(options.name, "Star's room everyone", 'no mass mention in a channel name');
    assert.equal(options.parent, CAT, 'next to the hub');
    assert.equal(options.userLimit, 5);
    assert.deepEqual(options.permissionOverwrites[0].id, U);
    assert.equal(u.voice.channel.id, id);
    assert.equal((await f.store.get(G, 'temp_voice', id)).data.ownerId, U);
});

test('the channel is deleted when the last person leaves, not before; a second hub join reuses the owned channel', async () => {
    const f = fixture();
    const u = f.member(U);
    const v = f.member(V);
    await f.move(u, HUB);
    const temp = u.voice.channel.id;
    await f.move(v, temp);
    await f.move(u, null);
    assert.deepEqual(f.deleted, [], 'someone is still inside');
    await f.move(u, temp);
    await f.move(u, HUB);
    assert.equal(f.created.length, 1, 'no second channel for the same owner');
    assert.equal(u.voice.channel.id, temp);
    await f.move(u, null);
    await f.move(v, null);
    assert.deepEqual(f.deleted, [temp]);
    assert.equal(await f.store.get(G, 'temp_voice', temp), null);
    assert.ok(f.audits.some((a) => a.action === 'tempvoice_delete'));
});

test('a channel left empty while the bot was down is cleaned up by the sweep', async () => {
    const f = fixture();
    const u = f.member(U);
    await f.move(u, HUB);
    const temp = u.voice.channel.id;
    f.channels.get(temp).members.clear(); // they left while ZiGBoT was offline: no event
    await f.tv.sweep();
    assert.deepEqual(f.deleted, [temp]);
    assert.deepEqual(f.deleted.includes(HUB), false, 'the hub is never deleted');
});

test('no channels without the bot permissions, when switched off, or for hub-hopping spam', async () => {
    const noPerms = fixture({}, { botPerms: false });
    await noPerms.move(noPerms.member(U), HUB);
    assert.equal(noPerms.created.length, 0);
    assert.ok(noPerms.audits.some((a) => a.result === 'SKIPPED'));

    const off = fixture({ tempvoice_enabled: false });
    await off.move(off.member(U), HUB);
    assert.equal(off.created.length, 0);

    const f = fixture();
    const u = f.member(U);
    await f.move(u, HUB);
    await f.move(u, null); // deleted
    await f.move(u, HUB); // within 10 s
    assert.equal(f.created.length, 1, 'cooldown');
    f.advance(11_000);
    await f.move(u, null);
    await f.move(u, HUB);
    assert.equal(f.created.length, 2);
    assert.equal(MAX_PER_GUILD, 50);
});

test('mute/deafen updates are not moves and do nothing', async () => {
    const f = fixture();
    const u = f.member(U);
    await f.tv.onVoiceState({ guild: f.guild, member: u, channelId: HUB }, { guild: f.guild, member: u, channelId: HUB });
    assert.equal(f.created.length, 0);
});

test('/tempvoice: only the owner controls the channel; claim works only once the owner left', async () => {
    const f = fixture();
    const u = f.member(U);
    const v = f.member(V);
    await f.move(u, HUB);
    const temp = f.channels.get(u.voice.channel.id);
    await f.move(v, temp.id);
    const run = async (m, sub, options) => { const i = f.interaction(m, sub, options); await f.tv.handleSlash(i); return i.replies[0].content; };

    assert.match(await run(v, 'lock'), /Only the channel owner/);
    assert.match(await run(u, 'lock'), /Done/);
    assert.deepEqual(temp.overwrites.get(G), { Connect: false });
    assert.match(await run(u, 'limit', { users: 3 }), /Done/);
    assert.equal(temp.userLimit, 3);
    assert.match(await run(u, 'limit', { users: 120 }), /0 to 99/);
    assert.match(await run(u, 'rename', { name: 'Chill @here' }), /Done/);
    assert.equal(temp.name, 'Chill here');
    assert.match(await run(u, 'reject', { member: { id: V } }), /Done/);
    assert.deepEqual(temp.overwrites.get(V), { Connect: false });
    assert.equal(v.voice.channel, null, 'rejected member is disconnected');

    await f.move(v, temp.id);
    assert.match(await run(v, 'claim'), /owner is still here/);
    await f.move(u, null);
    assert.match(await run(v, 'claim'), /own this channel now/);
    assert.equal((await f.store.get(G, 'temp_voice', temp.id)).data.ownerId, V);

    const outside = f.member('333333333333333333');
    assert.match(await run(outside, 'lock'), /Join your temporary voice channel/);
});

test('src/index.js forwards voice updates to features before the music early-return', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const listener = src.slice(src.indexOf('client.on(Events.VoiceStateUpdate,'));
    assert.ok(listener.indexOf('features.onVoiceState(oldState, newState)') < listener.indexOf('if (!botChannel) return;'));
});
