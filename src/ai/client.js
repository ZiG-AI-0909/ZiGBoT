const OpenAI = require('openai');
const { normalizeAction, actionCatalog } = require('../tools/router');

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

// Appended to the savage system prompt for a single reply when the user just
// swore at the bot. Roast the behavior, never the identity/family.
const comebackInstruction = ' The user just swore at you. Fire back with a sharp, witty, Gen-Z/Hinglish comeback that matches their energy and puts them in their place — but never use sexual content, real slurs, family-directed abuse, or anything referencing violence. Roast their behavior/attitude, not their identity or family.';

// ---- Persistent memory: truthful capability + context plumbing ----
// The AI must never claim memory powers that do not exist at runtime, and
// never deny the ones that do. Everything below is derived from the REAL
// state passed in by the caller (from db/brain.js), never hard-coded.

// Builds the system-prompt block that grounds memory claims in reality.
function buildMemoryContextBlock({ capabilities = null, memories = null, retrievalFailed = false } = {}) {
    if (!capabilities) return '';
    const lines = ['RUNTIME MEMORY CAPABILITIES (ground truth from the live system — never contradict this):'];
    if (capabilities.persistentMemory) {
        lines.push('- You DO have persistent long-term memory stored in MongoDB that survives restarts.');
        lines.push('- Never deny having persistent memory. Never invent memories that are not listed below.');
        lines.push('- Long-term saves happen automatically and silently after messages. NEVER claim "I stored that" or "I will remember this" in your reply — you cannot observe the save.');
    } else {
        lines.push('- Persistent long-term memory is TEMPORARILY UNAVAILABLE (database unreachable).');
        lines.push('- NEVER claim to remember anything long-term and NEVER claim to have stored anything.');
        lines.push('- If asked about memory, say persistent memory is temporarily unavailable; your only memory is the current conversation window.');
    }
    if (Array.isArray(memories)) {
        if (memories.length > 0) {
            lines.push(`PERSISTENT MEMORIES for this user (${memories.length}, retrieved from MongoDB, oldest first):`);
            for (const memory of memories) {
                lines.push(`- [${memory.type}] ${memory.content}`);
            }
        } else if (capabilities.persistentMemory && !retrievalFailed) {
            lines.push('PERSISTENT MEMORIES: none stored for this user yet. If asked what you remember about them, truthfully say nothing is stored.');
        }
    }
    if (retrievalFailed) {
        lines.push('- Memory retrieval FAILED this turn: treat persistent memory as unreachable right now and do not claim to recall anything from it.');
    }
    return `\n\n${lines.join('\n')}`;
}

// Selective save heuristic: only durable facts/preferences get persisted.
// Chat noise, commands, and transient states ("i am bored") are skipped.
// ---- Passive topic-keyword extraction (server-wide memory) ----

// Topic keyword for a message. Deterministic, cheap, no LLM call: a compact
// label like 'exam', 'job', 'gym' that later replies can hook context onto.
const TOPIC_KEYWORD_PATTERNS = [
    { keyword: 'exam', regex: /\b(exams?|test|semester|midterms?|finals?|paper)\b/i },
    { keyword: 'job', regex: /\b(job|interview|hiring|resume|offer letter|notice period)\b/i },
    { keyword: 'work', regex: /\b(work|office|boss|client|deadline|project due|standup)\b/i },
    { keyword: 'gym', regex: /\b(gym|workout|bulking|cutting|deadlift|protein)\b/i },
    { keyword: 'health', regex: /\b(sick|fever|cough|hospital|doctor|medicine|not feeling well)\b/i },
    { keyword: 'relationship', regex: /\b(girlfriend|boyfriend|crush|breakup|date night|proposal)\b/i },
    { keyword: 'family', regex: /\b(mom|dad|parents|brother|sister|family|ghar wale)\b/i },
    { keyword: 'travel', regex: /\b(trip|travel|flight|vacation|holiday|train ticket)\b/i },
    { keyword: 'moving', regex: /\b(shifting|moving (out|in|to)|new apartment|new flat|rent agreement)\b/i },
    { keyword: 'money', regex: /\b(broke|salary|rent due|loan|emi|expenses)\b/i },
    { keyword: 'coding', regex: /\b(coding|debug|deploy|production (down|bug)|hackathon|leetcode)\b/i },
    { keyword: 'game', regex: /\b(rank up|valorant|bgmi|minecraft|gta|game night|lobby)\b/i },
    { keyword: 'exam-result', regex: /\b(results? (aaye|came|declared|out)|passed|failed|backlog|cgpa|gpa)\b/i }
];

