const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwner, isServerOwner, ownerAuthorization } = require('../src/security/authorization');

const settings = { serverOwnerId: 'owner-123' };
const zigServerOwnerId = '1296202178263912448';

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

test('ZiG server owner ID is recognized as the configured owner', () => {
    const zigSettings = { serverOwnerId: zigServerOwnerId };
    assert.equal(isOwner(zigServerOwnerId, zigSettings), true);
    assert.equal(isOwner('different-user', zigSettings), false);
    assert.equal(ownerAuthorization(message(zigServerOwnerId, zigServerOwnerId), zigSettings).allowed, true);
});

test('only the actual configured server owner receives owner status', () => {
    const zigSettings = { serverOwnerId: zigServerOwnerId };
    assert.equal(isServerOwner(message(zigServerOwnerId, zigServerOwnerId), zigSettings), true);
    assert.equal(isServerOwner(message('different-user', zigServerOwnerId), zigSettings), false);
    assert.equal(isServerOwner(message(zigServerOwnerId, 'different-owner'), zigSettings), false);
});
