const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

const { GuildConfigStore, isHomeGuild } = require('../src/guildConfig/store');
const { behaviorForMember, channelAllowed, isChatChannel, buildGuildSettings } = require('../src/guildConfig/context');
const { executeTool, isAuthorizedActor } = require('../src/tools/router');
const { buildReplySystemPrompt, getCreatorResponse, creatorResponse } = require('../src/ai/client');
const { auditLog } = require('../src/logging/auditLog');
const { neutralizeMassMentions } = require('../src/reply/delivery');
const { PLATFORM_SAFETY_RULES, GUEST_IDENTITY, HOME_IDENTITY } = require('../dashboard/lib/shared');

const HOME = '500000000000000001';
const GA = '500000000000000002';
const GB = '500000000000000003';
const OWNER = '600000000000000001'; // bot creator, owner of HOME
const GA_OWNER = '600000000000000002';
const R_MOD = '700000000000000001';
const R_VIP = '700000000000000002';
const CH_GENERAL = '800000000000000001';
const CH_SPAM = '800000000000000002';

const baseSettings = {
    serverOwnerId: OWNER,
    homeGuildIds: [],
    chatChannelIds: [CH_GENERAL],
    respondToAllMessages: false,
    autoReplyKeywords: true,
    cooldownSeconds: 15,
    logChannelId: '800000000000000099'
};

// ---- fake Supabase PostgREST ----
function fakeSupabase(tables) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const table = u.pathname.split('/').pop();
        const method = init.method || 'GET';
        calls.push({ table, method, query: u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
        if (tables.fail) return { ok: false, status: 503, text: async () => 'down' };
        if (method === 'GET') {
            const gid = u.searchParams.get('guild_id')?.replace(/^eq\./, '');
            const rows = (tables[table] || []).filter((row) => !gid || row.guild_id === gid);
            return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
        }
        if (method === 'POST' && table === 'zb_guild_configs') {
            for (const row of JSON.parse(init.body)) {
                if (!(tables.zb_guild_configs || []).some((r) => r.guild_id === row.guild_id)) {
                    (tables.zb_guild_configs ||= []).push(row);
                }
            }
        }
        return { ok: true, status: 201, text: async () => '' };
    };
    return { fetchImpl, calls };
}

function guild(id, ownerId = 'someone') {
    return { id, ownerId, name: `Guild ${id}`, icon: null };
}

test('store: each server gets its own config; changing A never affects B', async () => {
    const tables = {
        zb_guild_configs: [
            { guild_id: GA, custom_system_prompt: 'Pirate mode', default_tone: 'neutral' },
            { guild_id: GB, custom_system_prompt: 'Shakespeare mode', default_tone: 'gentle' }
        ],
        zb_role_mappings: [{ guild_id: GA, role_id: R_MOD, tier: 'moderator', allowed_features: ['moderation'] }]
    };
    const { fetchImpl, calls } = fakeSupabase(tables);
    let now = 0;
    const store = new GuildConfigStore({ settings: baseSettings, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'service-key', fetchImpl, now: () => now, logger: { error() {} } });

    const a = await store.getGuildContext(guild(GA));
    const b = await store.getGuildContext(guild(GB));
    assert.equal(a.config.custom_system_prompt, 'Pirate mode');
    assert.equal(b.config.custom_system_prompt, 'Shakespeare mode');
    assert.equal(a.mappings.length, 1);
    assert.equal(b.mappings.length, 0, "A's role mappings never appear in B");
    assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer service-key'));

    // Admin edits Server A; after the cache TTL A changes and B does not.
    tables.zb_guild_configs[0].custom_system_prompt = 'Ninja mode';
    now += 31_000;
    assert.equal((await store.getGuildContext(guild(GA))).config.custom_system_prompt, 'Ninja mode');
    assert.equal((await store.getGuildContext(guild(GB))).config.custom_system_prompt, 'Shakespeare mode');
});

