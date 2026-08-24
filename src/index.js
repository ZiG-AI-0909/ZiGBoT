require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { loadSettings } = require('./config/settings');
const { createAiClient } = require('./ai/client');
const { defaultMemory } = require('./ai/memory');
const { isGentleMember } = require('./ai/roleDetector');

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

    // ONLY reply if explicitly mentioned, replied to, or in a dedicated chat channel
    const shouldReply = isMentioned || isReplyToBot || inChatChannel || settings.respondToAllMessages;
    if (!shouldReply) return;

    // Clean user message by removing the @bot mention tag
    const userMessage = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();

    // Check if the member has a gentle / she/her role
    const isGentle = isGentleMember(message.member, settings.gentleRoleNames, message.guild?.id);
    const tone = isGentle ? 'gentle' : 'savage';

    // If a user just mentions @ZiGBoT without any text
    if (!userMessage) {
        if (isMentioned || isReplyToBot) {
            const greeting = isGentle
                ? "Hey bestie! ✨ Kya chal raha hai? Kuch share karna hai ya koi help chahiye? 🌸"
                : "Haan bhai, tag kiya hai toh bol bhi de. Kya dukh dard baantna hai?";
            await message.reply(greeting);
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
            tone
        });

        await message.reply(replyText);

        // Record message in conversation memory
        defaultMemory.addMessage(message.channel.id, 'user', userMessage, authorName);
        defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
    } catch (error) {
        console.error(`[ZiGBoT ERROR] ${error.message}`);
        await message.reply("😅 Dimaag crash ho gaya ek second ke liye! Ek baar wapas bol na.").catch(() => {});
    }
});

client.login(settings.discordToken);
