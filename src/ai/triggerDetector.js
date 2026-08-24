const STRESS_KEYWORDS = [
    // English stress
    /\b(stressed|stressing|stressful|so stressed|too stressed)\b/i,
    /\b(overwhelmed|burnt out|burnout|exhausted|so tired|drained)\b/i,
    /\b(deadline|deadlines|exams?|finals?|midterms?)\b/i,
    /\b(hate my (job|life|boss|code|bugs?)|i('m| am) dying|send help|need a break)\b/i,
    /\b(crying right now|failing everything|im dead|i'm dead)\b/i,

    // Hinglish stress
    /\b(bohot stress|bahut stress|tension (hai|ho rahi|mat le|bohot hai)|dima+g kharab|dimag kharab)\b/i,
    /\b(padhai nahi|paddai nahi|exams? aa gaye|exams? aa rahe|thak gaya|thak gayi|mar gaya|marr gaya)\b/i,
    /\b(neend nahi aa rahi|kuch samajh nahi aa raha|lag gaye|chud gaye guru)\b/i
];

const FUN_KEYWORDS = [
    // English fun
    /\b(tell (me )?a (funny )?joke|dad joke|crack a joke)\b/i,
    /\b(make me laugh|make me smile|cheer me up|hype me up|roast me)\b/i,
    /\b(i('m| am) (so )?bored|entertain me|funny story)\b/i,

    // Hinglish fun
    /\b((ek )?joke sunao|hasao|hansao|hanso|roast kar(o)?( mujhe| de)?)\b/i,
    /\b(kya scene hai|kya chal raha hai|bore ho raha|bore ho rahi|kuch funny)\b/i
];

function detectTrigger(text) {
    if (!text || typeof text !== 'string') {
        return { matched: false, type: null, keyword: null };
    }

    const clean = text.trim();

    for (const pattern of STRESS_KEYWORDS) {
        const match = clean.match(pattern);
        if (match) {
            return { matched: true, type: 'stress', keyword: match[0] };
        }
    }

    for (const pattern of FUN_KEYWORDS) {
        const match = clean.match(pattern);
        if (match) {
            return { matched: true, type: 'fun', keyword: match[0] };
        }
    }

    return { matched: false, type: null, keyword: null };
}

class TriggerTracker {
    constructor() {
        this.channelCooldowns = new Map();
        this.userCooldowns = new Map();
    }

    canTrigger(channelId, userId, cooldownSeconds = 15) {
        const now = Date.now();
        const cooldownMs = cooldownSeconds * 1000;

        const lastChannelTime = this.channelCooldowns.get(channelId) || 0;
        if (now - lastChannelTime < cooldownMs) {
            return false;
        }

        const lastUserTime = this.userCooldowns.get(userId) || 0;
        if (now - lastUserTime < cooldownMs) {
            return false;
        }

        return true;
    }

    recordTrigger(channelId, userId) {
        const now = Date.now();
        if (channelId) this.channelCooldowns.set(channelId, now);
        if (userId) this.userCooldowns.set(userId, now);
    }

    reset() {
        this.channelCooldowns.clear();
        this.userCooldowns.clear();
    }
}

const defaultTracker = new TriggerTracker();

module.exports = {
    detectTrigger,
    TriggerTracker,
    defaultTracker
};