test('store: a new server is seeded with safe defaults; the home server with legacy defaults', async () => {
    const tables = { zb_guild_configs: [], zb_role_mappings: [] };
    const { fetchImpl, calls } = fakeSupabase(tables);
    const store = new GuildConfigStore({ settings: baseSettings, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl, logger: { error() {} } });

    const fresh = await store.getGuildContext(guild(GA));
    assert.equal(fresh.source, 'default-seeded');
    assert.equal(fresh.config.default_tone, 'gentle');
    assert.equal(fresh.config.respond_to_all, false);
    assert.equal(fresh.config.memory_enabled, false);
    assert.ok(calls.some((c) => c.table === 'zb_guilds' && c.method === 'POST' && c.body[0].guild_id === GA));
    const seeded = tables.zb_guild_configs.find((r) => r.guild_id === GA);
    assert.equal(seeded.legacy_role_rules, false);

    const home = await store.getGuildContext(guild(HOME, OWNER));
    assert.equal(home.isHomeGuild, true);
    assert.equal(home.config.legacy_role_rules, true);
    assert.deepEqual(home.config.chat_channel_ids, [CH_GENERAL], 'home keeps env chat channels');
});

test('store: Supabase outages never crash the bot (stale cache, then defaults)', async () => {
    const tables = { zb_guild_configs: [{ guild_id: GA, custom_system_prompt: 'Cached' }], zb_role_mappings: [] };
    const { fetchImpl } = fakeSupabase(tables);
    let now = 0;
    const errors = [];
    const store = new GuildConfigStore({ settings: baseSettings, supabaseUrl: 'https://x.supabase.co', serviceRoleKey: 'k', fetchImpl, now: () => now, logger: { error: (m) => errors.push(m) } });
    await store.getGuildContext(guild(GA));
    tables.fail = true;
    now += 60_000;
    const stale = await store.getGuildContext(guild(GA));
    assert.equal(stale.source, 'stale-cache');
    assert.equal(stale.config.custom_system_prompt, 'Cached');
    const unknown = await store.getGuildContext(guild(GB));
    assert.equal(unknown.source, 'default-after-error');
    assert.equal(unknown.config.default_tone, 'gentle');
    assert.ok(errors.length >= 2);
});

test('store: legacy mode (no Supabase env) behaves exactly like the old env-configured bot', async () => {
    const store = new GuildConfigStore({ settings: baseSettings });
    assert.equal(store.mode, 'legacy');
    const ctx = await store.getGuildContext(guild(GA));
    assert.equal(ctx.mode, 'legacy');
    assert.equal(behaviorForMember(ctx, { roles: { cache: new Map() } }), null, 'no feature gating in legacy mode');
    const s = buildGuildSettings(baseSettings, ctx);
    assert.deepEqual(s.chatChannelIds, [CH_GENERAL]);
    assert.equal(s.autoReplyKeywords, true);
    assert.equal(s.logChannelId, baseSettings.logChannelId);
    assert.equal(await store.ensureGuild(guild(GA)), false);
});

test('home guild detection uses HOME_GUILD_IDS or the verified owner', () => {
    assert.equal(isHomeGuild(guild(HOME, OWNER), baseSettings), true);
    assert.equal(isHomeGuild(guild(GA, GA_OWNER), baseSettings), false);
    assert.equal(isHomeGuild(guild(GA, GA_OWNER), { ...baseSettings, homeGuildIds: [GA] }), true);
});

test('channel gating: blocked never, allow-list restricts, threads inherit parent', () => {
    const config = { allowed_channel_ids: [CH_GENERAL], blocked_channel_ids: [CH_SPAM], chat_channel_ids: [CH_GENERAL] };
    assert.equal(channelAllowed(config, { id: CH_GENERAL }), true);
    assert.equal(channelAllowed(config, { id: CH_SPAM }), false);
    assert.equal(channelAllowed(config, { id: '800000000000000003' }), false);
    assert.equal(channelAllowed(config, { id: '800000000000000004', parentId: CH_GENERAL }), true);
    assert.equal(channelAllowed({ allowed_channel_ids: [], blocked_channel_ids: [] }, { id: CH_SPAM }), true);
    assert.equal(isChatChannel(config, { id: '800000000000000005', parentId: CH_GENERAL }), true);
});

