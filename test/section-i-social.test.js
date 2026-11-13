// Section I: RSS / Reddit / YouTube-upload feeds, Twitch live alerts, and SSRF-safe fetching.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const shared = require('../dashboard/lib/shared');
const { MemoryFeatureStore } = require('../src/features/store');
const { createScheduler } = require('../src/features/scheduler');
const { createSocial, createTwitchApi, parseFeed, feedUrl } = require('../src/features/social');
const netSafe = require('../src/features/net');

const G = '900000000000000001';
const CH = '300000000000000001';
const ROLE = '400000000000000001';

class Coll extends Map {}

// ------------------------------------------------------------------ SSRF
test('SSRF: private, loopback, link-local, metadata and internal addresses are blocked', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '224.0.0.1']) {
        assert.equal(netSafe.isBlockedAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '151.101.1.140', '2606:4700::6810:84e5']) assert.equal(netSafe.isBlockedAddress(ip), false, ip);
});

test('SSRF: unsafe URLs are refused before any connection', async () => {
    const cases = [
        ['http://example.com/feed', /Only https/],
        ['https://127.0.0.1/feed', /Internal addresses/],
        ['https://169.254.169.254/latest/meta-data/', /Internal addresses/],
        ['https://[::1]/feed', /Internal addresses/],
        ['https://localhost/feed', /Internal hostnames/],
        ['https://intranet.local/feed', /Internal hostnames/],
        ['https://user:pass@example.com/feed', /credentials/],
        ['https://example.com:8443/feed', /standard https port/],
        ['file:///etc/passwd', /Only https/],
        ['not a url', /valid URL/]
    ];
    for (const [url, pattern] of cases) await assert.rejects(netSafe.safeFetchText(url), pattern, url);
});

test('SSRF: a hostname that resolves to an internal address is refused at connect time (DNS rebinding safe)', async () => {
    const rebinding = (host, opts, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]);
    await assert.rejects(netSafe.safeFetchText('https://innocent-looking.example/feed', { resolver: rebinding }), /internal address/);
    const lookup = netSafe.guardedLookup((host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]));
    await new Promise((resolve) => lookup('mixed.example', {}, (error) => { assert.match(error.message, /internal address/); resolve(); }));
    const okLookup = netSafe.guardedLookup((host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
    await new Promise((resolve) => okLookup('fine.example', {}, (error, address) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); resolve(); }));
});

test('SSRF: every redirect hop is checked again', async () => {
    const hops = [];
    const request = async (url) => { hops.push(url.toString()); return hops.length === 1 ? { redirect: 'https://127.0.0.1/admin' } : { body: 'x' }; };
    await assert.rejects(netSafe.safeFetchText('https://feeds.example/rss', { request }), /Internal addresses/);
    assert.equal(hops.length, 1, 'the internal target was never requested');
    const loop = async () => ({ redirect: 'https://feeds.example/again' });
    await assert.rejects(netSafe.safeFetchText('https://feeds.example/rss', { request: loop }), /Too many redirects/);
});

