require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { loadSettings } = require('./config/settings');
const { createAiClient } = require('./ai/client');
const { defaultMemory } = require('./ai/memory');
const { detectTrigger, defaultTracker } = require('./ai/triggerDetector');
const { isGentleMember, getMemberGender, isNonGentleMember } = require('./ai/roleDetector');
const { isServerOwner } = require('./security/authorization');
const { getOwnerRoastTarget } = require('./security/ownerCommands');

function logAiError(error) {
    const providerError = error?.error;
    const details = [
        error?.status && `status=${error.status}`,
        error?.code && `code=${error.code}`,
        providerError?.type && `type=${providerError.type}`,
        providerError?.code && `providerCode=${providerError.code}`,
        providerError?.message || error?.message || 'Unknown AI error'
    ].filter(Boolean).join(' | ');
    console.error(`[ZiGBoT AI ERROR] ${details}`);
}

const aiFailureReply = 'I am dead';

const settings = loadSettings();
const ai = createAiClient(settings);
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.once(Events.ClientReady, (c) => {
    console.log(`✅ ${c.user.tag} is online and ready! (Mention-driven mode with role-based personas active)`);
});

client.on(Events.MessageCreate, async (message) => {
    // Ignore all bots
    if (message.author.bot || !client.user) return;

    // Check if the bot is directly mentioned (@ZiGBoT) by any user or owner
    const isMentioned = message.mentions.users.has(client.user.id) ||
        message.content.includes(`<@${client.user.id}>`) ||
        message.content.includes(`<@!${client.user.id}>`);

    // Check if the user is directly replying to a message originally sent by ZiGBoT
    let isReplyToBot = false;
    if (message.reference && message.reference.messageId) {
        try {
            const referenced = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (referenced && referenced.author.id === client.user.id) {
                isReplyToBot = true;
            }
        } catch {
            isReplyToBot = false;
        }
    }

    const inChatChannel = settings.chatChannelIds.includes(message.channel.id);
    const trigger = settings.autoReplyKeywords
        ? detectTrigger(message.content)
        : { matched: false };

    // Reply to explicit interactions, configured chat channels, or enabled keywords.
    const shouldReply = isMentioned || isReplyToBot || inChatChannel || settings.respondToAllMessages || trigger.matched;
    if (!shouldReply) return;

    if (trigger.matched) {
        if (!defaultTracker.canTrigger(message.channel.id, message.author.id, settings.cooldownSeconds)) return;
        defaultTracker.recordTrigger(message.channel.id, message.author.id);
    }

    // Clean user message by removing the @bot mention tag
    const userMessage = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();

    const isOwner = isServerOwner(message, settings);
    const isNonGentle = isNonGentleMember(message.member, settings.nonGentleRoleNames);
    const isGentle = !isOwner && !isNonGentle && isGentleMember(
        message.member,
        settings.gentleRoleNames,
        message.guild?.id,
        settings.nonGentleRoleNames
    );
    const tone = isGentle ? 'gentle' : 'savage';
    const gender = getMemberGender(
        message.member,
        settings.femaleRoleNames,
        settings.maleRoleNames
    );

    // If a user just mentions @ZiGBoT without any text
    if (!userMessage) {
        if (isMentioned || isReplyToBot) {
            const greeting = isGentle
                ? (isOwner
                    ? "Hello, Sir. ZiGBoT online. Your Users.heer roast mode is active. Who are we cooking today?"
                    : "Hey! ✨ Kya chal raha hai? Kuch share karna hai ya koi help chahiye? 🌸")
                : "Haan, tag kiya hai toh bol bhi de. Kya dukh dard baantna hai?";
            await message.reply(greeting);
        }
        return;
    }

    const ownerRoastTarget = getOwnerRoastTarget(message, client.user.id, settings);
    if (ownerRoastTarget) {
        const targetMember = message.guild.members.cache.get(ownerRoastTarget.id);
        const targetName = targetMember?.displayName || ownerRoastTarget.globalName || ownerRoastTarget.username;

        try {
            await message.channel.sendTyping();
            const history = defaultMemory.getHistory(message.channel.id);
            const replyText = await ai.reply({
                userMessage: `Roast the mentioned target named ${targetName}. Keep the roast directed only at that target, not the server owner or ZiGBoT.`,
                authorName: targetName,
                contextMessages: history,
                tone: 'savage',
                gender: getMemberGender(
                    targetMember,
                    settings.femaleRoleNames,
                    settings.maleRoleNames
                )
            });

            await message.reply(replyText);
            defaultMemory.addMessage(message.channel.id, 'user', userMessage, message.author.username);
            defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
        } catch (error) {
            logAiError(error);
            await message.reply(aiFailureReply).catch(() => {});
        }
        return;
    }

    const authorName = message.member?.displayName || message.author.username;

    try {
        await message.channel.sendTyping();

        const history = defaultMemory.getHistory(message.channel.id);
        const replyText = await ai.reply({
            userMessage,
            authorName,
            contextMessages: history,
            tone,
            gender,
            isOwner,
            isNonGentle
        });

        await message.reply(replyText);

        // Record message in conversation memory
        defaultMemory.addMessage(message.channel.id, 'user', userMessage, authorName);
        defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
    } catch (error) {
        logAiError(error);
        await message.reply(aiFailureReply).catch(() => {});
    }
});

client.login(settings.discordToken);
