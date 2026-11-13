/**
 * The optional features (docs/ZIGBOT_FEATURE_MATRIX.md sections C-M) behind
 * one small surface, so src/index.js only forwards its EXISTING events here.
 * Everything is off per server until enabled in feature_settings.
 */
const { SupabaseFeatureStore, MemoryFeatureStore } = require('./store');
const { createScheduler } = require('./scheduler');
const { createCommunity } = require('./community');
const { createAutomation } = require('./automation');
const { createEngagement } = require('./engagement');
const { createAiTools } = require('./aiTools');
const { createSecurityPlus } = require('./securityPlus');
const { createTempVoice } = require('./tempVoice');
const { createSocial, createTwitchApi } = require('./social');

function createFeatures({ settings = {}, resolveContext, auditLog, getClient, store = null, now = () => Date.now(), logger = console, renderWelcomeImage, renderRankCard, aiClient = null, aiModel = '', listWarnings = null }) {
    const supabase = new SupabaseFeatureStore({ supabaseUrl: settings.supabaseUrl, serviceRoleKey: settings.supabaseServiceRoleKey });
    const featureStore = store || (supabase.enabled ? supabase : new MemoryFeatureStore({ now }));
    const scheduler = createScheduler({ store: featureStore, now, logger });
    const image = renderWelcomeImage === undefined ? (input) => require('./welcomeImage').renderWelcomeImage(input) : renderWelcomeImage;
    const shared = { store: featureStore, scheduler, resolveContext, auditLog, getClient, now, logger };
    const rankCard = renderRankCard === undefined ? (input) => require('./rankCard').renderRankCard(input) : renderRankCard;
    const modules = [
        // First: a message with a confirmed scam link is removed before anything else sees it.
        createSecurityPlus({ ...shared, aiClient, aiModel }),
        createCommunity({ ...shared, renderWelcomeImage: image }),
        createAutomation(shared),
        createTempVoice(shared),
        createSocial({ ...shared, twitch: createTwitchApi({ clientId: process.env.TWITCH_CLIENT_ID || '', clientSecret: process.env.TWITCH_CLIENT_SECRET || '' }) }),
        createEngagement({ ...shared, renderRankCard: rankCard })
    ];
    const aiTools = createAiTools({ ...shared, aiClient, aiModel, listWarnings });
    modules.push(aiTools);

    const each = (hook, ...args) => Promise.all(modules.filter((m) => typeof m[hook] === 'function').map((m) => Promise.resolve(m[hook](...args))
        .catch((error) => logger.error?.(`[ZiGBoT FEATURES] ${hook} failed: ${error?.message || error}`))));

    return {
        store: featureStore,
        scheduler,
        modules,
        start: () => scheduler.start(),
        stop: () => scheduler.stop(),
        onMemberAdd: (member) => each('onMemberAdd', member),
        onMemberRemove: (member) => each('onMemberRemove', member),
        onMemberUpdate: (oldMember, newMember) => each('onMemberUpdate', oldMember, newMember),
        onReaction: (reaction, user, added) => each('onReaction', reaction, user, added),
        onVoiceState: (oldState, newState) => each('onVoiceState', oldState, newState),
        /** Per-channel / per-server AI limits (Section D). true = the AI may reply. */
        allowAiReply: (message) => aiTools.allowAiReply(message),
        /** true when a module fully handled the message (the caller then stops). */
        async onMessage(message, context) {
            for (const m of modules) {
                if (typeof m.onMessage !== 'function') continue;
                try {
                    if (await m.onMessage(message, context)) return true;
                } catch (error) {
                    logger.error?.(`[ZiGBoT FEATURES] onMessage failed: ${error?.message || error}`);
                }
            }
            return false;
        },
        handlesSlash: (interaction) => modules.some((m) => m.handlesSlash?.(interaction)),
        handleSlash: (interaction) => modules.find((m) => m.handlesSlash?.(interaction)).handleSlash(interaction),
        isComponent: (interaction) => modules.some((m) => m.isComponent?.(interaction)),
        handleComponent: (interaction) => modules.find((m) => m.isComponent?.(interaction)).handleComponent(interaction)
    };
}

module.exports = { createFeatures };
