// ==================================================================================
// RateLimiter — Redis-backed per-tenant token bucket (Plan 27 Faz 2.5)
// ==================================================================================
// Default: 60 req / 60 sn / tenant (Parasut default; destekten teyit edilecek).
// Bos sliding window: timestamps Redis ZSET'inde tutulur, 60 sn'den eski olanlar atilir.
// ==================================================================================

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_SEC = 60;

class RateLimiter {
    constructor({ redis, limit = DEFAULT_LIMIT, windowSec = DEFAULT_WINDOW_SEC, keyPrefix = 'invoicing:parasut:ratelimit:tenant' }) {
        if (!redis) throw new Error('RateLimiter: redis required');
        this.redis = redis;
        this.limit = limit;
        this.windowSec = windowSec;
        this.keyPrefix = keyPrefix;
    }

    /**
     * Try to consume 1 token for the tenant.
     * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
     */
    async tryAcquire(tenantId) {
        const key = `${this.keyPrefix}:${tenantId}`;
        const now = Date.now();
        const windowStart = now - this.windowSec * 1000;

        // Remove expired entries
        if (typeof this.redis.zremrangebyscore === 'function') {
            await this.redis.zremrangebyscore(key, '-inf', windowStart);
        }

        // Count current
        let count = 0;
        if (typeof this.redis.zcard === 'function') {
            count = await this.redis.zcard(key);
        }

        if (count >= this.limit) {
            // Find oldest entry to compute retry-after
            let retryAfterMs = 1000;
            if (typeof this.redis.zrange === 'function') {
                try {
                    const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
                    if (oldest && oldest.length >= 2) {
                        retryAfterMs = Math.max(100, Number(oldest[1]) + this.windowSec * 1000 - now);
                    }
                } catch (e) {
                    // ignore — return default
                }
            }
            return { allowed: false, remaining: 0, retryAfterMs };
        }

        // Consume 1
        await this.redis.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 9)}`);
        if (typeof this.redis.expire === 'function') {
            await this.redis.expire(key, this.windowSec * 2);
        }
        return { allowed: true, remaining: this.limit - count - 1, retryAfterMs: 0 };
    }
}

module.exports = RateLimiter;
