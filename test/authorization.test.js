const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwner, ownerAuthorization } = require('../src/security/authorization');

const settings = { serverOwnerId: 'owner-123' };

function message(authorId, guildOwnerId = 'owner-123') {
    return { author: { id: authorId }, guild: { ownerId: guildOwnerId } };
}

test('only the configured server owner is authorized', () => {
    assert.equal(isOwner('owner-123', settings), true);
    assert.equal(isOwner('admin-456', settings), false);
    assert.equal(ownerAuthorization(message('admin-456'), settings).allowed, false);
});

test('configured owner must match the actual Discord guild owner', () => {
    assert.equal(ownerAuthorization(message('owner-123', 'different-owner'), settings).allowed, false);
    assert.equal(ownerAuthorization(message('owner-123'), settings).allowed, true);
});

test('missing owner configuration denies authorization', () => {
    assert.equal(ownerAuthorization(message('owner-123'), { serverOwnerId: '' }).allowed, false);
});
