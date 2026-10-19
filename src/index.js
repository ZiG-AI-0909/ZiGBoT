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
    buildOwnerMemoryAnswer,
    shouldRemember,
    isReputationQuestion,
    buildReputationAnswer
} = require('./ai/client');
const { defaultMemory } = require('./ai/memory');
const { RateLimiter } = require('./ai/rateLimiter');
const { detectTrigger, defaultTracker } = require('./ai/triggerDetector');
const { isGentleMember, getMemberGender, isNonGentleMember } = require('./ai/roleDetector');
const { isServerOwner } = require('./security/authorization');
const { getOwnerRoastTarget, getOwnerMemoryTarget } = require('./security/ownerCommands');
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
const { registerSlashCommands, interactionToIntent, runYouTubeInteraction } = require('./slash');
const { handleSetupCommand, sendWelcome } = require('./guildConfig/setup');
const { isMusicComponent, handleMusicComponent } = require('./music/panel');
const { isVoiceComponent, handleVoiceComponent } = require('./voice/panel');
const music = require('./music/player');
const { startMusicStatus } = require('./music/status');

// An idle music session never cuts off a voice chat that is still listening.
music.setIdleLeaveGuard((guildId) => !isListening(guildId));
const { initYouTube } = require('./youtube');
const brain = require('./db/brain');
const { startHealthServer } = require('./health');
const { GuildConfigStore } = require('./guildConfig/store');
const {
    behaviorForMember,
    channelAllowed,
    isChatChannel,
    buildGuildSettings,
    pronounsToGender,
    hasFeature,
    rateLimitReplyFor
} = require('./guildConfig/context');
const { version: BOT_VERSION } = require('../package.json');

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

const logReplyPacing = (message) => console.log(`[ZiGBoT REPLY] ${message}`);

const settings = loadSettings();
const ai = createAiClient({
    ...settings,
    rateLimiter: new RateLimiter({
        max: settings.aiRateLimitMax,
        windowMs: settings.aiRateLimitWindowSeconds * 1000
    })
});

// Per-server configuration (Supabase). Without SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY the store runs in legacy mode: every server
// behaves exactly like the original env-configured single-server bot.
const guildStore = new GuildConfigStore({
    settings,
    supabaseUrl: settings.supabaseUrl,
    serviceRoleKey: settings.supabaseServiceRoleKey
});
console.log(`[ZiGBoT CONFIG] Per-server config mode: ${guildStore.mode}${guildStore.mode === 'legacy' ? ' (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable the dashboard)' : ''}`);

// Resolve everything the handlers need for one guild event. Never throws.
async function guildRuntime(guild, member) {
    if (!guild) return { ctx: null, gSettings: settings, behavior: null };
    const ctx = await guildStore.getGuildContext(guild);
    return { ctx, gSettings: buildGuildSettings(settings, ctx), behavior: behaviorForMember(ctx, member) };
}

// Legacy env role rules (the original gentle/savage/pronoun behaviour) apply
// when there is no dashboard config, or when a server opted into them.
function usesLegacyRoleRules(ctx) {
    return !ctx || ctx.mode === 'legacy' || Boolean(ctx.config?.legacy_role_rules);
}

// Tone + pronoun resolution for one member. Role mappings set by the
// dashboard win over legacy env rules; the verified owner is always gentle.
function resolveToneAndGender(ctx, behavior, member, { isOwner = false, ownerRoast = false } = {}) {
    const legacy = usesLegacyRoleRules(ctx);
    const isNonGentle = legacy && isNonGentleMember(member, settings.nonGentleRoleNames);
    const legacyGentle = legacy && !isOwner && !isNonGentle && isGentleMember(member, settings.gentleRoleNames, member?.guild?.id, settings.nonGentleRoleNames);
    const mappedTone = behavior?.primary && (behavior.matchedRoleIds || []).length > 0 && behavior.tone;
    let tone;
    // Under-18 members (/setup) are always gentle — checked before anything else.
    if (behavior?.isMinor || isOwner) tone = 'gentle';
    // Dashboard "Roast the owner too": the owner asked for it, so no feature gate.
    else if (ownerRoast) tone = 'savage';
    else if (legacy && !mappedTone) tone = legacyGentle ? 'gentle' : 'savage';
    else tone = behavior?.tone || 'gentle';
    if (tone === 'savage' && !ownerRoast && behavior && !hasFeature(behavior, 'roast')) tone = 'gentle';
    const gender = behavior?.pronouns
        ? pronounsToGender(behavior.pronouns)
        : legacy
            ? getMemberGender(member, settings.femaleRoleNames, settings.maleRoleNames, settings.femaleRoleIds, settings.maleRoleIds)
            : null;
    return { tone, gender, isNonGentle };
}

