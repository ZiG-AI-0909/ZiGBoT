const test = require('node:test');
const assert = require('node:assert/strict');
const music = require('../src/music/player');

test('music queue accepts HTTPS sources and rejects other protocols', () => {
    const added = music.addTrack('music-test', 'https://audio.example/track.mp3', 'owner');
    assert.equal(added.position, 1);
    assert.equal(music.queue('music-test').tracks.length, 1);
    assert.throws(() => music.addTrack('music-test', 'http://audio.example/track.mp3', 'owner'), /HTTPS/);
    music.clearGuild('music-test');
});

test('resolve keeps direct audio URLs local and rejects Spotify and http', async () => {
    const direct = await music.resolve('  https://audio.example/track.mp3 ');
    assert.deepEqual(direct, { source: 'direct', url: 'https://audio.example/track.mp3', title: null, duration: null });
    await assert.rejects(music.resolve('https://open.spotify.com/track/abc'), /Spotify/);
    await assert.rejects(music.resolve('http://audio.example/track.mp3'), /HTTPS/);
    await assert.rejects(music.resolve('   '), /song name or link/);
});

test('URL detection only accepts https YouTube / SoundCloud hosts', () => {
    const { isYouTubeUrl, sourceOfUrl } = require('../src/music/sources');
    assert.equal(sourceOfUrl('https://soundcloud.com/alanwalker/faded'), 'soundcloud');
    assert.equal(sourceOfUrl('https://soundcloud.com.evil.example/x'), null);
    assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
    assert.equal(isYouTubeUrl('https://youtube.com.evil.example/watch'), false);
    assert.equal(isYouTubeUrl('kesariya'), false);
});

test('yt-dlp errors become short friendly messages', () => {
    const { friendlyError, isHostBlocked } = require('../src/music/sources');
    assert.match(friendlyError('ERROR: [youtube] x: Sign in to confirm you’re not a bot'), /refused/);
    assert.match(friendlyError('ERROR: [youtube] x: HTTP Error 403: Forbidden'), /refused/);
    assert.match(friendlyError('ERROR: [youtube] x: Private video'), /unavailable/);
    assert.match(friendlyError('something odd'), /Could not load/);
    assert.equal(isHostBlocked(friendlyError('ERROR: x: Sign in to confirm you’re not a bot')), true);
    assert.equal(isHostBlocked(friendlyError('ERROR: x: Private video')), false);
});

test('queue shows titles and durations', () => {
    music.queueTrack('music-title-test', { source: 'youtube', url: 'https://www.youtube.com/watch?v=BddP6PYo2gs', title: 'Kesariya', duration: 173 }, 'owner');
    const { tracks } = music.queue('music-title-test');
    assert.equal(music.describeTrack(tracks[0]), '**Kesariya** (2:53)');
    assert.equal(music.formatDuration(3725), '1:02:05');
    music.clearGuild('music-title-test');
});

test('music volume is bounded', () => {
    assert.equal(music.setVolume('music-volume-test', 50), 50);
    assert.throws(() => music.setVolume('music-volume-test', 101), /between 0 and 100/);
    music.clearGuild('music-volume-test');
});

