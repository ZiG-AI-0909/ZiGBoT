require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { loadSettings } = require('./config/settings');
const {
    createAiClient,
    classifyIntent,
    isCrisisMessage,
    crisisResponse,
    isMemoryQuestion,
    buildMemoryAnswer,
    shouldRemember,
    isReputationQuestion,
    buildReputationAnswer
} = require('./ai/client');
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
const { detectBehaviorSignals, defaultBehaviorTracker } = require('./ai/behaviorDetector');
const {
    extractPassiveMemory,
    extractTopicKeyword
} = require('./ai/client');
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

// Shared helper: record behavior signals for a member, best-effort. Failures
// are logged, never thrown — accountability must not break the reply path.
async function recordBehaviorSignals(guildId, userId, signals, source) {
    if (!guildId || !userId) return;
    for (const signal of signals) {
        try {
            await brain.recordBehavior(guildId, userId, signal, { source });
        } catch (error) {
            console.error(`[ZiGBoT BEHAVIOR] Record failed (${signal}): ${error.message}`);
        }
    }
}

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

    // Memory transparency: questions like "what do you remember?" are answered
    // from REAL MongoDB state (deterministic, no LLM) so the bot can never
    // fabricate memories or deny real ones. Imperative save requests
    // ("remember that...") fall through to the normal chat + save path.
    if (isMemoryQuestion(userMessage) && message.guild) {
        const capabilities = brain.getMemoryCapabilities();
        if (!capabilities.persistentMemory) {
            await message.reply(buildMemoryAnswer({ capabilities }));
            return;
        }
        try {
            const userMemories = await brain.recall(message.guild.id, message.author.id, 10);
            await message.reply(buildMemoryAnswer({ capabilities, memories: userMemories }));
        } catch {
            // Retrieval failed: report that honestly instead of guessing.
            await message.reply(buildMemoryAnswer({ capabilities, memories: null }));
        }
        return;
    }

    // Reputation transparency: same truth policy as memory — the answer comes
    // from the REAL behavior ledger, or honestly reports unavailability.
    if (isReputationQuestion(userMessage) && message.guild) {
        if (!brain.isBehaviorAvailable()) {
            await message.reply(buildReputationAnswer({ available: false }));
            return;
        }
        try {
            const summary = await brain.getBehaviorSummary(message.guild.id, message.author.id);
            await message.reply(buildReputationAnswer({ summary }));
        } catch {
            await message.reply(buildReputationAnswer({ available: true, summary: null }));
        }
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

    // ---- Passive server-wide memory capture (ALL chat, not just mentions) ----
    // The bot reads every message it already sees and quietly stores durable
    // life events ("my exam is happening") with a topic keyword, so future
    // replies to ANYONE can reference them ("btw how did the exam go?").
    // Best-effort: a capture failure must never block the reply path.
    if (message.guild && userMessage && !comebackMode && !declineMode) {
        try {
            const keyword = extractTopicKeyword(userMessage);
            const passive = extractPassiveMemory(userMessage);
            if (passive && brain.isMemoryAvailable()) {
                await brain.remember(message.guild.id, message.author.id, passive.content, passive.type, {
                    authorName,
                    keyword: passive.keyword || keyword
                });
            }
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Passive capture skipped: ${memoryError.message}`);
        }
    }

    try {
        const history = defaultMemory.getHistory(message.channel.id);

        // Persistent memory retrieval: real MongoDB records for THIS user in
        // THIS guild, injected into the AI context. A retrieval failure must
        // degrade the reply, not kill it — the AI is told recall failed.
        const capabilities = brain.getMemoryCapabilities();
        let userMemories = null;
        let retrievalFailed = false;
        if (capabilities.persistentMemory && message.guild) {
            try {
                userMemories = await brain.recall(message.guild.id, message.author.id, 5);
            } catch (memoryError) {
                console.error(`[ZiGBoT MEMORY] Recall failed: ${memoryError.message}`);
                retrievalFailed = true;
            }
        }

        // Behavior accountability: the AI's treatment adapts to the member's
        // RECORDED standing. Lookup failure must never block the reply.
        let reputation = null;
        if (brain.isBehaviorAvailable() && message.guild) {
            try {
                reputation = await brain.getBehaviorSummary(message.guild.id, message.author.id);
            } catch (behaviorError) {
                console.error(`[ZiGBoT BEHAVIOR] Summary lookup failed: ${behaviorError.message}`);
            }
        }

        // Server happenings: recent memories from ALL members (last 30 days)
        // so the AI can reference one member's situation while talking to
        // another. Excludes the current speaker (their own memories are
        // already in the personal block). Failure degrades silently.
        let recentMemories = null;
        let recentRetrievalFailed = false;
        if (brain.isMemoryAvailable() && message.guild) {
            try {
                recentMemories = await brain.recallRecent(message.guild.id, {
                    limit: 15,
                    excludeUserId: message.author.id
                });
            } catch (recentError) {
                console.error(`[ZiGBoT MEMORY] Recent-context lookup failed: ${recentError.message}`);
                recentRetrievalFailed = true;
            }
        }

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
            userId: message.author.id,
            capabilities,
            memories: userMemories,
            retrievalFailed,
            reputation,
            recentMemories,
            recentRetrievalFailed
        });

        await deliverAiReply(message, replyText, { log: logReplyPacing });

        // Record message in conversation memory (full unsplit text)
        defaultMemory.addMessage(message.channel.id, 'user', userMessage, authorName);
        defaultMemory.addMessage(message.channel.id, 'assistant', replyText);

        // ---- Behavior recording (best-effort, never blocks the reply) ----
        if (message.guild) {
            const { negative, positive } = detectBehaviorSignals(userMessage);
            // Structural spam check: repeated identical content >= 3 in 10s.
            // Profanity aimed AT the bot in roast territory is the bot's job,
            // not an accountability event — excluded via comebackMode above.
            if (!comebackMode && !declineMode && defaultBehaviorTracker.checkSpam(message.guild.id, message.author.id, userMessage)) {
                negative.push('spam');
            }
            await recordBehaviorSignals(message.guild.id, message.author.id, negative, 'message-scan');
            await recordBehaviorSignals(message.guild.id, message.author.id, positive, 'message-scan');
        }

        // Selective long-term save: only durable facts/preferences, never
        // credentials (brain.remember refuses them). A failed save is logged
        // but never announced — the bot does not claim "I stored that".
        try {
            const candidate = shouldRemember(userMessage);
            if (candidate.should && brain.isMemoryAvailable() && message.guild) {
                await brain.remember(message.guild.id, message.author.id, candidate.content, candidate.type, {
                    authorName,
                    keyword: extractTopicKeyword(candidate.content)
                });
            }
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Save skipped: ${memoryError.message}`);
        }
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

        // Same grounded memory context as the text path, plus reputation.
        const capabilities = brain.getMemoryCapabilities();
        let userMemories = null;
        let retrievalFailed = false;
        if (capabilities.persistentMemory) {
            try {
                userMemories = await brain.recall(guild.id, userId, 5);
            } catch {
                retrievalFailed = true;
            }
        }
        let reputation = null;
        if (brain.isBehaviorAvailable()) {
            try {
                reputation = await brain.getBehaviorSummary(guild.id, userId);
            } catch {
                reputation = null;
            }
        }

        const replyText = await ai.reply({
            userMessage: transcript,
            authorName,
            contextMessages: history,
            tone: isGentle ? 'gentle' : 'savage',
            gender: getMemberGender(member, settings.femaleRoleNames, settings.maleRoleNames),
            isNonGentle,
            userId,
            capabilities,
            memories: userMemories,
            retrievalFailed,
            reputation
        });

        defaultMemory.addMessage(memoryKey, 'user', transcript, authorName);
        defaultMemory.addMessage(memoryKey, 'assistant', replyText);

        // Voice transcripts feed the same accountability ledger as text.
        const voiceSignals = detectBehaviorSignals(transcript);
        await recordBehaviorSignals(guild.id, userId, voiceSignals.negative, 'voice-scan');
        await recordBehaviorSignals(guild.id, userId, voiceSignals.positive, 'voice-scan');

        // Selective long-term save from voice, same rules as text.
        try {
            const candidate = shouldRemember(transcript);
            if (candidate.should && brain.isMemoryAvailable()) {
                await brain.remember(guild.id, userId, candidate.content, candidate.type, {
                    authorName,
                    keyword: extractTopicKeyword(candidate.content)
                });
            }
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Save skipped: ${memoryError.message}`);
        }

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
