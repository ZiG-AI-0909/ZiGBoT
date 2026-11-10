const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyVoteSecret, parseVote, installThanks, VOTE_URL, VOTE_THANKS, VOTE_LINE } = require('../dashboard/lib/shared/botList');
const { createStatsPoster } = require('../src/botlists/discordBotList');
const { WELCOME_MESSAGE } = require('../src/guildConfig/setup');

const SECRET = 'a-long-random-vote-secret-123';

test('vote webhook: only our exact secret is accepted', () => {
    assert.equal(verifyVoteSecret(SECRET, SECRET), true);
    for (const bad of ['', 'wrong', `${SECRET} `, `Bearer ${SECRET}`, null]) assert.equal(verifyVoteSecret(bad, SECRET), false, String(bad));
    assert.equal(verifyVoteSecret('short', 'short'), false, 'a too-short secret never counts as configured');
    assert.equal(verifyVoteSecret('', ''), false);
});

test('votes need a real Discord user id', () => {
    assert.deepEqual(parseVote({ id: '900000000000000001', username: ' zig ', avatar: 'x', admin: false }), { site: 'discordbotlist', user_discord_id: '900000000000000001', user_name: 'zig' });
    assert.equal(parseVote({ id: 'abc', username: 'x' }), null);
    assert.equal(parseVote(null), null);
});

test('every ask links the upvote page without a preview card', () => {
    for (const text of [VOTE_THANKS, VOTE_LINE, installThanks('Chill Zone'), WELCOME_MESSAGE]) assert.ok(text.includes(`<${VOTE_URL}>`), text);
    assert.match(installThanks('Chill Zone'), /\*\*Chill Zone\*\*/);
    assert.match(installThanks(null), /Thanks for adding ZiGBoT!/);
});

test('server count: posts guilds, falls back to a "Bot " token once and remembers it', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
        return { ok: init.headers.Authorization.startsWith('Bot '), status: init.headers.Authorization.startsWith('Bot ') ? 200 : 401 };
    };
    const poster = createStatsPoster({ token: 't0k', botId: '1539530458390593576', fetchImpl, logger: { error() {} } });
    assert.equal(await poster.post({ guilds: 5 }), true);
    assert.equal(calls[0].url, 'https://discordbotlist.com/api/v1/bots/1539530458390593576/stats');
    assert.deepEqual(calls.map((c) => c.auth), ['t0k', 'Bot t0k']);
    assert.deepEqual(calls[1].body, { guilds: 5 });
    await poster.post({ guilds: 6 });
    assert.equal(calls[2].auth, 'Bot t0k', 'remembered');
    assert.equal(await createStatsPoster({ token: '', botId: '1539530458390593576', fetchImpl }).post({ guilds: 1 }), false, 'no token, no request');
    assert.equal(calls.length, 3);
});
