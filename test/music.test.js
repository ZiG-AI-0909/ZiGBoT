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

test('YouTube URL detection only accepts https youtube hosts', () => {
    const { isYouTubeUrl } = require('../src/music/youtube');
    assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isYouTubeUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
    assert.equal(isYouTubeUrl('https://youtube.com.evil.example/watch'), false);
    assert.equal(isYouTubeUrl('kesariya'), false);
});

test('yt-dlp errors become short friendly messages', () => {
    const { friendlyError } = require('../src/music/youtube');
    assert.match(friendlyError('ERROR: [youtube] x: Sign in to confirm you’re not a bot'), /blocking/);
    assert.match(friendlyError('ERROR: [youtube] x: Private video'), /unavailable/);
    assert.match(friendlyError('something odd'), /Could not load/);
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
    assert.deepEqual(ids, ['pause', 'skip', 'stop', 'loop', 'voldown', 'volup', 'queue'].map((id) => PREFIX + id));

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