function guildPromptFor(ctx, behavior) {
    if (!ctx || ctx.mode !== 'multi') return null; // legacy prompt, unchanged
    return { config: ctx.config, behavior, isHomeGuild: ctx.isHomeGuild };
}

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
    console.log(`✅ ${c.user.tag} is online and ready in ${c.guilds.cache.size} server(s)! (Mention-driven mode with role-based personas active)`);
    // Make sure every server the bot is in has a config row (safe defaults
    // for new servers). Failures are logged; the bot keeps running.
    if (guildStore.enabled) {
        for (const guild of c.guilds.cache.values()) {
            await guildStore.ensureGuild(guild).catch((error) => console.error(`[ZiGBoT CONFIG] Seed failed for ${guild.id}: ${error.message}`));
        }
        const beat = () => guildStore.heartbeat({ guildCount: c.guilds.cache.size, version: BOT_VERSION })
            .catch((error) => console.error(`[ZiGBoT CONFIG] Heartbeat failed: ${error.message}`));
        await beat();
        setInterval(beat, 60_000).unref();
        startMusicStatus(guildStore);
    }
    // Slash commands are a secondary interface: a registration failure must
    // never take down the whole bot — keep running in mention-driven mode.
    try {
        await registerSlashCommands(client, settings);
    } catch (error) {
        console.error(`[ZiGBoT SLASH] Registration failed, continuing without slash commands: ${error.message}`);
    }

    // YouTube live chat: completely optional. Any init failure still leaves
    // the Discord bot running normally.
    try {
        const ytState = await initYouTube(null, { discordClient: client, settings, ai });
        if (ytState.enabled) {
            console.log('[ZiGBoT YT] YouTube live-chat support enabled.');
            if (!ytState.selfId) console.log('[ZiGBoT YT] NOTE: bot channel not resolved via channels.list(mine=true); rely on authorDetails.isChatOwner/isChatModerator for self-filtering.');
        } else if (ytState.quotaWaiting) {
            console.log(`[ZiGBoT YT] YouTube paused: daily quota spent. Retry scheduled${ytState.quotaRetryAt ? ` for ${ytState.quotaRetryAt.toISOString()}` : ''}; the Discord bot continues normally.`);
        } else {
            console.log(`[ZiGBoT YT] YouTube disabled (${(ytState.missingVars || []).join(', ') || 'init failure'}); continuing without it.`);
        }
    } catch (error) {
        console.error(`[ZiGBoT YT] Startup failed, YouTube disabled: ${error.message}`);
    }
});

// New server: register it with safe default settings.
client.on(Events.GuildCreate, async (guild) => {
    console.log(`[ZiGBoT CONFIG] Added to server ${guild.id} (${guild.name}).`);
    await guildStore.ensureGuild(guild).catch((error) => console.error(`[ZiGBoT CONFIG] Seed failed for ${guild.id}: ${error.message}`));
    // Ask the admins for what the bot cannot work out by itself (/setup).
    await sendWelcome(guild).catch((error) => console.error(`[ZiGBoT SETUP] Welcome message failed for ${guild.id}: ${error.message}`));
});

// Music: pause and leave later when everyone leaves the bot's voice channel;
// resume when someone comes back.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guild = newState.guild || oldState.guild;
    const botChannel = guild?.members?.me?.voice?.channel;
    if (!botChannel) return;
    if (![oldState.channelId, newState.channelId].includes(botChannel.id)) return;
    const listeners = [...botChannel.members.values()].filter((m) => !m.user.bot).length;
    if (listeners === 0) music.onChannelEmpty(guild.id);
    else music.onChannelOccupied(guild.id);
});