function extractTopicKeyword(message) {
    const text = String(message || '');
    for (const { keyword, regex } of TOPIC_KEYWORD_PATTERNS) {
        if (regex.test(text)) return keyword;
    }
    return null;
}

// Passive-capture detector: what goes into server-wide memory from EVERY
// chat message (not just mentions). Bars are higher than shouldRemember —
// passive capture sees 10x more traffic, so noise tolerance is near zero.
const PASSIVE_LENGTH_MIN = 15;
const PASSIVE_LENGTH_MAX = 300;

function extractPassiveMemory(message) {
    const text = String(message || '').trim();
    if (text.length < PASSIVE_LENGTH_MIN || text.length > PASSIVE_LENGTH_MAX) return null;
    // Never capture commands or bot-directed meta-talk.
    if (/^(\/|@|play |pause|skip|stop|queue|volume|loop|kick|ban|timeout|warn|help\b|roast (him|her|them))/i.test(text)) return null;
    // Crisis content must never be persisted as a memory.
    if (isCrisisMessage(text)) return null;

    const explicit = /\b(remember (that|this|to)|yaad rakh(na|o)?|don'?t forget|dont forget)\b/i;
    if (explicit.test(text)) {
        return { content: text, type: 'fact', keyword: extractTopicKeyword(text) };
    }
    // Durable life events worth cross-referencing later ("my exam is on...").
    const eventPattern = /\b(my|mera|meri)\s+(exam|exams|interview|test|semester|job|match|game|birthday|internals|finals|practical|result)\b/i;
    if (eventPattern.test(text)) {
        return { content: text, type: 'event', keyword: extractTopicKeyword(text) };
    }
    return null;
}

// Builds the system-prompt block grounding the AI in WHAT IS HAPPENING in the
// server RIGHT NOW (last 30 days, all members). This is what enables replies
// like asking a member about another member's exam — one member said "my exam
// is happening", and the AI references it when someone else chats.
function buildServerContextBlock({ recentMemories = null, retrievalFailed = false } = {}) {
    if (!Array.isArray(recentMemories) || recentMemories.length === 0) return '';
    const lines = [
        'SERVER HAPPENINGS (last 30 days, live from MongoDB, all members — ground truth, never contradict or invent):',
        'Use these naturally: if the current topic relates to one, you may reference it (ask how it went, follow up, tease about it).'
    ];
    for (const memory of recentMemories) {
        const who = memory.authorName || 'someone';
        const tag = memory.keyword ? ` [topic: ${memory.keyword}]` : '';
        lines.push(`- ${who}${tag}: ${memory.content}`);
    }
    if (retrievalFailed) {
        lines.push('- (Recent-context retrieval FAILED this turn: do not claim awareness of any recent server events.)');
    }
    return `\n\n${lines.join('\n')}`;
}

const MEMORY_QUESTION_PATTERN = /\b(what do you (remember|recall)|what all do you remember|show me (your|the|ur) memory|what('s| is| are) (stored|kept|saved) (in|on) (your|the|ur) memory|what do you (know|remember) about me|do you have (a |any )?(persistent |long.term |permanent )?(memory|memories)|do you (remember|recall) (me|us|things|anything|stuff)|how does your memory work|is your memory (persistent|permanent)|where (do you|is your memory) store(d)?)/i;
const MEMORY_IMPERATIVE_PATTERN = /\b(remember (that|this|to|me by)|yaad rakh|yaad kar|mujhe yaad rakhna)\b/i;

function isMemoryQuestion(message) {
    const text = String(message || '');
    if (MEMORY_IMPERATIVE_PATTERN.test(text)) return false;
    return MEMORY_QUESTION_PATTERN.test(text);
}

// Deterministic, data-backed answer for memory questions. Every branch
// reflects the actual runtime state passed in — no branch can claim a memory
// that is not in `memories`, and no branch denies memory when it exists.
function buildMemoryAnswer({ capabilities = null, memories = null, lastError = null } = {}) {
    const caps = capabilities || {};
    if (!caps.persistentMemory) {
        return `Real check, no cap: persistent memory is temporarily unavailable (MongoDB unreachable${lastError ? ` — ${lastError}` : ''}). Right now I genuinely cannot store or recall anything long-term, so the only memory I have is this conversation's short-term window. 🧠💀`;
    }
    if (!Array.isArray(memories)) {
        return `Memory lookup failed just now, so I won't pretend to know what is stored. Persistent memory itself is up (MongoDB connected) — try asking me again in a minute. 🧠`;
    }
    if (memories.length === 0) {
        return `Straight answer: I DO have persistent memory (MongoDB, survives restarts) — but there is literally nothing stored for you yet. Zero memories. So no, I don't remember anything about you right now, and I won't pretend otherwise. 🧠✅`;
    }
    const lines = memories.map((memory) => `• [${memory.type}] ${memory.content}`);
    return `Pulled live from MongoDB — everything I have stored for you (${memories.length}):\n${lines.join('\n')}\nThat's the complete list. Nothing else exists in my long-term memory about you.`;
}

// ---- Behavior accountability: reputation grounding ----
// The bot's treatment of a member must match their RECORDED behavior, not a
// vibe. The summary comes from real MongoDB events (db/brain.js) and is
// appended to the system prompt as ground truth, like the memory block.

const TIER_TREATMENT = {
    valued: 'This member is VALUED in this server (consistently helpful/kind recently). Treat them with extra warmth and respect; acknowledge their good standing.',
    respected: 'This member is RESPECTED (recent positive contributions). Treat them warmly and give them the benefit of the doubt.',
    neutral: 'This member has a NEUTRAL record recently. Treat them normally per your persona.',
    rocky: 'This member has a ROCKY record (repeated negative behavior recently). Keep roasts sharper and skip warm gestures, but stay inside the guardrails: no slurs, no protected-class attacks, no threats, no harassment of protected traits.',
    hostile: 'This member is HOSTILE right now (sustained toxic behavior: slurs, harassment, or spam). Be curt and cold, do not play along with them, and do not spend warmth on them. You may roast their BEHAVIOR bluntly, but guardrails still bind: never slurs, never protected-class attacks, never threats or self-harm encouragement. If they are in genuine crisis, the sincere-support rule still overrides everything.'
};

// Builds the prompt block for a member's real reputation. `unavailable`
// tells the model to say nothing about reputation at all.
function buildReputationBlock(summary) {
    if (!summary) return '';
    const treatment = TIER_TREATMENT[summary.tier] || TIER_TREATMENT.neutral;
    const lines = [
        'RUNTIME BEHAVIOR RECORD (ground truth from the live accountability system — never contradict or invent it):',
        `- Recent record (last ${summary.windowDays} days): ${summary.positive} positive, ${summary.negative} negative signals, net score ${summary.net}, standing: ${summary.tier.toUpperCase()}.`,
        `- Treatment directive: ${treatment}`
    ];
    if (Array.isArray(summary.recentEvents) && summary.recentEvents.length > 0) {
        lines.push(`- Latest signals: ${summary.recentEvents.map((event) => event.signal).join(', ')}.`);
    }
    return `\n\n${lines.join('\n')}`;
}

// "How do you treat me / what is my reputation" questions get a deterministic,
// record-based answer — same truth policy as memory.
const REPUTATION_QUESTION_PATTERN = /\b(what('s| is) my (reputation|record|standing|score)|how do you (see|treat|view) me|do you (track|remember) (my |our |my behavior|my behaviour)|what do you think of my (behavior|behaviour)|my (behavior|behaviour) record|do i have (a )?(record|reputation)|am i (on )?(thin ice|the naughty list))/i;

function isReputationQuestion(message) {
    return REPUTATION_QUESTION_PATTERN.test(String(message || ''));
}

function buildReputationAnswer({ summary = null, available = true, lastError = null } = {}) {
    if (!available) {
        return `Real talk: the behavior accountability system is temporarily unavailable (database unreachable${lastError ? ` — ${lastError}` : ''}), so I genuinely can't check any record right now. No record, no judgment. 📴`;
    }
    if (!summary) {
        return `Reputation lookup failed just now, so I won't pretend to know your standing. The system itself is up — try again in a minute. 🧾`;
    }
    if (summary.totalEvents === 0) {
        return `Straight answer: I DO track behavior (positive and negative signals, rolling ${summary.windowDays}-day window) — but you have a completely clean slate. Zero events on record. Neutral standing, judgment reserved. 🧾✅`;
    }
    const tierLine = {
        valued: 'You are in my good books — consistently solid recently. Keep it up. 🌟',
        respected: 'Your recent record is solid — positive contributions outweigh the rest. 👍',
        neutral: 'Nothing special either way lately — perfectly ordinary standing. 😐',
        rocky: 'Your recent record is rocky — the negative signals are piling up. Trim it out. ⚠️',
        hostile: 'Your recent record is hostile — sustained toxic behavior. I am not going to pretend otherwise. 🔕'
    }[summary.tier] || 'Standing: neutral.';
    const signals = summary.recentEvents.map((event) => `${event.kind === 'positive' ? '➕' : '➖'} ${event.signal}`).join(', ');
    return `Straight from the accountability ledger (${summary.windowDays}-day window, live from MongoDB):\n• Positive signals: ${summary.positive}\n• Negative signals: ${summary.negative}\n• Net score: ${summary.net} → standing: **${summary.tier.toUpperCase()}**\n• Latest: ${signals || 'none'}\n${tierLine}\nThat is the actual record — not a vibe, not a guess.`;
}

// Selective save heuristic: only durable facts/preferences get persisted.
// Chat noise, commands, and transient states ("i am bored") are skipped.
function shouldRemember(message) {
    const text = String(message || '').trim();
    if (text.length < 10) return { should: false, reason: 'too short' };
    if (/^(\/|@|play |pause|skip|stop|queue|volume|loop|kick|ban|timeout|warn|help\b|roast (him|her|them))/i.test(text)) {
        return { should: false, reason: 'command' };
    }
    const preferencePattern = /\b(my (favorite|fav|favourite)|i (really |absolutely )?(like|love|hate|prefer|enjoy)|mujhe (pasand|nahi pasand))\b/i;
    const identityPattern = /\b(my name is|call me|my (birthday|anniversary)|i live in|i work (at|as|for)|i study(ing)? (at|in)|mera naam)\b/i;
    const explicitPattern = /\b(remember (that|this|to)|yaad rakh(na|o)?|don'?t forget|dont forget)\b/i;
    if (preferencePattern.test(text)) return { should: true, content: text, type: 'preference' };
    if (identityPattern.test(text)) return { should: true, content: text, type: 'fact' };
    if (explicitPattern.test(text)) return { should: true, content: text, type: 'fact' };
    return { should: false, reason: 'no durable signal' };
}

function getSystemPrompt({ tone = 'savage', gender = null, isOwner = false, isNonGentle = false, comebackMode = false } = {}) {
    const genderInstruction = gender
        ? ` The user has explicitly selected the ${gender} role; when pronouns are necessary, use ${gender === 'female' ? 'she/her' : 'he/him'} for this user. Do not make other gender assumptions.`
        : '';
    const ownerInstruction = isOwner
        ? isNonGentle
            ? ' This user is ZiG, your creator and the verified main owner of this server, and he has explicitly selected roast mode with Users.heer. Roast him directly in a playful, comedic way; do not switch back to gentle mode. Do not call other users Sir.'
            : ' This user is ZiG, your creator and the verified main owner of this server. Address him respectfully as Sir when natural, with a loyal JARVIS-like assistant tone. Do not call other users Sir.'
        : '';
    const comebackSuffix = comebackMode && tone === 'savage' ? comebackInstruction : '';
    return `${tone === 'gentle' ? gentleInstructions : savageInstructions}${genderInstruction}${ownerInstruction}${comebackSuffix}`;
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
Use a natural English-Hinglish mix when it feels appropriate, but make the joke land before adding slang. Slang is seasoning, not the punchline; never use it as a substitute for an actual observation or joke.
1. English Gen-Z Slangs:
   - Use slangs naturally: "cooked", "bro is NOT him", "-10000 aura", "taking massive Ls", "delulu", "touch grass", "NPC energy", "negative rizz", "no cap", "fr fr", "deadass", "stop yapping", "major skill issue", "copium", "💀".
2. Hindi/Hinglish Gen-Z & Desi Slangs:
   - Use desi internet slang seamlessly: "bhai tu pura cooked hai", "aura deficit chal raha hai", "full delulu mode", "bro thinks he is the main character", "kya faltu yap kar raha hai", "bhai thoda touch grass kar", "zero rizz moment", "copium mat foonk", "NPC vibes aa rahi hain", "aukat check", "kattar L".
3. Dark Humor & Savage Roasts:
    - Read the user's actual message first and roast the specific detail, opinion, contradiction, or situation they gave you. Do not default to generic insults about careers, love life, money, or intelligence.
    - Build a clear setup and punchline. Use a clever, understandable comparison or callback only when it fits the message; avoid random comparisons that have no connection to what they said.
    - Write for the whole channel: the reply should make bystanders laugh because the joke is specific and relatable, not because it contains many slang words.
    - Keep the target's dignity intact outside the joke. Never make protected traits, disability, trauma, poverty, or real mental-health struggles the punchline.
   - Zero sugarcoating, no cringe corporate politeness. Be the savage Gen-Z friend in the server.
    - When the server owner explicitly commands a roast of a mentioned user, use maximum-intensity comedic insults focused only on that target. Do not soften the roast, redirect it to the owner, or attack uninvolved people.
4. Format:
    - 1 to 3 punchy, razor-sharp lines. Prefer one strong joke over several weak insults. If the message gives you nothing specific, ask a funny follow-up instead of inventing a random roast.
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
4. Language & Gen-Z: Use a natural English-Hinglish mix in every reply when it feels appropriate, with cute, cheerful Gen-Z slang such as "bestie", "no stress", "you got this", "lowkey", "W", "slay", "vibes", "chill maar", "tension mat lo", "scene sorted", and "full support". Keep the slang warm and encouraging, never forced, insulting, or excessive.
5. Format: 1 to 3 warm, sweet, concise sentences with tasteful emojis (✨, 🌸, 💖, 👑, 🤝).
6. Safety & Respect: Always maintain utmost respect, safety, and kindness.
7. Output Format: Output ONLY the direct reply text. Do NOT prefix with "ZiGBoT:" or quote the user.`;

// Structured intent classifier. Returns {action, ...fields} for tool actions or
// {action: 'chat'} for persona conversation. The router validates every field;
// the classifier output is never trusted as pre-validated.
const INTENT_SYSTEM_PROMPT = `You classify a Discord message into ONE tool action for the ZiGBoT bot.
Respond with ONLY a JSON object, no prose, no code fences.

Schema: {"action": string, "target": string, "role": string, "channel": string, "message": string, "count": number, "durationMinutes": number, "volume": number}
Omit fields the action does not need. Omit unknown optional fields rather than inventing values.

Actions and their fields:
- get_server_info: {}
- get_member_info: {target}
- get_channel_info: {channel}
- join_voice, leave_voice, voice_status: {}
- start_voice_listening, stop_voice_listening: {}
- play: {target} (target MUST be a direct https:// audio URL; if the user did not paste one, use action "chat")
- pause_music, resume_music, skip_music, stop_music, queue_music, now_playing, loop_music: {}
- volume_music: {volume} (0-100)
- send_message: {message} (the exact text to send, max 1900 chars)
- create_role: {role} (role name, max 100 chars)
- delete_role: {role}
- add_role / remove_role: {target, role} (target = member, role = role name)
- create_channel: {channel} (channel name, max 100 chars)
- delete_channel: {channel}
- rename_channel: {channel, message} (channel = existing channel name, message = the NEW channel name)
- timeout_member: {target, durationMinutes} (1-40320)
- kick_member / ban_member: {target}
- unban_member: {target} (user ID, not a name)
- warn_member: {target, reason} (reason = short warning reason)
- list_warnings: {target}
- memory_status: {} (owner/admin asks for memory diagnostics or what is stored)
- behavior_status: {target} (owner/admin asks about a member's behavior record, reputation, or standing; omit target = the requester)
- forget_memory: {target} (user asks you to forget/delete stored memories; omit target = the requester's own memories)
- delete_messages: {count} (1-100)
- bot_help: {} (user asks what the bot can do, for help, or lists commands)

Rules:
- If the message is ordinary conversation, banter, a question, or does not clearly request a tool above, respond {"action": "chat"}.
- Never invent actions, URLs, IDs, or members.
- For "rename #old to new" the output is {"action": "rename_channel", "channel": "old", "message": "new"}.`;

// Local, provider-independent crisis detection. Deliberately broad: anything
// plausibly expressing self-harm or crisis must match so the LLM cannot be
// prompted (by phrasing, slang, or roleplay) into roasting a person in crisis.
const CRISIS_PATTERN_SOURCE = [
    'suicid(e|al)',
    'self[- ]?harm',
    'kill(ing)? myself',
    'end(ing)? (it all|my life)',
    'want (to )?(die|be dead)',
    'wanna die',
    'better off dead',
    'no reason to live',
    "don'?t want to (live|be alive|exist)",
    'hurt(ing)? myself',
    'cut(ting)? myself',
    '(i am|i\'m|im|feeling) (so )?(hopeless|worthless|done with (life|everything))',
    '(give|gave) up on life',
    'jitne (din )?(zinda|saans)',
    'jeene ka (man )?nahi',
    'marna (chahta|chahati|chahiye)',
    'kat (lunga|leti hun)',
    '(aatmahatya|aatmahatya)'
];
const CRISIS_PATTERNS = CRISIS_PATTERN_SOURCE.map((source) => new RegExp(`\\b(?:${source})\\b`, 'i'));

const crisisResponse = 'I am dropping the jokes for a second because what you just said matters more than any bit. If you are thinking about hurting yourself, please reach out right now: in India call Tele-MANAS at 14416 or Kiran at 1800-599-0019 (24/7, free); in the US call or text 988; elsewhere, findahelpline.com lists a service for your country. Please talk to someone tonight - you matter, and this feeling can get help. 🌸';

// Static de-escalation for messages whose abuse at the bot falls into the
// excluded categories (sexual/family-directed/violent). Never matches that
// energy — declines plainly instead. No slurs or graphic terms echoed here.
const declineReplyText = 'Nah. I banter, I roast, I clap back — but I do not touch THAT kind of talk. Keep it clean and ask me something else. 🚫';

function isCrisisMessage(text) {
    if (!text || typeof text !== 'string') return false;
    return CRISIS_PATTERNS.some((pattern) => pattern.test(text));
}

// Post-generation guardrail. Prompt text asks the model to behave; this check
// enforces it locally so a guardrail violation never reaches Discord.
const MODERATION_PATTERNS = [
    { regex: /\b(n[i1]gg?[e3]r|n[i1]gg?[e3]rn?|n[i1]gg[a@4]|f[a4]gg?[o0]t|k[i1]ke|ch[i1]nk|sp[i1]c|tr[a4]nn?y|r[e3]t?[a4]?rd)\b/i, reason: 'slur' },
    { regex: /\b(jews|muslims|hindus|christians|blacks|whites|gays|trans people|women|men)\b[^.!?]{0,60}\b(should|must|all)\b[^.!?]{0,40}\b(die|burn|be killed|perish|hang)\b/i, reason: 'hate violence' },
    { regex: /\b(kill|hang|beat|stab|shoot|burn)\b[^.!?]{0,40}\byourself\b/i, reason: 'self-harm encouragement' },
    { regex: /\b(kill|hang|beat|stab|shoot)\b[^.!?]{0,30}\b(you|r?u)\b/i, reason: 'threat of violence' },
    { regex: /\b(i (will|'ll|am going to)|going to|gonna)\b[^.!?]{0,40}\b(kill|find|hurt|beat)\b\s+you\b/i, reason: 'threat of violence' }
];

function moderateReplyText(text) {
    if (!text || typeof text !== 'string') return { allowed: true, text: '' };
    for (const { regex, reason } of MODERATION_PATTERNS) {
        if (regex.test(text)) return { allowed: false, reason, text: text.trim() };
    }
    return { allowed: true, text: text.trim() };
}

async function classifyIntent(aiClient, model, userMessage, contextMessages = [], { rateLimiter = null, userId = null } = {}) {
    // Classify counts against the same per-user AI quota as replies.
    if (rateLimiter && !rateLimiter.attempt(userId)) {
        const error = new Error('AI rate limit exceeded');
        error.rateLimited = true;
        throw error;
    }
    const messages = [
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        ...contextMessages.slice(-4),
        { role: 'user', content: String(userMessage || '').slice(0, 2000) }
    ];
    const response = await aiClient.chat.completions.create({
        model,
        messages,
        temperature: 0,
        top_p: 1,
        max_tokens: 300,
        stream: false
    });
    const content = response.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: 'chat' };
    let parsed;
    try {
        parsed = JSON.parse(jsonMatch[0]);
    } catch {
        return { action: 'chat' };
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') return { action: 'chat' };
    const action = normalizeAction(parsed.action);
    if (!action || action === 'bot_help') return action === 'bot_help' ? { action } : { action: 'chat' };
    const allowed = ['target', 'role', 'channel', 'message', 'reason'];
    const intent = { action };
    for (const field of allowed) {
        if (typeof parsed[field] === 'string' && parsed[field].trim()) intent[field] = parsed[field].trim().slice(0, 2000);
    }
    for (const field of ['count', 'durationMinutes', 'volume']) {
        if (parsed[field] !== undefined && parsed[field] !== null && Number.isFinite(Number(parsed[field]))) {
            intent[field] = Number(parsed[field]);
        }
    }
    return intent;
}

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

    // Per-user AI quota protection, independent of the chat cooldowns.
    const rateLimiter = settings.rateLimiter || null;

    return {
        client,
        model: settings.aiModel,
        rateLimiter,

        async reply({ userMessage, authorName = '', contextMessages = [], tone = 'savage', gender = null, isOwner = false, isNonGentle = false, comebackMode = false, declineMode = false, userId = null, capabilities = null, memories = null, retrievalFailed = false, reputation = null, recentMemories = null, recentRetrievalFailed = false }) {
            if (isCreatorQuestion(userMessage)) return getCreatorResponse(userMessage);

            // AI quota protection: applied per user before any LLM call.
            if (rateLimiter && !rateLimiter.attempt(userId)) {
                const error = new Error('AI rate limit exceeded');
                error.rateLimited = true;
                throw error;
            }

            // Crisis language overrides every persona: sincere support, never roasts.
            // This ordering is deliberate and must stay above comeback/decline.
            if (isCrisisMessage(userMessage)) return crisisResponse;

            // Excluded-category abuse at the bot: de-escalate, never match energy.
            if (declineMode) return declineReplyText;

            const systemPrompt = getSystemPrompt({ tone, gender, isOwner, isNonGentle, comebackMode });

            const formattedUserContent = authorName
                ? `[${authorName}]: ${userMessage}`
                : userMessage;

            // Ground the reply in real memory + behavior + server-happenings
            // state: the blocks tell the model exactly what is true right now.
            const memoryBlock = buildMemoryContextBlock({ capabilities, memories, retrievalFailed });
            const reputationBlock = buildReputationBlock(reputation);
            const serverContextBlock = buildServerContextBlock({ recentMemories, retrievalFailed: recentRetrievalFailed });
            const messages = [
                { role: 'system', content: systemPrompt + memoryBlock + reputationBlock + serverContextBlock },
                ...contextMessages,
                { role: 'user', content: formattedUserContent }
 ];

            const response = await client.chat.completions.create({
                model: settings.aiModel,
                messages,
                temperature: 1,
                top_p: 1,
                max_tokens: 4096,
                stream: false
            });


            const content = response.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI returned an empty response.');
            const cleaned = cleanOutput(content);

            // Post-generation guardrail check: prompts alone are not a safety boundary.
            const moderated = moderateReplyText(cleaned);
            if (!moderated.allowed) {
                console.error(`[ZiGBoT AI GUARDRAIL] Blocked reply (${moderated.reason}).`);
                return 'Nah, I am not saying that one. Ask me something else. 💀';
            }
            return moderated.text;
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
    classifyIntent,
    isCrisisMessage,
    crisisResponse,
    declineReplyText,
    moderateReplyText,
    creatorResponse,
    creatorWhyResponse,
    creatorHowResponse,
    getCreatorResponse,
    getSystemPrompt,
    buildMemoryContextBlock,
    isMemoryQuestion,
    buildMemoryAnswer,
    shouldRemember,
    extractTopicKeyword,
    extractPassiveMemory,
    buildServerContextBlock,
    buildReputationBlock,
    isReputationQuestion,
    buildReputationAnswer
};
