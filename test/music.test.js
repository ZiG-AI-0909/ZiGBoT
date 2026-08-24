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

test('music volume is bounded', () => {
    assert.equal(music.setVolume('music-volume-test', 50), 50);
    assert.throws(() => music.setVolume('music-volume-test', 101), /between 0 and 100/);
    music.clearGuild('music-volume-test');
});