client.on(Events.GuildDelete, async (guild) => {
    console.log(`[ZiGBoT CONFIG] Removed from server ${guild.id}.`);
    await guildStore.markRemoved(guild.id).catch((error) => console.error(`[ZiGBoT CONFIG] Uninstall mark failed for ${guild.id}: ${error.message}`));
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (isVoiceComponent(interaction)) {
        await handleVoiceComponent(interaction, async (intent) => {
            const fakeMessage = { author: interaction.user, member: interaction.member, guild: interaction.guild, channel: interaction.channel, reply: () => null };
            const { ctx, gSettings } = await guildRuntime(interaction.guild, interaction.member);
            if (ctx && ctx.config.enabled === false) return '❌ ZiGBoT is switched off in this server by its admins.';
            return runIntent(fakeMessage, gSettings, intent, { warnStore, onVoiceTranscript: handleVoiceTranscript, isVoiceListening: isListening });
        }).catch((error) => console.error(`[ZiGBoT VOICE] button failed: ${error.message}`));
        return;
    }
    if (isMusicComponent(interaction)) {
        await handleMusicComponent(interaction, async (intent) => {
            const fakeMessage = {
                author: interaction.user,
                member: interaction.member,
                guild: interaction.guild,
                channel: interaction.channel,
                reply: () => null
            };
            const { ctx, gSettings } = await guildRuntime(interaction.guild, interaction.member);
            if (ctx && ctx.config.enabled === false) return '❌ ZiGBoT is switched off in this server by its admins.';
            return runIntent(fakeMessage, gSettings, intent, { warnStore });
        }).catch((error) => console.error(`[ZiGBoT MUSIC] button failed: ${error.message}`));
        return;
    }
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
        const { ctx: interactionCtx, gSettings: interactionSettings } = await guildRuntime(interaction.guild, interaction.member);
        if (interactionCtx && interactionCtx.config.enabled === false) {
            await interaction.editReply('ZiGBoT is switched off in this server by its admins.');
            return;
        }

        if (interaction.commandName === 'setup') {
            await interaction.editReply({ content: await handleSetupCommand(interaction, guildStore), allowedMentions: { parse: [] } });
            return;
        }

        if (interaction.commandName === 'help') {
            const result = await executeTool(fakeMessage, interactionSettings, { action: 'bot_help' });
            await interaction.editReply(result);
            return;
        }

        // YouTube live chat commands, before the general intent router.
        // A YouTube failure is handled inside runYouTubeInteraction (returns a
        // friendly error line) and never bubbles up as a Discord crash.
        const ytReply = await runYouTubeInteraction(interaction, settings, client);
        if (ytReply !== null) {
            await interaction.editReply(ytReply);
            return;
        }

        const intent = await interactionToIntent(interaction);
        if (!intent) {
            await interaction.editReply('❌ Unsupported command.');
            return;
        }

        const toolResult = await runIntent(fakeMessage, interactionSettings, intent, { warnStore, onVoiceTranscript: handleVoiceTranscript, isVoiceListening: isListening });
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

// ZiGBoT talks: a typed chat reply is also spoken out loud when it is in the
// voice channel the conversation is about (that channel's own text chat, or
// the writer is sitting in it). Never over music — that would cut the song.
function speakReplyInVoice(message, gSettings, replyText, behavior) {
    const botChannel = message.guild?.members?.me?.voice?.channel;
    if (!botChannel || !replyText) return;
    const inThisVoice = message.channel?.id === botChannel.id || message.member?.voice?.channelId === botChannel.id;
    if (!inThisVoice || music.isActive(message.guild.id)) return;
    if (gSettings.guildContext?.config?.voice_speak_replies === false) return;
    if (behavior && !hasFeature(behavior, 'voice')) return;
    speak(message.guild.id, gSettings, replyText)
        .catch((error) => console.error(`[ZiGBoT VOICE] Could not speak the reply: ${error.message}`));
}

// Pure dispatcher so tests can cover gating without touching Discord or the AI API.
async function runIntent(message, settings, intent, { onVoiceTranscript, isVoiceListening, warnStore: warns, viaVoice = false } = {}) {
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
            () => executeTool(message, settings, { ...intent, action }, { warnStore: warns, onVoiceTranscript, isVoiceListening })
        );
        return null; // confirmation UI owns the conversation from here
    }

    return executeTool(message, settings, intent, { warnStore: warns, onVoiceTranscript, isVoiceListening });
}