test('music panel shows the song, volume and the right buttons', () => {
    const { buildPanel, BUTTON_ACTIONS, PREFIX } = require('../src/music/panel');
    const guildId = 'music-panel-test';
    music.queueTrack(guildId, { source: 'youtube', url: 'https://www.youtube.com/watch?v=BddP6PYo2gs', title: 'Kesariya', duration: 173 }, '900000000000000099');
    music.queueTrack(guildId, { source: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Never Gonna Give You Up', duration: 213 }, '900000000000000099');
    music.setVolume(guildId, 40);

    const payload = buildPanel(guildId);
    const embed = payload.embeds[0].toJSON();
    assert.match(embed.fields.find((f) => f.name === 'Volume').value, /40%/);
    assert.match(embed.fields.find((f) => f.name === 'Up next').value, /Kesariya/);
    const ids = payload.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
    assert.deepEqual(ids, ['pause', 'skip', 'stop', 'loop', 'voldown', 'volup', 'shuffle', 'queue'].map((id) => PREFIX + id));

    // Volume buttons move in steps of 10 and stay within 0-100.
    assert.deepEqual(BUTTON_ACTIONS.volup({ volume: 95 }), { action: 'volume_music', volume: 100 });
    assert.deepEqual(BUTTON_ACTIONS.voldown({ volume: 5 }), { action: 'volume_music', volume: 0 });
    music.clearGuild(guildId);
});

test('stopping music emits finished so the panel can close', () => {
    const guildId = 'music-finish-test';
    const seen = [];
    const listener = (id, reason) => { if (id === guildId) seen.push(reason); };
    music.events.on('finished', listener);
    music.addTrack(guildId, 'https://audio.example/a.mp3', 'owner');
    music.stop(guildId);
    music.events.off('finished', listener);
    assert.deepEqual(seen, ['stopped']);
    music.clearGuild(guildId);
});

test('yt-dlp results become tracks; live, too-long and bad ids are dropped', () => {
    const { toTrack } = require('../src/music/sources');
    const yt = toTrack({ id: '60ItHLz5WEA', title: 'Alan Walker - Faded', duration: 213, channel: 'Alan Walker' }, 'youtube');
    assert.deepEqual(yt, { source: 'youtube', url: 'https://www.youtube.com/watch?v=60ItHLz5WEA', title: 'Alan Walker - Faded', artist: 'Alan Walker', duration: 213, thumbnail: 'https://i.ytimg.com/vi/60ItHLz5WEA/mqdefault.jpg' });
    const sc = toTrack({ id: '1', title: 'Faded', duration: 211.9, uploader: 'Alan Walker', url: 'https://api.soundcloud.com/tracks/1', webpage_url: 'https://soundcloud.com/alanwalker/faded', thumbnails: [{ id: 't300x300', url: 'https://i1.sndcdn.com/a-t300x300.jpg' }] }, 'soundcloud');
    assert.equal(sc.url, 'https://soundcloud.com/alanwalker/faded');
    assert.equal(sc.duration, 212);
    assert.equal(sc.thumbnail, 'https://i1.sndcdn.com/a-t300x300.jpg');
    assert.equal(toTrack({ id: '60ItHLz5WEA', live_status: 'is_live' }, 'youtube'), null);
    assert.equal(toTrack({ id: '60ItHLz5WEA', duration: 4 * 3600 }, 'youtube'), null);
    assert.equal(toTrack({ id: 'bad id' }, 'youtube'), null);
});

test('queues are isolated per server; shuffle, remove and clear work', () => {
    const a = 'music-iso-a';
    const b = 'music-iso-b';
    for (const n of [1, 2, 3, 4]) music.addTrack(a, `https://audio.example/${n}.mp3`, 'u');
    music.addTrack(b, 'https://audio.example/b.mp3', 'u');
    assert.equal(music.queue(a).tracks.length, 4);
    assert.equal(music.queue(b).tracks.length, 1);
    assert.equal(music.shuffle(a), 4);
    assert.deepEqual(music.queue(a).tracks.map((t) => t.url).sort(), [1, 2, 3, 4].map((n) => `https://audio.example/${n}.mp3`));
    const removed = music.remove(a, 2);
    assert.equal(music.queue(a).tracks.length, 3);
    assert.equal(music.queue(a).tracks.includes(removed), false);
    assert.throws(() => music.remove(a, 9), /between 1 and 3/);
    assert.equal(music.clearQueue(a), 3);
    assert.equal(music.queue(a).tracks.length, 0);
    assert.equal(music.queue(b).tracks.length, 1);
    music.clearGuild(a);
    music.clearGuild(b);
});

test('loop cycles off -> song -> queue -> off and rejects bad modes', () => {
    const g = 'music-loop-test';
    assert.equal(music.toggleLoop(g), 'track');
    assert.equal(music.toggleLoop(g), 'queue');
    assert.equal(music.toggleLoop(g), 'off');
    assert.equal(music.setLoop(g, 'queue'), 'queue');
    assert.throws(() => music.setLoop(g, 'forever'), /track, queue or off/);
    music.clearGuild(g);
});

test('per-server default volume applies only at the start of a session', () => {
    const g = 'music-config-test';
    music.configure(g, { idleMinutes: 5, defaultVolume: 35 });
    assert.equal(music.queue(g).volume, 35);
    music.configure(g, { defaultVolume: 500 });
    assert.equal(music.queue(g).volume, 35);
    music.clearGuild(g);
});

test('DJ role and request channel rules', () => {
    const { musicAccessProblem } = require('../src/music/access');
    const botChannel = { id: 'vc1', members: new Map([['bot', { user: { bot: true } }], ['u1', { user: { bot: false } }], ['u2', { user: { bot: false } }]]) };
    const guild = { ownerId: 'owner', members: { me: { voice: { channel: botChannel } } } };
    const member = (id, roles = [], perms = false, channelId = 'vc1') => ({
        id, guild, voice: { channelId }, roles: { cache: new Map(roles.map((r) => [r, {}])) }, permissions: { has: () => perms }
    });
    const config = { music_dj_role_ids: ['dj'], music_channel_id: 'music' };

    assert.match(musicAccessProblem({ action: 'play', member: member('u1'), channel: { id: 'general' }, config }), /requests go in/);
    assert.equal(musicAccessProblem({ action: 'play', member: member('u1'), channel: { id: 'music' }, config }), null);
    assert.match(musicAccessProblem({ action: 'skip_music', member: member('u1'), channel: { id: 'music' }, config }), /Only DJs/);
    assert.equal(musicAccessProblem({ action: 'skip_music', member: member('u1', ['dj']), channel: {}, config }), null);
    assert.equal(musicAccessProblem({ action: 'skip_music', member: member('u1', [], true), channel: {}, config }), null);
    assert.equal(musicAccessProblem({ action: 'skip_music', member: member('u1'), channel: {}, config, currentTrack: { requestedBy: 'u1' } }), null);
    assert.match(musicAccessProblem({ action: 'pause_music', member: member('u1', ['dj'], false, 'elsewhere'), channel: {}, config }), /Join <#vc1>/);
    assert.equal(musicAccessProblem({ action: 'pause_music', member: member('u1'), channel: {}, config: {} }), null);
    assert.equal(musicAccessProblem({ action: 'queue_music', member: member('u1', [], false, 'elsewhere'), channel: {}, config }), null);
});

test('music state row for the dashboard', () => {
    const { stateRow } = require('../src/music/status');
    const row = stateRow('900000000000000001', {
        current: { source: 'soundcloud', url: 'https://soundcloud.com/a/b', title: 'Faded', artist: 'Alan Walker', duration: 212, requestedBy: '42', fallbackFrom: 'youtube', announce: () => {}, channel: {} },
        tracks: [], loop: 'queue', volume: 70, paused: false
    }, 0);
    assert.equal(row.status, 'playing');
    assert.equal(row.current_track.fallback_from, 'youtube');
    assert.equal('announce' in row.current_track, false);
    assert.equal(row.loop_mode, 'queue');
    assert.equal(stateRow('900000000000000001', { current: null, tracks: [], loop: 'off', volume: 80, paused: false }).status, 'idle');
});

test('a YouTube track the host cannot stream falls back to the same song on SoundCloud', async () => {
    const sources = require('../src/music/sources');
    const original = { openStream: sources.openStream, findAlternative: sources.findAlternative };
    const opened = [];
    const notes = [];
    sources.openStream = async (url) => {
        opened.push(url);
        if (url.includes('youtube.com')) throw new Error(sources.friendlyError('ERROR: [youtube] x: Sign in to confirm you’re not a bot'));
        return { stdout: 'fake-audio' };
    };
    sources.findAlternative = async () => ({ source: 'soundcloud', url: 'https://soundcloud.com/yoyohoneysingh59080/casa-tupka-anthemo-feat', title: 'Casa Tupka Anthemo', artist: 'Yo Yo Honey Singh', duration: 186, thumbnail: null });
    try {
        const track = { source: 'youtube', url: 'https://www.youtube.com/watch?v=60ItHLz5WEA', title: 'Casa Tupka Anthemo | Full Video', announce: (text) => notes.push(text) };
        const child = await music._openSearchedTrack(track);
        assert.equal(child.stdout, 'fake-audio');
        assert.deepEqual(opened, ['https://www.youtube.com/watch?v=60ItHLz5WEA', 'https://soundcloud.com/yoyohoneysingh59080/casa-tupka-anthemo-feat']);
        assert.equal(track.source, 'soundcloud');
        assert.equal(track.fallbackFrom, 'youtube');
        await new Promise((r) => setImmediate(r));
        assert.match(notes[0], /playing it from SoundCloud/);

        // Unavailable (not blocked) videos are reported, not swapped for something else.
        sources.openStream = async () => { throw new Error(sources.friendlyError('ERROR: [youtube] x: Private video')); };
        await assert.rejects(music._openSearchedTrack({ source: 'youtube', url: 'https://www.youtube.com/watch?v=60ItHLz5WEA', title: 'x' }), /unavailable/);
    } finally {
        Object.assign(sources, original);
    }
});
