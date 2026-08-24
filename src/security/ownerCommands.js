const { isServerOwner } = require('./authorization');

function getOwnerRoastTarget(message, botUserId, settings) {
    if (!isServerOwner(message, settings) || !/\broast\s+(him|her|them)\b/i.test(message.content)) {
        return null;
    }

    return [...message.mentions.users.values()]
        .find((user) => user.id !== botUserId && !user.bot) || null;
}

module.exports = { getOwnerRoastTarget };