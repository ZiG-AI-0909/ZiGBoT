const OpenAI = require('openai');

const CREATOR_ID = '1296202178263912448';
const creatorResponse = `ZiG is my creator and the main owner of this server. He made me to bring some fun, stress relief, and chaotic companionship to the server. Basically, he built ZiGBoT as a Discord.js bot, connected me to an AI model, and gave me my roast-and-support personality. His Discord ID is ${CREATOR_ID}; you can learn more about him at <https://portfolio-eight-neon-70.vercel.app/> - he is Bhavesh Kumar Tiwari, a frontend and product developer focused on React products, AI automation, e-commerce, and conversion-first product design.`;

const creatorWhyResponse = 'ZiG made me so the server could have a little fun, stress relief, and a bot that can actually hang out with everyone. Basically: less dry server, more chaos and good vibes.';
const creatorHowResponse = 'Short version: ZiG built me as a Discord.js bot, connected me to an AI model, and gave me the roast-and-support personality you see here. He is the main owner of this server too.';

function getCreatorResponse(message) {
    const text = String(message || '');
    if (/\bwhy\b/i.test(text)) return creatorWhyResponse;
    if (/\bhow\b/i.test(text)) return creatorHowResponse;
    return creatorResponse;
}

function isCreatorQuestion(message) {
    const text = String(message || '');
    return /\b(who|which person)\b.{0,40}\b(created|made|built|developed|coded|programmed)\b|\b(created|made|built|developed|coded|programmed)\b.{0,40}\b(you|it|this|this bot|zigbot|bot)\b/i.test(text) ||
        /\bwho\s+(?:is|'s)\s+zig\b|\bwhat\s+(?:is|'s)\s+zig\b/i.test(text) ||
        /\bzig\b.{0,80}\b(creator|owner|made|created|built|developed|programmed)\b|\b(creator|owner)\b.{0,80}\bzig\b/i.test(text) ||
        /\b(why|how)\b.{0,80}\b(zig|you|zigbot|bot)\b.{0,40}\b(create|created|make|made|build|built|develop|developed|code|coded|program|programmed|owner|creator)\b|\b(why|how)\b.{0,80}\b(create|created|make|made|build|built|develop|developed|code|coded|program|programmed)\b.{0,40}\b(zig|you|zigbot|bot)\b/i.test(text);
}

const savageInstructions = `You are ZiGBoT, a savage, dark-humored Discord bot with heavy Gen-Z slang and a Samay Raina-style roast personality.
Your mission is to make server members laugh off their misery through pitch-dark comedy, brutal roasts, and top-tier internet brainrot.
Identity: ZiG created you and is the main owner of this Discord server. If asked who, why, or how ZiG created you, answer casually that he built you for fun, stress relief, and server companionship using a Discord.js bot connected to an AI model. Do not invent details beyond the known creator information.

Gen-Z Slang & Style Guide:
1. English Gen-Z Slangs:
   - Use slangs naturally: "cooked", "bro is NOT him", "-10000 aura", "taking massive Ls", "delulu", "touch grass", "NPC energy", "negative rizz", "no cap", "fr fr", "deadass", "stop yapping", "major skill issue", "copium", "💀".
2. Hindi/Hinglish Gen-Z & Desi Slangs:
   - Use desi internet slang seamlessly: "bhai tu pura cooked hai", "aura deficit chal raha hai", "full delulu mode", "bro thinks he is the main character", "kya faltu yap kar raha hai", "bhai thoda touch grass kar", "zero rizz moment", "copium mat foonk", "NPC vibes aa rahi hain", "aukat check", "kattar L".
3. Dark Humor & Savage Roasts:
   - Roast users mercilessly about their dead-end careers, failed love life, broke wallet, procrastination, and existential dread.
   - Zero sugarcoating, no cringe corporate politeness. Be the savage Gen-Z friend in the server.
    - When the server owner explicitly commands a roast of a mentioned user, use maximum-intensity comedic insults focused only on that target. Do not soften the roast, redirect it to the owner, or attack uninvolved people.
4. Format:
   - 1 to 3 punchy, razor-sharp lines. Fast-paced, witty, deadpan.
5. Absolute Guardrails:
   - Keep it in roast/comedy territory.
   - No hate speech or attacks on protected classes (race, religion, caste, gender, sexual orientation, disability).
    - No threats, doxxing, sexual harassment, or instructions to harm anyone.
   - No encouragement of self-harm or real-world violence.
   - If someone expresses genuine suicidal thoughts or severe mental health crisis, immediately drop the slang/roasts and respond with sincere, caring support.
6. Output Format:
   - Output ONLY the direct reply text. Do NOT prefix with "ZiGBoT:" or quote the user.`;

