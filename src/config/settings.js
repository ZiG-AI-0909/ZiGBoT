const required = ['DISCORD_TOKEN', 'NVIDIA_API_KEY'];

const defaultGentleRoles = [
    // Female Gentle Roles
    'ｓｈｅ ﹒ ｈｅｒ',
    'she/her',
    'she / her',
    'she.her',
    'she ﹒ her',
    'girl',
    'girls',
    'female',
    'queen',
    'princess',
    // Male Gentle Roles
    'gentleman',
    'ｇｅｎｔｌｅｍａｎ',
    'king',
    '👑 king',
    'soft boy',
    'ｓｏｆｔ ｂｏｙ',
    'softboy',
    'chill guy',
    'chill bro',
    'good guy',
    'wholesome boy',
    'homie',
    // Universal Gentle Roles
    'gentle',
    'wholesome',
    'softie',
    'peaceful'
];
const defaultNonGentleRoles = ['Users.heer'];

function loadSettings() {
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const parseArgs = (value) => {
        try {
            const parsed = JSON.parse(value || '[]');
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            throw new Error('STT_ARGS and TTS_ARGS must be JSON arrays.');
        }
    };

    const parseList = (value) => {
        if (!value) return [];
        return value.split(',').map((id) => id.trim()).filter(Boolean);
    };

    return {
        discordToken: process.env.DISCORD_TOKEN,
        nvidiaApiKey: process.env.NVIDIA_API_KEY,
        serverOwnerId: process.env.SERVER_OWNER_ID || '',
        serverOwnerRoleName: process.env.SERVER_OWNER_ROLE_NAME || '꧁༺ ZiG ༻꧂',
        aiModel: process.env.AI_MODEL || 'meta/llama-3.1-8b-instruct',
        logChannelId: process.env.LOG_CHANNEL_ID || '',
        respondToAllMessages: process.env.RESPOND_TO_ALL_MESSAGES === 'true',
        chatChannelIds: parseList(process.env.CHAT_CHANNEL_IDS),
        autoReplyKeywords: process.env.AUTO_REPLY_KEYWORDS === 'true',
        cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 15),
        humorStyle: process.env.HUMOR_STYLE || 'witty_stress_relief',
        gentleRoleNames: process.env.GENTLE_ROLE_NAMES
            ? parseList(process.env.GENTLE_ROLE_NAMES)
            : defaultGentleRoles,
        nonGentleRoleNames: process.env.NON_GENTLE_ROLE_NAMES
            ? parseList(process.env.NON_GENTLE_ROLE_NAMES)
            : defaultNonGentleRoles,
        voiceMode: process.env.VOICE_MODE || 'push-to-talk',
        storeTranscripts: process.env.STORE_TRANSCRIPTS === 'true',
        sttCommand: process.env.STT_COMMAND || '',
        sttArgs: parseArgs(process.env.STT_ARGS),
        ttsCommand: process.env.TTS_COMMAND || '',
        ttsArgs: parseArgs(process.env.TTS_ARGS),
        sttTimeoutMs: Number(process.env.STT_TIMEOUT_MS || 60_000),
        ttsTimeoutMs: Number(process.env.TTS_TIMEOUT_MS || 60_000)
    };
}

module.exports = { loadSettings, defaultGentleRoles };
