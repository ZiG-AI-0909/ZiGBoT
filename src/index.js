require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { loadSettings } = require('./config/settings');
const { createAiClient, classifyIntent, isCrisisMessage, crisisResponse } = require('./ai/client');
const { defaultMemory } = require('./ai/memory');
const { RateLimiter } = require('./ai/rateLimiter');
const { detectTrigger, defaultTracker } = require('./ai/triggerDetector');
const { isGentleMember, getMemberGender, isNonGentleMember } = require('./ai/roleDetector');
const { isServerOwner } = require('./security/authorization');
const { getOwnerRoastTarget } = require('./security/ownerCommands');
const { requestConfirmation } = require('./security/confirmation');
const { executeTool, destructiveActions } = require('./tools/router');
const { buildVoiceTranscriptRoute } = require('./routing/voiceRoute');
const { speak, isListening } = require('./voice/voiceConversation');
const {
    shouldSkipReply,
    pickReactionEmoji,
    deliverAiReply
} = require('./reply/delivery');
const { detectProfanityAtBot } = require('./ai/profanityDetector');
const { registerSlashCommands, interactionToIntent } = require('./slash');
const brain = require('./db/brain');
const { startHealthServer } = require('./health');

function logAiError(error) {
    if (error?.rateLimited) {
        console.error('[ZiGBoT AI RATE LIMIT] User exceeded their AI quota.');
        return;
    }
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
const rateLimitReply = 'Easy there — you have hit my AI quota for this minute. Try again shortly. ⏳';

const logReplyPacing = (message) => console.log(`[ZiGBoT REPLY] ${message}`);

const settings = loadSettings();
const ai = createAiClient({
    ...settings,
    rateLimiter: new RateLimiter({
        max: settings.aiRateLimitMax,
        windowMs: settings.aiRateLimitWindowSeconds * 1000
    })
});

// Core persistence: MongoDB Atlas (native driver). Warn features depend on
// it, so warnStore is only set after a successful connectBrain() below.
let warnStore = null;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.once(Events.ClientReady, async (c) => {
    console.log(`✅ ${c.user.tag} is online and ready! (Mention-driven mode with role-based personas active)`);
    // Slash commands are a secondary interface: a registration failure must
    // never take down the whole bot — keep running in mention-driven mode.
    try {
        await registerSlashCommands(client, settings);
    } catch (error) {
        console.error(`[ZiGBoT SLASH] Registration failed, continuing without slash commands: ${error.message}`);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
        await interaction.deferReply();

        const fakeMessage = {
            author: interaction.user,
            member: interaction.member,
            guild: interaction.guild,
            channel: interaction.channel,
            reply: (payload) => interaction.editReply(payload)
        };

        if (interaction.commandName === 'help') {
            const result = await executeTool(fakeMessage, settings, { action: 'bot_help' });
            await interaction.editReply(result);
            return;
        }

        const intent = await interactionToIntent(interaction);
        if (!intent) {
            await interaction.editReply('❌ Unsupported command.');
            return;
        }

        const toolResult = await runIntent(fakeMessage, settings, intent, { warnStore });
        if (toolResult) {
            await interaction.editReply(toolResult);
            return;
        }
        // Destructive intents hand the conversation to the Confirm/Cancel UI.
        await interaction.editReply('⚠️ Check the confirmation request above.');
    } catch (error) {
        logAiError(error);
        const reply = interaction.deferred || interaction.replied
            ? interaction.editReply(error.message)
            : interaction.reply(error.message);
        await reply.catch(() => {});
    }
});

// Pure dispatcher so tests can cover gating without touching Discord or the AI API.
async function runIntent(message, settings, intent, { onVoiceTranscript, warnStore: warns, viaVoice = false } = {}) {
    const action = intent?.action;

    if (!action || action === 'chat') return null; // caller falls back to persona reply

    if (action === 'bot_help') {
        return executeTool(message, settings, { action }, { warnStore: warns });
    }

    // Voice-originated intents are pre-restricted, but belt-and-braces: block
    // destructive actions from the voice path entirely, and anything still
    // destructive from text must go through the Confirm/Cancel flow instead of
    // executing directly.
    if (destructiveActions.has(action)) {
        if (viaVoice) {
            return '❌ For safety, confirm this action in a text channel where I can show a confirmation button.';
        }
        const summary = [intent.target, intent.role, intent.channel, intent.message]
            .filter(Boolean).join(' ') || 'server';
        await requestConfirmation(
            message,
            settings,
            { action, target: summary },
            () => executeTool(message, settings, { ...intent, action }, { warnStore: warns, onVoiceTranscript })
        );
        return null; // confirmation UI owns the conversation from here
    }

    return executeTool(message, settings, intent, { warnStore: warns, onVoiceTranscript });
}

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

    // The keyword detector is the ONLY reason we are replying — no mention,
    // no direct reply, not an always-on chat channel. This is the sole gate
    // for the occasional-skip / emoji-reaction behaviors further down.
    const keywordOnlyTrigger = trigger.matched && !isMentioned && !isReplyToBot && !inChatChannel && !settings.respondToAllMessages;

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
                userId: message.author.id,
                gender: getMemberGender(
                    targetMember,
                    settings.femaleRoleNames,
                    settings.maleRoleNames
                )
            });

            await deliverAiReply(message, replyText, { log: logReplyPacing });
            defaultMemory.addMessage(message.channel.id, 'user', userMessage, message.author.username);
            defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
        } catch (error) {
            logAiError(error);
            await message.reply(error.rateLimited ? rateLimitReply : aiFailureReply).catch(() => {});
        }
        return;
    }

    // Crisis language always overrides tool routing and personas.
    if (isCrisisMessage(userMessage)) {
        await message.reply(crisisResponse);
        return;
    }

    // Router path: classify the message into a tool intent. On any AI failure
    // the intent degrades to chat, so the persona reply below still answers.
    let intent = null;
    try {
        intent = await classifyIntent(
            ai.client,
            ai.model,
            userMessage,
            defaultMemory.getHistory(message.channel.id),
            { rateLimiter: ai.rateLimiter, userId: message.author.id }
        );
    } catch (error) {
        if (error.rateLimited) {
            await message.reply(rateLimitReply).catch(() => {});
            return;
        }
        logAiError(error);
        intent = { action: 'chat' };
    }

    try {
        const toolResult = await runIntent(message, settings, intent, {
            onVoiceTranscript: handleVoiceTranscript,
            isVoiceListening: isListening,
            warnStore
        });
        if (toolResult) {
            await message.reply(toolResult);
            return;
        }
        if (intent && intent.voiceNotice) {
            await message.reply(intent.voiceNotice);
            return;
        }
    } catch (error) {
        logAiError(error);
        await message.reply(aiFailureReply).catch(() => {});
        return;
    }

    // Savage comeback detection: profanity aimed at the bot itself. Crisis
    // language (checked above) ALWAYS overrides this; tool/admin intents
    // (handled above) never roast; gentle-tone users are excluded; owners are
    // excluded unless they hold Users.heer, mirroring the existing owner-mode
    // exception. Excluded categories (sexual/family-sexual/violent abuse)
    // fall through to a de-escalating decline instead of matching energy.
    const botTargeted = isMentioned || isReplyToBot;
    const profanityAtBot = botTargeted
        ? detectProfanityAtBot(userMessage)
        : { matched: false, category: null, term: null };
    const comebackMode = profanityAtBot.matched
        && profanityAtBot.category === 'profanity'
        && tone === 'savage'
        && !(isOwner && !isNonGentle);
    const declineMode = profanityAtBot.matched
        && profanityAtBot.category === 'excluded'
        && tone === 'savage';
    if (profanityAtBot.matched) {
        logReplyPacing(`profanity-at-bot (${profanityAtBot.category}: "${profanityAtBot.term}") in #${message.channel.id} -> ${comebackMode ? 'comeback' : declineMode ? 'decline' : 'standard'} reply`);
    }

    // Occasional hesitation on keyword-triggered chit-chat only. Never
    // applies to mentions, replies, chat channels, tool/admin intents, or
    // anything the router has already answered above. Stress triggers always
    // get a real supportive reply (shouldSkipReply/pickReactionEmoji only
    // fire on the 'fun' trigger type). A comeback/decline reply is always
    // delivered — never swallowed by the skip or reaction chances.
    if (keywordOnlyTrigger && !comebackMode && !declineMode) {
        if (shouldSkipReply({ isKeywordTriggered: true, triggerType: trigger.type })) {
            logReplyPacing(`intentionally skipping fun-keyword reply in #${message.channel.id} (skip chance hit)`);
            return;
        }
        const reactionEmoji = pickReactionEmoji({ isKeywordTriggered: true, triggerType: trigger.type });
        if (reactionEmoji) {
            logReplyPacing(`reacting with ${reactionEmoji} instead of replying in #${message.channel.id}`);
            try {
                await message.react(reactionEmoji);
                return;
            } catch (error) {
                // Missing reaction permissions must not end the reply: fall
                // through and send a normal text reply instead.
                logReplyPacing(`reaction failed (${error.message}), falling back to text reply`);
            }
        }
    }

    const authorName = message.member?.displayName || message.author.username;

    try {
        const history = defaultMemory.getHistory(message.channel.id);
        const replyText = await ai.reply({
            userMessage,
            authorName,
            contextMessages: history,
            tone,
            gender,
            isOwner,
            isNonGentle,
            comebackMode,
            declineMode,
            userId: message.author.id
        });

        await deliverAiReply(message, replyText, { log: logReplyPacing });

        // Record message in conversation memory (full unsplit text)
        defaultMemory.addMessage(message.channel.id, 'user', userMessage, authorName);
        defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
    } catch (error) {
        logAiError(error);
        await message.reply(error.rateLimited ? rateLimitReply : aiFailureReply).catch(() => {});
    }
});

