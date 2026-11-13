/**
 * The optional features (docs/ZIGBOT_FEATURE_MATRIX.md sections C-M) behind
 * one small surface, so src/index.js only forwards its EXISTING events here.
 * Everything is off per server until enabled in feature_settings.
 */
const { SupabaseFeatureStore, MemoryFeatureStore } = require('./store');
const { createScheduler } = require('./scheduler');
const { createCommunity } = require('./community');

function createFeatures({ settings = {}, resolveContext, auditLog, getClient, store = null, now = () => Date.now(), logger = console, renderWelcomeImage }) {
    const supabase = new SupabaseFeatureStore({ supabaseUrl: settings.supabaseUrl, serviceRoleKey: settings.supabaseServiceRoleKey });
    const featureStore = store || (supabase.enabled ? supabase : new MemoryFeatureStore({ now }));
    const scheduler = createScheduler({ store: featureStore, now, logger });
    const image = renderWelcomeImage === undefined ? (input) => require('./welcomeImage').renderWelcomeImage(input) : renderWelcomeImage;
    const shared = { store: featureStore, scheduler, resolveContext, auditLog, getClient, now, logger };
    const modules = [createCommunity({ ...shared, renderWelcomeImage: image })];

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
        onReaction: (reaction, user, added) => each('onReaction', reaction, user, added),
        onVoiceState: (oldState, newState) => each('onVoiceState', oldState, newState),
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
