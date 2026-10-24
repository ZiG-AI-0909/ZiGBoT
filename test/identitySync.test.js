const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

// Custom bot identity in the bot worker: src/identity/sync.js (apply, revert,
// cleanup) and src/identity/commands.js (/identity show|reset), with fakes
// for Discord and the database.
const { createIdentitySync } = require('../src/identity/sync');
const { createIdentityCommands } = require('../src/identity/commands');
const { buildDefinitions } = require('../src/slash');

const G = '123456789012345678';
const SHA = 'd'.repeat(64);
const PATH = `${G}/${SHA}.png`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-24T12:00:00Z');

function fakeStore({ rows = [], blocked = [] } = {}) {
    const state = { rows: new Map(rows.map((r) => [r.guild_id, { ...r }])), blocked: new Set(blocked), audits: [], removed: [], downloads: [] };
    return {
        state,
        enabled: true,
        listRows: async () => [...state.rows.values()],
        getRow: async (id) => state.rows.get(String(id)) || null,
        isGuildBlocked: async (id) => state.blocked.has(String(id)),
        updateRow: async (id, fields) => state.rows.set(String(id), { ...state.rows.get(String(id)), ...fields }),
        deleteRow: async (id) => state.rows.delete(String(id)),
        audit: async (entry) => state.audits.push(entry),
        downloadAvatar: async (path) => {
            state.downloads.push(path);
            return Buffer.from(`png:${path}`);
        },
        removeAvatars: async (paths) => state.removed.push(...paths.filter(Boolean))
    };
}

function fakeGuild({ joinedTimestamp = NOW - 365 * DAY, failWith = null } = {}) {
    const edits = [];
    return {
        id: G,
        edits,
        members: {
            me: { joinedTimestamp },
            editMe: async (options) => {
                if (failWith) throw failWith;
                edits.push(options);
            }
        }
    };
}

function makeSync({ store, guild, premium = true, enabled = true }) {
    const client = { guilds: { cache: new Map(guild ? [[G, guild]] : []) }, isReady: () => true };
    return createIdentitySync({ client, store, getContext: async () => ({ premium }), enabled, logger: { log() {}, error() {} }, now: () => NOW });
}

const savedRow = (extra = {}) => ({ guild_id: G, nick: 'Zed', bio: 'chai bot', avatar_path: PATH, avatar_sha256: SHA, updated_at: new Date(NOW - DAY).toISOString(), ...extra });

test('an approved identity on a Premium server is applied once, then left alone', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const guild = fakeGuild();
    const sync = makeSync({ store, guild });
    assert.equal(await sync.reconcile(guild), 'applied');
    assert.equal(guild.edits.length, 1);
    const { nick, bio, avatar, reason } = guild.edits[0];
    assert.deepEqual({ nick, bio }, { nick: 'Zed', bio: 'chai bot' });
    assert.deepEqual(avatar, Buffer.from(`png:${PATH}`));
    assert.match(reason, /ZiGBoT custom identity/);
    const row = store.state.rows.get(G);
    assert.deepEqual([row.applied_nick, row.applied_bio, row.applied_avatar_sha256], ['Zed', 'chai bot', SHA]);
    assert.equal(store.state.audits.at(-1).action, 'APPLY');
    assert.equal(await sync.reconcile(guild), 'ok', 'already in sync');
    assert.equal(guild.edits.length, 1, 'no second Discord call');
});

test('a pending avatar is never applied (only the approved one)', async () => {
    const store = fakeStore({ rows: [savedRow({ avatar_path: null, avatar_sha256: null, pending_avatar_path: PATH, pending_avatar_sha256: SHA })] });
    const guild = fakeGuild();
    await makeSync({ store, guild }).reconcile(guild);
    assert.equal(guild.edits[0].avatar, undefined, 'avatar not sent');
    assert.deepEqual(store.state.downloads, []);
});

