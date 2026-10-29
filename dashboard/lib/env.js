import 'server-only';
import identityRules from './shared/identity';

/**
 * Server-side environment. Secrets are read here and ONLY here; this module
 * imports 'server-only' so the build fails if a client component ever
 * imports it. Only NEXT_PUBLIC_* values may reach the browser, and the only
 * public Supabase value is the anon key (which RLS constrains).
 */
function required(name) {
    const value = process.env[name];
    if (!value) {
        const error = new Error(`Server misconfigured: missing environment variable ${name}.`);
        error.status = 500;
        error.publicMessage = 'The dashboard is not fully configured yet. Check the server environment variables.';
        throw error;
    }
    return value;
}

export const env = {
    get supabaseUrl() { return required('NEXT_PUBLIC_SUPABASE_URL'); },
    get supabaseAnonKey() { return required('NEXT_PUBLIC_SUPABASE_ANON_KEY'); },
    get supabaseServiceRoleKey() { return required('SUPABASE_SERVICE_ROLE_KEY'); },
    get discordBotToken() { return required('DISCORD_BOT_TOKEN'); },
    get discordClientId() { return required('DISCORD_CLIENT_ID'); },
    get nvidiaApiKey() { return process.env.NVIDIA_API_KEY || ''; },
    get aiModel() { return process.env.AI_MODEL || 'openai/gpt-oss-20b'; },
    get siteUrl() { return (process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, ''); },
    get homeGuildIds() { return (process.env.HOME_GUILD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean); },
    get botCreatorId() { return process.env.BOT_CREATOR_ID || ''; },
    // Super Admin (/admin): Discord user IDs allowed in, comma-separated.
    // Falls back to BOT_CREATOR_ID. Empty or invalid = nobody (fails closed).
    get superAdminDiscordIds() {
        const raw = process.env.SUPER_ADMIN_DISCORD_IDS || process.env.BOT_CREATOR_ID || '';
        return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => /^\d{17,20}$/.test(s)))];
    },
    // Custom bot identity (Premium). Off unless exactly 'true'; the bot reads the same variable.
    get customIdentityEnabled() { return process.env.CUSTOM_IDENTITY_ENABLED === 'true'; },
    // Optional server allowlist (comma-separated ids); empty = every server.
    get customIdentityGuilds() { return identityRules.parseIdentityGuilds(process.env.CUSTOM_IDENTITY_GUILDS); },
    // Uploaded identity pictures go live straight away unless this is exactly
    // 'true': then each one waits for the bot owner's review (/owner/identity).
    get identityAvatarReview() { return process.env.IDENTITY_AVATAR_REVIEW === 'true'; },

    // ZiGBoT Premium via Razorpay Subscriptions (optional; all of these enable billing).
    // Test-mode keys (rzp_test_…) and live keys (rzp_live_…) work the same way.
    get razorpayKeyId() { return required('RAZORPAY_KEY_ID'); },
    get razorpayKeySecret() { return required('RAZORPAY_KEY_SECRET'); },
    get razorpayWebhookSecret() { return required('RAZORPAY_WEBHOOK_SECRET'); },
    get razorpayPlans() { return { monthly: process.env.RAZORPAY_PLAN_MONTHLY || '', yearly: process.env.RAZORPAY_PLAN_YEARLY || '' }; },
    // Display-only labels shown on the upgrade buttons (the real price lives in the Razorpay plan).
    get premiumPriceLabels() { return { monthly: process.env.PREMIUM_PRICE_MONTHLY || '', yearly: process.env.PREMIUM_PRICE_YEARLY || '' }; },
    // Checkout needs the API keys and both plans. The webhook secret is only
    // needed by the webhook route (Checkout's verify step + sync work without it,
    // e.g. on localhost where Razorpay cannot reach a webhook).
    get billingEnabled() {
        return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
            && process.env.RAZORPAY_PLAN_MONTHLY && process.env.RAZORPAY_PLAN_YEARLY);
    },
    get webhookEnabled() {
        return this.billingEnabled && Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
    }
};
