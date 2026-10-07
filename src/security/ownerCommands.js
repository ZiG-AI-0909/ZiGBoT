const { isServerOwner } = require('./authorization');

function getOwnerRoastTarget(message, botUserId, settings) {
    if (!isServerOwner(message, settings) || !/\broast\s+(him|her|them)\b/i.test(message.content)) {
        return null;
    }

    return [...message.mentions.users.values()]
        .find((user) => user.id !== botUserId && !user.bot) || null;
}

function getOwnerMemoryTarget(message, botUserId, settings) {
    const asksAboutMember = /\b(?:what do you (?:know|remember) about|what (?:information|info) do you have about|tell me what you know about|what have you stored about)\b/i
        .test(message.content);
    if (!isServerOwner(message, settings) || !asksAboutMember) return null;

    return [...message.mentions.users.values()]
        .find((user) => user.id !== botUserId && !user.bot) || null;
}

module.exports = { getOwnerRoastTarget, getOwnerMemoryTarget };