test('Premium lapse reverts to the default ZiGBoT profile and keeps the saved identity', async () => {
    const store = fakeStore({ rows: [savedRow({ applied_nick: 'Zed', applied_bio: 'chai bot', applied_avatar_sha256: SHA, applied_at: new Date(NOW - DAY).toISOString() })] });
    const guild = fakeGuild();
    assert.equal(await makeSync({ store, guild, premium: false }).reconcile(guild), 'reverted');
    assert.deepEqual(guild.edits[0], { nick: null, bio: null, avatar: null, reason: guild.edits[0].reason });
    assert.match(guild.edits[0].reason, /premium_lapsed/);
    const row = store.state.rows.get(G);
    assert.equal(row.nick, 'Zed', 'saved identity kept for when Premium comes back');
    assert.equal(row.revert_reason, 'premium_lapsed');
    assert.equal(row.reverted_at, new Date(NOW).toISOString());
    assert.equal(store.state.audits.at(-1).action, 'REVERT');
});

test('a blocked server is reverted even while Premium', async () => {
    const store = fakeStore({ rows: [savedRow({ applied_nick: 'Zed', applied_at: new Date(NOW - DAY).toISOString() })], blocked: [G] });
    const guild = fakeGuild();
    assert.equal(await makeSync({ store, guild, premium: true }).reconcile(guild), 'reverted');
    assert.equal(guild.edits[0].nick, null);
    assert.equal(store.state.rows.get(G).revert_reason, 'blocked');
});

test('servers that never saved an identity are never touched', async () => {
    const store = fakeStore();
    const guild = fakeGuild();
    assert.equal(await makeSync({ store, guild, premium: false }).reconcile(guild), 'none');
    assert.deepEqual(guild.edits, []);
});

test('the feature flag off means no sync at all', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const guild = fakeGuild();
    const sync = makeSync({ store, guild, enabled: false });
    assert.equal(sync.active, false);
    assert.equal(await sync.reconcile(guild), 'off');
    assert.equal(sync.start(), null);
    await sync.sweep();
    await sync.onGuildRemoved(G);
    assert.deepEqual(guild.edits, []);
    assert.ok(store.state.rows.has(G));
});

test('re-added after our last change: the identity is applied again', async () => {
    const store = fakeStore({ rows: [savedRow({ applied_nick: 'Zed', applied_bio: 'chai bot', applied_avatar_sha256: SHA, applied_at: new Date(NOW - 10 * DAY).toISOString() })] });
    const guild = fakeGuild({ joinedTimestamp: NOW - DAY });
    assert.equal(await makeSync({ store, guild }).reconcile(guild), 'applied');
    assert.equal(guild.edits[0].nick, 'Zed');
});

test('30 days after a server stopped qualifying, the stored identity and pictures are deleted', async () => {
    const store = fakeStore({ rows: [savedRow({ pending_avatar_path: `${G}/${'e'.repeat(64)}.png`, pending_avatar_sha256: 'e'.repeat(64), reverted_at: new Date(NOW - 31 * DAY).toISOString(), revert_reason: 'premium_lapsed' })] });
    const guild = fakeGuild();
    assert.equal(await makeSync({ store, guild, premium: false }).reconcile(guild), 'deleted');
    assert.equal(store.state.rows.has(G), false);
    assert.deepEqual(store.state.removed.sort(), [PATH, `${G}/${'e'.repeat(64)}.png`].sort());
    assert.deepEqual(store.state.audits.at(-1).after, { reason: 'lapsed_cleanup' });

    const recent = fakeStore({ rows: [savedRow({ reverted_at: new Date(NOW - 29 * DAY).toISOString(), revert_reason: 'premium_lapsed' })] });
    assert.equal(await makeSync({ store: recent, guild: fakeGuild(), premium: false }).reconcile(fakeGuild()), 'ok', 'kept within 30 days');
    assert.ok(recent.state.rows.has(G));
});

test('removing the bot deletes the stored identity, on the event and on the next sweep', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const sync = makeSync({ store, guild: fakeGuild() });
    await sync.onGuildRemoved(G);
    assert.equal(store.state.rows.has(G), false);
    assert.deepEqual(store.state.removed, [PATH]);

    const offline = fakeStore({ rows: [savedRow()] });
    await makeSync({ store: offline, guild: null }).sweep(); // removed while the bot was offline
    assert.equal(offline.state.rows.has(G), false);
    assert.deepEqual(offline.state.audits.at(-1).after, { reason: 'bot_removed' });
});