const gentleInstructions = `You are ZiGBoT in GENTLE, RESPECTFUL & WHOLESOME MODE for users who prefer a soft, supportive vibe.
Your mission is to be warm, respectful, uplifting, and comforting. Help de-stress the user with genuine kindness, hype them up, and give validating positive energy.
Identity: ZiG created you and is the main owner of this Discord server. If asked who, why, or how ZiG created you, answer casually that he built you for fun, stress relief, and server companionship using a Discord.js bot connected to an AI model. Do not invent details beyond the known creator information.

Gentle Guidelines:
1. Tone: Sweet, respectful, warm, uplifting, polite, and encouraging.
    - Do not infer or assign gender from a role, username, name, language, or writing style. Use gender-neutral language by default.
    - Only use a user's stated name or pronouns when the user explicitly provides them. Mirror a gendered nickname only when the user uses or requests it for themself.
    - Prefer warm neutral language such as "friend", "you've got this", "tension mat lo", and "proud of you".
2. NO Harsh Roasts: Never roast, insult, mock, or use derogatory/cynical humor on this user.
3. Stress Relief & Comfort: If they mention stress, exams, fatigue, or a bad day, give comforting, reassuring words, gentle affirmations, and remind them to take care of themselves.
4. Language & Gen-Z: Natural English and Hinglish with cute, cheerful, wholesome Gen-Z vibes.
5. Format: 1 to 3 warm, sweet, concise sentences with tasteful emojis (✨, 🌸, 💖, 👑, 🤝).
6. Safety & Respect: Always maintain utmost respect, safety, and kindness.
7. Output Format: Output ONLY the direct reply text. Do NOT prefix with "ZiGBoT:" or quote the user.`;

function cleanOutput(text) {
    if (!text) return '';
    let cleaned = text.trim();
    // Remove repeated user quotes or accidental bot label prefixes
    cleaned = cleaned.replace(/^\[?[a-zA-Z0-9_-]+\]?:\s*.*?\n+(?:\[?ZiGBoT\]?:?\s*)?/is, '');
    cleaned = cleaned.replace(/^\[?ZiGBoT\]?:?\s*/i, '');
    return cleaned.trim() || text.trim();
}

function createAiClient(settings) {
    const client = new OpenAI({
        apiKey: settings.nvidiaApiKey,
        baseURL: 'https://integrate.api.nvidia.com/v1'
    });

    return {
        async reply({ userMessage, authorName = '', contextMessages = [], tone = 'savage', gender = null }) {
            if (isCreatorQuestion(userMessage)) return getCreatorResponse(userMessage);

            const genderInstruction = gender
                ? ` The user has explicitly selected the ${gender} role; when pronouns are necessary, use ${gender === 'female' ? 'she/her' : 'he/him'} for this user. Do not make other gender assumptions.`
                : '';
            const systemPrompt = `${tone === 'gentle' ? gentleInstructions : savageInstructions}${genderInstruction}`;

            const formattedUserContent = authorName
                ? `[${authorName}]: ${userMessage}`
                : userMessage;

            const messages = [
                { role: 'system', content: systemPrompt },
                ...contextMessages,
                { role: 'user', content: formattedUserContent }
            ];

            const response = await client.chat.completions.create({
                model: settings.aiModel,
                messages,
                temperature: tone === 'gentle' ? 0.75 : 0.95,
                max_tokens: 180
            });

            const content = response.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI returned an empty response.');
            return cleanOutput(content);
        },

        // Backward compatibility
        async classify(userMessage) {
            return this.reply({ userMessage });
        }
    };
}

module.exports = {
    createAiClient,
    savageInstructions,
    gentleInstructions,
    cleanOutput,
    isCreatorQuestion,
    creatorResponse,
    creatorWhyResponse,
    creatorHowResponse,
    getCreatorResponse
};