client.on(Events.MessageCreate, async (message) => {
    // Ignore all bots
    if (message.author.bot || !client.user) return;

    // Per-server context: config is loaded for THIS message's guild only.
    const { ctx: guildCtx, gSettings, behavior } = await guildRuntime(message.guild, message.member);
    if (guildCtx && guildCtx.config.enabled === false) return;
    if (guildCtx && !channelAllowed(guildCtx.config, message.channel)) return;
    const memoryAllowed = !guildCtx || (guildCtx.config.memory_enabled !== false && hasFeature(behavior, 'memory'));
    const reputationAllowed = !guildCtx || guildCtx.config.reputation_enabled !== false;

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

    const inChatChannel = guildCtx
        ? isChatChannel(guildCtx.config, message.channel)
        : settings.chatChannelIds.includes(message.channel.id);
    const trigger = gSettings.autoReplyKeywords
        ? detectTrigger(message.content)
        : { matched: false };

    const userMessage = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();
    // Capture durable facts/events from every message the gateway delivers in
    // a server, whether or not ZiGBoT is configured to reply in that channel.
    // This is selective memory, not a transcript: ordinary chat and crisis
    // content are skipped, and brain.remember refuses credentials.
    if (message.guild && memoryAllowed && userMessage && !isCrisisMessage(userMessage)) {
        try {
            const passive = extractPassiveMemory(userMessage);
            const selective = shouldRemember(userMessage);
            const candidate = passive || (selective.should ? selective : null);
            if (candidate && brain.isMemoryAvailable()) {
                const authorName = message.member?.displayName || message.author.username;
                await brain.remember(message.guild.id, message.author.id, candidate.content, candidate.type, {
                    authorName,
                    keyword: candidate.keyword || extractTopicKeyword(candidate.content)
                });
            }
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Automatic capture skipped: ${memoryError.message}`);
        }
    }

    const ownerMemoryTarget = getOwnerMemoryTarget(message, client.user.id, settings);
    // Reply to explicit interactions, configured chat channels, or enabled keywords.
    const shouldReply = isMentioned || isReplyToBot || inChatChannel || gSettings.respondToAllMessages || trigger.matched || ownerMemoryTarget;
    if (!shouldReply) return;
    // A role mapping can switch the AI off for some members (deny "chat").
    if (!ownerMemoryTarget && !hasFeature(behavior, 'chat')) return;

    // The keyword detector is the ONLY reason we are replying — no mention,
    // no direct reply, not an always-on chat channel. This is the sole gate
    // for the occasional-skip / emoji-reaction behaviors further down.
    const keywordOnlyTrigger = trigger.matched && !isMentioned && !isReplyToBot && !inChatChannel && !gSettings.respondToAllMessages;

    if (trigger.matched) {
        if (!defaultTracker.canTrigger(message.channel.id, message.author.id, gSettings.cooldownSeconds)) return;
        defaultTracker.recordTrigger(message.channel.id, message.author.id);
    }

    // The verified owner always gets the respectful mode, unless they switched
    // on "Roast the owner too" in the dashboard: then they are roasted like anyone.
    const isVerifiedOwner = isServerOwner(message, settings);
    const ownerRoast = isVerifiedOwner && Boolean(guildCtx?.config?.owner_roast);
    const isOwner = isVerifiedOwner && !ownerRoast;
    const { tone, gender, isNonGentle } = resolveToneAndGender(guildCtx, behavior, message.member, { isOwner, ownerRoast });
    const isGentle = !isOwner && tone !== 'savage';
    const guildPrompt = guildPromptFor(guildCtx, behavior);

    // If a user just mentions @ZiGBoT without any text
    if (!userMessage) {
        if (isMentioned || isReplyToBot) {
            const greeting = isOwner
                ? 'At your service. ZiGBoT online. How can I help?'
                : isGentle
                    ? "Hey! ✨ Kya chal raha hai? Kuch share karna hai ya koi help chahiye? 🌸"
                : "Haan, tag kiya hai toh bol bhi de. Kya dukh dard baantna hai?";
            await message.reply(greeting);
        }
        return;
    }

    if (ownerMemoryTarget) {
        if (!brain.isMemoryAvailable()) {
            await message.reply('Persistent memory is temporarily unavailable, so I cannot check what is stored.').catch(() => {});
            return;
        }
        try {
            const totalCount = await brain.countMemories(message.guild.id, ownerMemoryTarget.id);
            const memories = await brain.recall(message.guild.id, ownerMemoryTarget.id, 20);
            const member = message.guild.members.cache.get(ownerMemoryTarget.id);
            const targetName = member?.displayName || ownerMemoryTarget.globalName || ownerMemoryTarget.username;
            const summary = buildOwnerMemoryAnswer({ targetName, memories, totalCount });
            await message.author.send({
                content: summary,
                allowedMentions: { parse: [] }
            });
            await message.reply(`I sent the 30-day memory summary for ${ownerMemoryTarget} to your DMs.`);
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Owner lookup failed: ${memoryError.message}`);
            await message.reply('I could not retrieve or privately deliver that memory summary. No details were posted here.').catch(() => {});
        }
        return;
    }

    const ownerRoastTarget = getOwnerRoastTarget(message, client.user.id, settings);
    if (ownerRoastTarget) {
        const targetMember = message.guild.members.cache.get(ownerRoastTarget.id);
        const targetName = targetMember?.displayName || ownerRoastTarget.globalName || ownerRoastTarget.username;
        if (behaviorForMember(guildCtx, targetMember)?.isMinor) {
            await message.reply({ content: `I don't roast members under 18 — ${targetName} gets the wholesome treatment only. 🌸`, allowedMentions: { repliedUser: false } });
            return;
        }

        try {
            await message.channel.sendTyping();
            const history = defaultMemory.getHistory(message.channel.id);
            const replyText = await ai.reply({
                userMessage: `Roast the mentioned target named ${targetName}. Keep the roast directed only at that target, not the server owner or ZiGBoT.`,
                authorName: targetName,
                contextMessages: history,
                tone: 'savage',
                userId: message.author.id,
                rateLimitMax: gSettings.aiRateLimitMax,
                gender: getMemberGender(
                    targetMember,
                    settings.femaleRoleNames,
                    settings.maleRoleNames,
                    settings.femaleRoleIds,
                    settings.maleRoleIds
                )
            });

            await deliverAiReply(message, replyText, { log: logReplyPacing });
            defaultMemory.addMessage(message.channel.id, 'user', userMessage, message.author.username);
            defaultMemory.addMessage(message.channel.id, 'assistant', replyText);
        } catch (error) {
            logAiError(error);
            await message.reply(error.rateLimited ? rateLimitReplyFor(gSettings) : aiFailureReply).catch(() => {});
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
        if (!memoryAllowed) {
            await message.reply('Long-term memory is turned off for you in this server, so I am not storing or recalling anything about you here.');
            return;
        }
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
    if (isReputationQuestion(userMessage) && message.guild && reputationAllowed) {
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
            { rateLimiter: ai.rateLimiter, userId: message.author.id, rateLimitMax: gSettings.aiRateLimitMax }
        );
    } catch (error) {
        if (error.rateLimited) {
            await message.reply(rateLimitReplyFor(gSettings)).catch(() => {});
            return;
        }
        logAiError(error);
        intent = { action: 'chat' };
    }

    try {
        const toolResult = await runIntent(message, gSettings, intent, {
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
    // (handled above) never roast; gentle-tone users and owners are excluded.
    // Excluded categories (sexual/family-sexual/violent abuse)
    // fall through to a de-escalating decline instead of matching energy.
    const botTargeted = isMentioned || isReplyToBot;
    const profanityAtBot = botTargeted
        ? detectProfanityAtBot(userMessage)
        : { matched: false, category: null, term: null };
    const comebackMode = profanityAtBot.matched
        && profanityAtBot.category === 'profanity'
        && tone === 'savage'
        && hasFeature(behavior, 'roast')
        && !isOwner;
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

        // Persistent memory retrieval: real MongoDB records for THIS user in
        // THIS guild, injected into the AI context. A retrieval failure must
        // degrade the reply, not kill it — the AI is told recall failed.
        const capabilities = brain.getMemoryCapabilities();
        let userMemories = null;
        let retrievalFailed = false;
        if (capabilities.persistentMemory && message.guild && memoryAllowed) {
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
        if (brain.isBehaviorAvailable() && message.guild && reputationAllowed) {
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
        if (brain.isMemoryAvailable() && message.guild && (!guildCtx || guildCtx.config.memory_enabled !== false)) {
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
            recentRetrievalFailed,
            guildPrompt,
            rateLimitMax: gSettings.aiRateLimitMax
        });

        await deliverAiReply(message, replyText, { log: logReplyPacing });
        speakReplyInVoice(message, gSettings, replyText, behavior);

        // Record message in conversation memory (full unsplit text)
        defaultMemory.addMessage(message.channel.id, 'user', userMessage, authorName);
        defaultMemory.addMessage(message.channel.id, 'assistant', replyText);

        // ---- Behavior recording (best-effort, never blocks the reply) ----
        if (message.guild && reputationAllowed) {
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

    } catch (error) {
        logAiError(error);
        await message.reply(error.rateLimited ? rateLimitReplyFor(gSettings) : aiFailureReply).catch(() => {});
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
    const { ctx: voiceCtx, gSettings: voiceSettings, behavior: voiceBehavior } = await guildRuntime(guild, routeContext.member);
    if (voiceCtx && voiceCtx.config.enabled === false) return;
    if (voiceBehavior && !hasFeature(voiceBehavior, 'chat')) return;
    const voiceMemoryAllowed = !voiceCtx || (voiceCtx.config.memory_enabled !== false && hasFeature(voiceBehavior, 'memory'));
    const voiceReputationAllowed = !voiceCtx || voiceCtx.config.reputation_enabled !== false;
    const intent = buildVoiceTranscriptRoute(routeContext, transcript, voiceSettings, client.user.id);

    if (intent.voiceNotice) {
        await channel.send(intent.voiceNotice).catch(() => {});
        return;
    }

    try {
        const toolResult = await runIntent({ author: { id: userId }, channel, guild, member: routeContext.member }, voiceSettings, intent, { viaVoice: true, warnStore });
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
        const { tone: voiceTone, gender: voiceGender, isNonGentle } = resolveToneAndGender(voiceCtx, voiceBehavior, member);
        const memoryKey = `voice:${guild.id}`;
        const history = defaultMemory.getHistory(memoryKey);

        // Same grounded memory context as the text path, plus reputation.
        const capabilities = brain.getMemoryCapabilities();
        let userMemories = null;
        let retrievalFailed = false;
        if (capabilities.persistentMemory && voiceMemoryAllowed) {
            try {
                userMemories = await brain.recall(guild.id, userId, 5);
            } catch {
                retrievalFailed = true;
            }
        }
        let reputation = null;
        if (brain.isBehaviorAvailable() && voiceReputationAllowed) {
            try {
                reputation = await brain.getBehaviorSummary(guild.id, userId);
            } catch {
                reputation = null;
            }
        }

        const aiStartedAt = Date.now();
        const replyText = await ai.reply({
            fast: true,
            userMessage: transcript,
            authorName,
            contextMessages: history,
            tone: voiceTone,
            gender: voiceGender,
            isNonGentle,
            userId,
            capabilities,
            memories: userMemories,
            retrievalFailed,
            reputation,
            guildPrompt: guildPromptFor(voiceCtx, voiceBehavior),
            rateLimitMax: voiceSettings.aiRateLimitMax
        });

        console.log(`[ZiGBoT VC] AI reply ready in ${Date.now() - aiStartedAt} ms`);

        defaultMemory.addMessage(memoryKey, 'user', transcript, authorName);
        defaultMemory.addMessage(memoryKey, 'assistant', replyText);

        // Speak first: the database bookkeeping below must never delay the voice.
        const speaking = speak(guild.id, voiceSettings, replyText)
            .catch((error) => console.error(`[ZiGBoT VOICE] Could not speak the reply: ${error.message}`));

        // Voice transcripts feed the same accountability ledger as text.
        if (voiceReputationAllowed) {
            const voiceSignals = detectBehaviorSignals(transcript);
            await recordBehaviorSignals(guild.id, userId, voiceSignals.negative, 'voice-scan');
            await recordBehaviorSignals(guild.id, userId, voiceSignals.positive, 'voice-scan');
        }

        // Selective long-term save from voice, same rules as text.
        try {
            const candidate = shouldRemember(transcript);
            if (candidate.should && voiceMemoryAllowed && brain.isMemoryAvailable()) {
                await brain.remember(guild.id, userId, candidate.content, candidate.type, {
                    authorName,
                    keyword: extractTopicKeyword(candidate.content)
                });
            }
        } catch (memoryError) {
            console.error(`[ZiGBoT MEMORY] Save skipped: ${memoryError.message}`);
        }

        await speaking;
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
