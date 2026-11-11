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
        this.lastSweep = 0;
    }

    // Drop users whose newest hit is outside the window (they would be
    // allowed anyway), at most once per window, so the map holds only
    // recently active users instead of everyone ever seen.
    sweep(now) {
        if (now - this.lastSweep < this.windowMs) return;
        this.lastSweep = now;
        const windowStart = now - this.windowMs;
        for (const [key, timestamps] of this.hits) {
            if (!timestamps.length || timestamps[timestamps.length - 1] <= windowStart) this.hits.delete(key);
        }
    }

    /**
     * Record a hit for key if allowed. Returns true when the request may
     * proceed, false when the user is over the limit for this window.
     * `max` overrides the default cap for this call (e.g. Premium servers).
     */
    attempt(key, now = Date.now(), { max = null } = {}) {
        if (!key) return true;
        const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : this.max;
        this.sweep(now);
        const windowStart = now - this.windowMs;
        const timestamps = (this.hits.get(key) || []).filter((time) => time > windowStart);

        if (timestamps.length >= limit) {
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
        this.lastSweep = 0;
    }
}

const defaultAiRateLimiter = new RateLimiter();

module.exports = { RateLimiter, defaultAiRateLimiter };