// Voice transcripts enter the same router, with destructive actions blocked.
// Plain conversation gets a persona reply SPOKEN back into the voice channel
// (NVIDIA hosted TTS), sharing one conversation memory per guild voice chat.
async function handleVoiceTranscript({ guild, userId, transcript }) {
    const channel = guild.systemChannel || guild.channels.cache.find((c) => c.isTextBased());
    if (!channel) return;

    const routeContext = {
        author: { id: userId },
        guild,
        member: guild.members.cache.get(userId)
    };
    const intent = buildVoiceTranscriptRoute(routeContext, transcript, settings, client.user.id);

    if (intent.voiceNotice) {
        await channel.send(intent.voiceNotice).catch(() => {});
        return;
    }

    try {
        const toolResult = await runIntent({ author: { id: userId }, channel, guild, member: routeContext.member }, settings, intent, { viaVoice: true, warnStore });
        if (toolResult) {
            await channel.send(toolResult).catch(() => {});
            return;
        }
    } catch (error) {
        console.error(`[ZiGBoT VOICE ROUTE] ${error.message}`);
        return;
    }

    // Only plain conversation reaches here; confirmation flows own the text
    // channel and say nothing back through voice.
    if (intent.action !== 'chat') return;

    try {
        const member = guild.members.cache.get(userId);
        const authorName = member?.displayName || member?.user?.username || 'Someone';
        const isNonGentle = isNonGentleMember(member, settings.nonGentleRoleNames);
        const isGentle = !isNonGentle && isGentleMember(
            member,
            settings.gentleRoleNames,
            guild.id,
            settings.nonGentleRoleNames
        );
        const memoryKey = `voice:${guild.id}`;
        const history = defaultMemory.getHistory(memoryKey);
        const replyText = await ai.reply({
            userMessage: transcript,
            authorName,
            contextMessages: history,
            tone: isGentle ? 'gentle' : 'savage',
            gender: getMemberGender(member, settings.femaleRoleNames, settings.maleRoleNames),
            isNonGentle,
            userId
        });

        defaultMemory.addMessage(memoryKey, 'user', transcript, authorName);
        defaultMemory.addMessage(memoryKey, 'assistant', replyText);

        await speak(guild.id, settings, replyText);
    } catch (error) {
        console.error(`[ZiGBoT VOICE ROUTE] ${error.message}`);
    }
}

startHealthServer();

// Connect the brain before login: warn storage is core to moderation, and
// starting without it would be a silent broken state. Fail fast instead.
(async () => {
    try {
        await brain.connectBrain(process.env.MONGODB_URI);
        warnStore = brain;
        client.login(settings.discordToken);
    } catch (error) {
        console.error(`[ZiGBoT DB] MongoDB connection failed: ${error.message}`);
        console.error('[ZiGBoT DB] MONGODB_URI is required. Create a free cluster at cloud.mongodb.com (M0 tier), put the connection string in .env, and restart.');
        process.exit(1);
    }
})();
