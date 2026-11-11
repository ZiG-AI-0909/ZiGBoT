// One-time DM to server owners about AFK + the avatar viewer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOwnerMessage, groupByOwner } = require('../scripts/announce-owners');

test('message: lists the owner\'s servers, explains both features, fits in one DM', () => {
    const text = buildOwnerMessage({ servers: ['Chill Zone', 'Gaming Hub'] });
    assert.match(text, /\*\*Chill Zone\*\* and \*\*Gaming Hub\*\*/);
    assert.match(text, /afk I have work/);
    assert.match(text, /av @user/);
    assert.match(text, /Manage Nicknames/);
    assert.match(text, /one-time message/);
    assert.ok(text.length < 2000, `${text.length} characters`);
});

test('message: server names cannot ping or break the formatting', () => {
    const text = buildOwnerMessage({ servers: ['@everyone **party** <@123456789012345678>'] });
    assert.doesNotMatch(text, /@everyone|<@\d+>/);
    assert.doesNotMatch(text, /\*\*party\*\*/);
});

test('message: many servers are summarised, still one DM', () => {
    const text = buildOwnerMessage({ servers: Array.from({ length: 60 }, (_, i) => `Server number ${i} with a long name`) });
    assert.match(text, /and \d+ more/);
    assert.ok(text.length < 2000);
});

test('owners: one entry per owner, bots and ZiGBoT skipped', () => {
    const owners = groupByOwner([
        { id: '1', name: 'A', owner_id: '900000000000000001' },
        { id: '2', name: 'B', owner_id: '900000000000000001' },
        { id: '3', name: 'C', owner_id: '900000000000000002' },
        { id: '4', name: 'D', owner_id: 'not-an-id' }
    ], { skipIds: ['900000000000000002'] });
    assert.deepEqual(owners, [{ ownerId: '900000000000000001', servers: ['A', 'B'] }]);
});
