import 'server-only';

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
    get botCreatorId() { return process.env.BOT_CREATOR_ID || ''; }
};