test('SSRF: a real request to a local server is refused, even though it is listening', async () => {
    const server = http.createServer((req, res) => res.end('secret'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await assert.rejects(netSafe.safeFetchText(`https://127.0.0.1:${port}/`), /standard https port|Internal/);
        const toLocal = (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
        await assert.rejects(netSafe.safeFetchText('https://looks-public.example/', { resolver: toLocal }), /internal address/);
    } finally {
        server.close();
    }
});

// ---------------------------------------------------------------- parsing
const RSS = `<?xml version="1.0"?><rss><channel><title>Blog</title>
<item><title>Third &amp; newest</title><link>https://blog.example/3</link><guid>g3</guid></item>
<item><title><![CDATA[Second <b>post</b>]]></title><link>https://blog.example/2</link><guid>g2</guid></item>
<item><title>First</title><link>javascript:alert(1)</link><guid>g1</guid></item>
</channel></rss>`;
const ATOM = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId><title>New video</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc"/></entry></feed>`;

test('RSS and Atom parsing: titles decoded, only https links kept', () => {
    assert.deepEqual(parseFeed(RSS), [
        { id: 'g3', title: 'Third & newest', link: 'https://blog.example/3' },
        { id: 'g2', title: 'Second <b>post</b>', link: 'https://blog.example/2' },
        { id: 'g1', title: 'First', link: '' }
    ]);
    assert.deepEqual(parseFeed(ATOM), [{ id: 'yt:video:abc', title: 'New video', link: 'https://www.youtube.com/watch?v=abc' }]);
    assert.deepEqual(parseFeed('garbage'), []);
    assert.equal(feedUrl({ type: 'reddit', source: 'discordapp' }), 'https://www.reddit.com/r/discordapp/new/.rss');
    assert.equal(feedUrl({ type: 'youtube', source: 'UC1L2NJBYEC2Z4exBvhku6wQ' }), 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1L2NJBYEC2Z4exBvhku6wQ');
});

test('settings: social is off by default; sources are validated per type; polling is at least 5 minutes', () => {
    const d = shared.defaultFeatureSettings().social;
    assert.deepEqual([d.feeds_enabled, d.twitch_enabled, d.poll_minutes], [false, false, 10]);
    const ids = { channelIds: new Set([CH]), roleIds: new Set([ROLE]), guildId: G };
    const err = (input) => Object.values(shared.validateFeatureSettings({ social: input }, ids).errors).join(' ');
    assert.match(err({ feeds: [{ type: 'rss', source: 'http://insecure.example/feed', channel_id: CH }] }), /https/);
    assert.match(err({ feeds: [{ type: 'reddit', source: 'r/bad name', channel_id: CH }] }), /subreddit/);
    assert.match(err({ feeds: [{ type: 'youtube', source: '@handle', channel_id: CH }] }), /starts with UC/);
    assert.match(err({ twitch: [{ login: 'x', channel_id: CH }] }), /Twitch username/);
    assert.match(err({ poll_minutes: 1 }), /from 5/);
    assert.equal(err({ feeds: [{ type: 'reddit', source: 'discordapp', channel_id: CH }], twitch: [{ login: 'shroud', channel_id: CH, role_id: ROLE }] }), '');
});

// --------------------------------------------------------------- polling
function fixture(socialSettings, { feedBodies = {}, streams = [] } = {}) {
    let t = 10_000_000;
    const sent = [];
    const fetched = [];
    const channel = { id: CH, isTextBased: () => true, send: async (p) => sent.push(p) };
    const guild = { id: G, channels: { cache: new Coll([[CH, channel]]) } };
    const config = { enabled: true, feature_settings: shared.defaultFeatureSettings() };
    Object.assign(config.feature_settings.social, socialSettings);
    const store = new MemoryFeatureStore({ now: () => t });
    const scheduler = createScheduler({ store, now: () => t, logger: { error() {} } });
    const twitch = { enabled: true, liveStreams: async () => streams };
    const social = createSocial({ store, scheduler, now: () => t, logger: { error() {} }, twitch,
        resolveContext: async () => ({ config, settings: {} }),
        getClient: () => ({ guilds: { cache: new Coll([[G, guild]]) } }),
        fetchText: async (url) => { fetched.push(url); if (feedBodies[url] instanceof Error) throw feedBodies[url]; return feedBodies[url]; } });
    return { social, sent, fetched, store, scheduler, feedBodies, setStreams: (s) => { streams.length = 0; streams.push(...s); }, advance: (ms) => { t += ms; }, config };
}

test('feeds: the first poll posts nothing, then only new items, oldest first, at most 3, never pinging', async () => {
    const url = 'https://blog.example/rss';
    const f = fixture({ feeds_enabled: true, feeds: [{ type: 'rss', source: url, channel_id: CH }] }, { feedBodies: { [url]: RSS } });
    await f.scheduler.tick();
    assert.equal(f.sent.length, 0, 'no flood of old posts');
    const items = (n) => Array.from({ length: n }, (_, i) => `<item><title>New ${i}</title><link>https://blog.example/n${i}</link><guid>n${i}</guid></item>`).join('');
    f.feedBodies[url] = `<rss><channel>${items(5)}${RSS.slice(RSS.indexOf('<item>'))}`;
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.deepEqual(f.sent.map((p) => p.content.split('\n')[0]), ['📰 New post: **New 2**', '📰 New post: **New 1**', '📰 New post: **New 0**']);
    assert.ok(f.sent.every((p) => p.allowedMentions.parse.length === 0));
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 3, 'nothing new: nothing posted');
});

test('feeds respect the poll interval (minimum 5 minutes) and survive a failing feed', async () => {
    const good = 'https://www.reddit.com/r/discordapp/new/.rss';
    const bad = 'https://broken.example/rss';
    const f = fixture({ feeds_enabled: true, poll_minutes: 5, feeds: [{ type: 'rss', source: bad, channel_id: CH }, { type: 'reddit', source: 'discordapp', channel_id: CH }] }, { feedBodies: { [good]: RSS, [bad]: new Error('HTTP 500') } });
    await f.scheduler.tick();
    await f.scheduler.tick();
    assert.equal(f.fetched.filter((u) => u === good).length, 1, 'not polled again within 5 minutes');
    f.advance(5 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.fetched.filter((u) => u === good).length, 2, 'a failing feed does not stop the others');
});

test('Twitch: one alert per stream, with the configured role ping only, and none on the first check', async () => {
    const f = fixture({ twitch_enabled: true, twitch: [{ login: 'Shroud', channel_id: CH, role_id: ROLE }] });
    await f.scheduler.tick();
    f.setStreams([{ id: 's1', user_login: 'shroud', user_name: 'shroud', title: 'Ranked @everyone', game_name: 'Valorant' }]);
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].content, new RegExp(`^<@&${ROLE}> 🟣 \\*\\*shroud\\*\\* is live on Twitch: Ranked @​everyone \\(Valorant\\)\\nhttps://twitch.tv/shroud$`));
    assert.deepEqual(f.sent[0].allowedMentions, { parse: [], roles: [ROLE] });
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 1, 'same stream: no repeat');
    f.setStreams([]);
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    f.setStreams([{ id: 's2', user_login: 'shroud', user_name: 'shroud', title: 'Back', game_name: '' }]);
    f.advance(11 * 60_000);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 2, 'a new stream after going offline alerts again');
});

test('Twitch API client: client-credentials token reused until expiry, official Helix endpoint only', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push(url);
        if (url.startsWith('https://id.twitch.tv/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
        return { ok: true, status: 200, json: async () => ({ data: [{ user_login: 'a' }] }), headers: init.headers };
    };
    const api = createTwitchApi({ clientId: 'id', clientSecret: 'secret', fetchImpl });
    await api.liveStreams(['a', 'b']);
    await api.liveStreams(['a']);
    assert.equal(calls.filter((u) => u.includes('oauth2')).length, 1);
    assert.ok(calls.filter((u) => !u.includes('oauth2')).every((u) => u.startsWith('https://api.twitch.tv/helix/streams?user_login=')));
    assert.equal(createTwitchApi({ clientId: '', clientSecret: '' }).enabled, false, 'without env vars Twitch stays off');
});

test('a server that is switched off is never polled', async () => {
    const f = fixture({ feeds_enabled: true, feeds: [{ type: 'rss', source: 'https://blog.example/rss', channel_id: CH }] });
    f.config.enabled = false;
    await f.scheduler.tick();
    assert.deepEqual(f.fetched, []);
});