test('a Discord failure is logged, nothing is marked applied, and the next sync retries', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const failing = fakeGuild({ failWith: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    assert.equal(await makeSync({ store, guild: failing }).reconcile(failing), 'error');
    assert.equal(store.state.rows.get(G).applied_nick, undefined);
    const guild = fakeGuild();
    assert.equal(await makeSync({ store, guild }).reconcile(guild), 'applied');
});

function fakeInteraction({ subcommand, confirm = true, admin = true, guild = fakeGuild() }) {
    const replies = [];
    return {
        replies,
        guild,
        user: { id: '100000000000000042' },
        memberPermissions: { has: (flag) => admin && flag === PermissionFlagsBits.ManageGuild },
        options: { getSubcommand: () => subcommand, getBoolean: () => confirm },
        deferReply: async (options) => replies.push({ deferred: options }),
        editReply: async (payload) => replies.push(payload)
    };
}

const commands = (store, { premium = true, enabled = true } = {}) => createIdentityCommands({ store, getContext: async () => ({ premium }), enabled });

test('/identity: admins only, private replies, no mentions', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const interaction = fakeInteraction({ subcommand: 'reset', admin: false });
    await commands(store).handleSlash(interaction);
    assert.ok(interaction.replies[0].deferred.flags, 'ephemeral');
    assert.match(interaction.replies[1].content, /Only server admins/);
    assert.deepEqual(interaction.replies[1].allowedMentions, { parse: [] });
    assert.ok(store.state.rows.has(G), 'nothing changed');
});

test('/identity show describes the identity; markdown in names is escaped', async () => {
    const store = fakeStore({ rows: [savedRow({ nick: '**Zed**', pending_avatar_path: PATH, pending_avatar_sha256: SHA })] });
    const interaction = fakeInteraction({ subcommand: 'show' });
    await commands(store, { premium: false }).handleSlash(interaction);
    const text = interaction.replies[1].content;
    assert.match(text, /\\\*\\\*Zed\\\*\\\*/);
    assert.match(text, /waiting for review/);
    assert.match(text, /isn’t Premium right now/);
});

test('/identity reset needs confirm:True, then resets Discord and deletes everything', async () => {
    const store = fakeStore({ rows: [savedRow()] });
    const unconfirmed = fakeInteraction({ subcommand: 'reset', confirm: false });
    await commands(store).handleSlash(unconfirmed);
    assert.match(unconfirmed.replies[1].content, /Nothing changed/);
    assert.ok(store.state.rows.has(G));

    const interaction = fakeInteraction({ subcommand: 'reset' });
    await commands(store).handleSlash(interaction);
    assert.deepEqual({ ...interaction.guild.edits[0], reason: undefined }, { nick: null, bio: null, avatar: null, reason: undefined });
    assert.equal(store.state.rows.has(G), false);
    assert.deepEqual(store.state.removed, [PATH]);
    assert.equal(store.state.audits.at(-1).action, 'RESET');
    assert.equal(store.state.audits.at(-1).actorRole, 'discord_admin');
    assert.match(interaction.replies[1].content, /back to its default/);
});

test('/identity reset works even without a saved identity; flag off answers politely', async () => {
    const interaction = fakeInteraction({ subcommand: 'reset' });
    await commands(fakeStore()).handleSlash(interaction);
    assert.equal(interaction.guild.edits.length, 1);
    const off = fakeInteraction({ subcommand: 'show' });
    await commands(fakeStore(), { enabled: false }).handleSlash(off);
    assert.match(off.replies[1].content, /isn’t available yet/);
});

test('/identity is only registered while CUSTOM_IDENTITY_ENABLED is on, and needs Manage Server', () => {
    assert.ok(!buildDefinitions().some((d) => d.name === 'identity'), 'not in the default (public catalog) definitions');
    const identity = buildDefinitions({ identity: true }).find((d) => d.name === 'identity');
    assert.ok(identity);
    assert.deepEqual(identity.options.map((o) => o.name), ['show', 'reset']);
    assert.equal(identity.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});