test('multi-mode settings never inherit the home log channel', () => {
    const ctx = { mode: 'multi', guildId: GA, config: { chat_channel_ids: [], log_channel_id: null, cooldown_seconds: 5, respond_to_all: false, auto_reply_keywords: false } };
    const s = buildGuildSettings(baseSettings, ctx);
    assert.equal(s.logChannelId, '');
    assert.equal(s.cooldownSeconds, 5);
    assert.equal(s.autoReplyKeywords, false);
    assert.notEqual(s, baseSettings, 'a fresh object per event');
});

// ---- authorization in other servers ----
function perms(...bits) {
    const set = new Set(bits);
    return { has: (bit) => set.has(bit) };
}
function member(id, roleIds, permissions) {
    const roles = new Map(roleIds.map((rid, i) => [rid, { id: rid, name: `role-${rid}`, position: i + 1 }]));
    roles.some = (fn) => [...roles.values()].some(fn);
    return { id, displayName: `user-${id}`, roles: { cache: roles }, permissions };
}
function guildMessage(authorId, m, { guildId = GA, ownerId = GA_OWNER } = {}) {
    return {
        author: { id: authorId },
        member: m,
        channel: { id: CH_GENERAL, name: 'general', send: async () => {} },
        guild: {
            id: guildId,
            ownerId,
            memberCount: 3,
            channels: { cache: { size: 1 } },
            members: { me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } }, cache: new Map() }
        }
    };
}
const multiCtx = (overrides = {}) => ({
    mode: 'multi',
    guildId: GA,
    isHomeGuild: false,
    config: { default_tone: 'gentle', memory_enabled: false, music_enabled: true, voice_enabled: true },
    mappings: [{ role_id: R_MOD, priority: 10, allowed_features: ['moderation'], denied_features: [] }],
    ...overrides
});

test('authorization: the real guild owner and Discord Administrators are allowed in their own server', () => {
    const settings = { ...baseSettings, guildContext: multiCtx() };
    assert.equal(isAuthorizedActor(guildMessage(GA_OWNER, member(GA_OWNER, [], perms())), settings, { action: 'kick_member' }).allowed, true);
    assert.equal(isAuthorizedActor(guildMessage('900000000000000001', member('900000000000000001', [], perms(PermissionFlagsBits.Administrator))), settings, { action: 'ban_member' }).allowed, true);
});

test('authorization: a moderator role needs BOTH the mapped feature AND the real Discord permission', () => {
    const settings = { ...baseSettings, guildContext: multiCtx() };
    const mod = '900000000000000002';
    // Mapped as moderator and actually has Kick Members -> allowed.
    assert.equal(isAuthorizedActor(guildMessage(mod, member(mod, [R_MOD], perms(PermissionFlagsBits.KickMembers))), settings, { action: 'kick_member' }).allowed, true);
    // Mapped as moderator but lacks Ban Members -> the mapping cannot grant it.
    const noBan = isAuthorizedActor(guildMessage(mod, member(mod, [R_MOD], perms(PermissionFlagsBits.KickMembers))), settings, { action: 'ban_member' });
    assert.equal(noBan.allowed, false);
    assert.match(noBan.reason, /Discord permission/);
    // Has Kick Members but no moderation mapping -> denied by the server's config.
    const unmapped = isAuthorizedActor(guildMessage(mod, member(mod, [R_VIP], perms(PermissionFlagsBits.KickMembers))), settings, { action: 'kick_member' });
    assert.equal(unmapped.allowed, false);
    assert.match(unmapped.reason, /roles are not allowed/);
    // Moderation mapping does not unlock admin_tools (role management).
    assert.equal(isAuthorizedActor(guildMessage(mod, member(mod, [R_MOD], perms(PermissionFlagsBits.ManageRoles))), settings, { action: 'create_role' }).allowed, false);
});

