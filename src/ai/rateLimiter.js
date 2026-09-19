/**
 * Per-user sliding-window rate limiter for AI calls (classify + persona reply).
 * Independent of the trigger cooldowns: this protects the NVIDIA API quota,
 * not the chat vibe. Every request needs the LLM, so every request counts.
 */
class RateLimiter {
    constructor({ max = 8, windowMs = 60_000 } = {}) {
        this.max = Math.max(1, Math.floor(max));
        this.windowMs = Math.max(1, Math.floor(windowMs));
        this.hits = new Map();
    }

    /**
     * Record a hit for key if allowed. Returns true when the request may
     * proceed, false when the user is over the limit for this window.
     */
    attempt(key, now = Date.now()) {
        if (!key) return true;
        const windowStart = now - this.windowMs;
        const timestamps = (this.hits.get(key) || []).filter((time) => time > windowStart);

        if (timestamps.length >= this.max) {
            this.hits.set(key, timestamps);
            return false;
        }

        timestamps.push(now);
        this.hits.set(key, timestamps);
        return true;
    }

    remaining(key, now = Date.now()) {
        const windowStart = now - this.windowMs;
        return Math.max(0, this.max - (this.hits.get(key) || []).filter((time) => time > windowStart).length);
    }

    reset() {
        this.hits.clear();
    }
}

const defaultAiRateLimiter = new RateLimiter();

module.exports = { RateLimiter, defaultAiRateLimiter };
