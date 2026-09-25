// Behavior signal detection for accountability. Deliberately CONSERVATIVE:
// a signal must be unambiguous to be recorded — a normal roast exchange or
// a single "shut up" must never be counted against a member. Only patterns
// with no plausible innocent reading match.

const NEGATIVE_PATTERNS = [
    { regex: /\b(f[u*@]ck(ing)?|b[i1*]tch|assh[o0]le|d[i1*]ck|c[u*]nt|motherf[u*]ck(er)?)\b/i, signal: 'toxic' },
    { regex: /\b(tr[a4]nn?y|f[a4]gg?[o0]t|n[i1]gg?[e3]r?|r[e3]t?[a4]?rd|ch[i1]nk|sp[i1]c|k[i1]ke)\b/i, signal: 'slurs' },
    { regex: /\b(kill|hang|beat|stab|shoot|hurt) (your)?self\b|\bjump off (a|the) (bridge|cliff)\b|\bky[s5]\b/i, signal: 'harassment' },
    { regex: /\b(shut up|stfu|no one (likes|cares about) (you|u)|nobody loves you)\b/i, signal: 'harassment' },
    { regex: /\b(idiot|stupid|dumb|loser|useless|pathetic|clown)\b/i, signal: 'toxic' }
];

const POSITIVE_PATTERNS = [
    { regex: /\b(thanks|thank you|thx|ty|tysm|appreciate it|shukriya|dhanyavad)\b/i, signal: 'kind' },
    { regex: /\b(here('?s| is) how|you can (try|use)|the fix is|solved it like this|check the docs|let me help)\b/i, signal: 'helpful' },
    { regex: /\b(you (got|can do) this|proud of you|feel better|take care|hope you feel|tension mat lo|sab theek ho)\b/i, signal: 'supportive' },
    { regex: /\b(let'?s (calm|chill) down|no need to fight|relax (guys|everyone)|drop it|move on)\b/i, signal: 'deescalation' }
];

function detectBehaviorSignals(message) {
    const text = String(message || '').trim();
    if (!text) return { negative: [], positive: [] };
    const negative = [];
    const positive = [];
    for (const { regex, signal } of NEGATIVE_PATTERNS) {
        if (regex.test(text)) negative.push(signal);
    }
    for (const { regex, signal } of POSITIVE_PATTERNS) {
        if (regex.test(text)) positive.push(signal);
    }
    return { negative, positive };
}

// Spam detection is structural: repeated identical content beats any
// content-based heuristic and cannot fire on normal chat.
const SPAM_WINDOW_MS = 10_000;
const SPAM_REPEAT_THRESHOLD = 3;

class BehaviorTracker {
    constructor({ windowMs = SPAM_WINDOW_MS, threshold = SPAM_REPEAT_THRESHOLD } = {}) {
        this.windowMs = windowMs;
        this.threshold = threshold;
        // Map<`${guildId}:${userId}`, { content, count, firstAt }>
        this.recent = new Map();
    }

    // Returns 'spam' when the same content repeats >= threshold within the
    // window; resets counting once the window has fully passed.
    checkSpam(guildId, userId, content, now = Date.now()) {
        const key = `${guildId}:${userId}`;
        const trimmed = String(content || '').trim().toLowerCase();
        if (!trimmed) return false;
        let entry = this.recent.get(key);
        if (!entry || now - entry.firstAt > this.windowMs || entry.content !== trimmed) {
            entry = { content: trimmed, count: 1, firstAt: now };
            this.recent.set(key, entry);
            return false;
        }
        entry.count += 1;
        return entry.count >= this.threshold;
    }

    reset() {
        this.recent.clear();
    }
}

const defaultBehaviorTracker = new BehaviorTracker();

module.exports = {
    detectBehaviorSignals,
    BehaviorTracker,
    defaultBehaviorTracker
};