test('authorization: a context for another guild is never honoured (no cross-server leakage)', () => {
    const settings = { ...baseSettings, guildContext: multiCtx({ guildId: GB }) };
    const mod = '900000000000000002';
    assert.equal(isAuthorizedActor(guildMessage(mod, member(mod, [R_MOD], perms(PermissionFlagsBits.KickMembers))), settings, { action: 'kick_member' }).allowed, false);
});

test('authorization: home server owner path unchanged; random members still denied', async () => {
    const settings = { ...baseSettings, guildContext: multiCtx({ guildId: HOME, isHomeGuild: true }) };
    const ownerMsg = guildMessage(OWNER, member(OWNER, [], perms()), { guildId: HOME, ownerId: OWNER });
    assert.equal(isAuthorizedActor(ownerMsg, settings, { action: 'ban_member' }).allowed, true);
    const random = '900000000000000003';
    const result = await executeTool(guildMessage(random, member(random, [], perms()), { guildId: GA }), { ...baseSettings, guildContext: multiCtx() }, { action: 'create_role', role: 'x' });
    assert.match(result, /not allowed/);
});

test('member features: music can be switched off per server', async () => {
    const settings = { ...baseSettings, guildContext: multiCtx({ config: { default_tone: 'gentle', music_enabled: false } }) };
    const user = '900000000000000004';
    const result = await executeTool(guildMessage(user, member(user, [], perms())), settings, { action: 'queue_music' });
    assert.match(result, /Music commands are turned off/);
});

// ---- prompts ----
test('reply prompt: legacy path unchanged, multi path layered and identity-safe', () => {
    const legacy = buildReplySystemPrompt({ tone: 'savage' });
    assert.equal(legacy.startsWith(PLATFORM_SAFETY_RULES), false, 'legacy prompt untouched');
    assert.ok(legacy.includes(HOME_IDENTITY));

    const guest = buildReplySystemPrompt({ tone: 'savage', guildPrompt: { config: { server_rules: 'No spoilers.' }, behavior: null, isHomeGuild: false } });
    assert.ok(guest.startsWith(PLATFORM_SAFETY_RULES));
    assert.ok(guest.includes(GUEST_IDENTITY));
    assert.equal(guest.includes(HOME_IDENTITY), false);
    assert.match(guest, /No spoilers/);

    const neutral = buildReplySystemPrompt({ tone: 'neutral', guildPrompt: { config: {}, behavior: null, isHomeGuild: false } });
    assert.match(neutral, /friendly, helpful Discord assistant/);

    // Owner JARVIS treatment applies only in the home server.
    const ownerElsewhere = buildReplySystemPrompt({ tone: 'gentle', isOwner: true, guildPrompt: { config: {}, behavior: null, isHomeGuild: false } });
    assert.doesNotMatch(ownerElsewhere, /JARVIS/);
});

test('creator answer does not claim ZiG owns other servers', () => {
    assert.equal(getCreatorResponse('who made you'), creatorResponse);
    const guest = getCreatorResponse('who made you', { isHomeGuild: false });
    assert.match(guest, /not the owner of this server/);
    assert.doesNotMatch(guest, /main owner of this server/);
});

test('audit log never mirrors into another server\'s log channel', async () => {
    const sent = [];
    const message = {
        author: { id: '1' },
        guild: { id: GA },
        client: { channels: { fetch: async () => ({ guildId: HOME, isTextBased: () => true, send: async (t) => sent.push(t) }) } }
    };
    await auditLog({ message, settings: { logChannelId: '800000000000000099' }, event: 'X', action: 'y', result: 'OK' });
    assert.equal(sent.length, 0);
    message.client.channels.fetch = async () => ({ guildId: GA, isTextBased: () => true, send: async (t) => sent.push(t) });
    await auditLog({ message, settings: { logChannelId: '800000000000000099' }, event: 'X', action: 'y', result: 'OK' });
    assert.equal(sent.length, 1);
});

test('AI replies can never mass-ping a server', () => {
    assert.equal(neutralizeMassMentions('@everyone @here <@&123> <@456>'), '@​everyone @​here <@​&123> <@456>');
});
