// ==================================================================================
// Redis Client Wrapper — Graceful Fallback to In-Memory
// ==================================================================================
// REDIS_URL env varsa ioredis ile bağlanır, yoksa MemoryFallback kullanır.
// Üst katman kodu her iki modda da aynı API'yi kullanır.
// ==================================================================================

let Redis;
try {
    Redis = require('ioredis');
} catch (e) {
    // ioredis yüklü değilse fallback'e düş
    Redis = null;
}

// ==================== In-Memory Fallback ====================

class MemoryFallback {
    constructor() {
        this._strings = new Map();
        this._hashes = new Map();
        this._sets = new Map();
        this._sortedSets = new Map();
        this.status = 'ready'; // ioredis uyumlu
    }

    // --- String commands ---
    async get(key) {
        return this._strings.get(key) || null;
    }

    async set(key, value) {
        this._strings.set(key, value);
        return 'OK';
    }

    async setex(key, seconds, value) {
        this._strings.set(key, value);
        // In memory mode, schedule deletion after TTL
        if (seconds > 0) {
            setTimeout(() => this._strings.delete(key), seconds * 1000);
        }
        return 'OK';
    }

    async del(...keys) {
        let count = 0;
        for (const key of keys) {
            if (this._strings.delete(key)) count++;
            if (this._hashes.delete(key)) count++;
            if (this._sets.delete(key)) count++;
            if (this._sortedSets.delete(key)) count++;
        }
        return count;
    }

    async expire(_key, _seconds) {
        // No-op in memory mode — items live until explicitly deleted
        return 1;
    }

    // --- Hash commands ---
    async hset(key, field, value) {
        if (!this._hashes.has(key)) this._hashes.set(key, new Map());
        this._hashes.get(key).set(field, value);
        return 1;
    }

    async hget(key, field) {
        const hash = this._hashes.get(key);
        if (!hash) return null;
        return hash.get(field) || null;
    }

    async hgetall(key) {
        const hash = this._hashes.get(key);
        if (!hash || hash.size === 0) return {};
        const obj = {};
        for (const [f, v] of hash) obj[f] = v;
        return obj;
    }

    async hdel(key, ...fields) {
        const hash = this._hashes.get(key);
        if (!hash) return 0;
        let count = 0;
        for (const f of fields) {
            if (hash.delete(f)) count++;
        }
        if (hash.size === 0) this._hashes.delete(key);
        return count;
    }

    // --- Set commands ---
    async sadd(key, ...members) {
        if (!this._sets.has(key)) this._sets.set(key, new Set());
        const set = this._sets.get(key);
        let added = 0;
        for (const m of members) {
            if (!set.has(m)) { set.add(m); added++; }
        }
        return added;
    }

    async srem(key, ...members) {
        const set = this._sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const m of members) {
            if (set.delete(m)) removed++;
        }
        if (set.size === 0) this._sets.delete(key);
        return removed;
    }

    async smembers(key) {
        const set = this._sets.get(key);
        return set ? Array.from(set) : [];
    }

    // --- Sorted Set commands ---
    async zadd(key, score, member) {
        if (!this._sortedSets.has(key)) this._sortedSets.set(key, new Map());
        this._sortedSets.get(key).set(member, score);
        return 1;
    }

    async zrangebyscore(key, min, max) {
        const zset = this._sortedSets.get(key);
        if (!zset) return [];
        const results = [];
        for (const [member, score] of zset) {
            const s = Number(score);
            const lo = min === '-inf' ? -Infinity : Number(min);
            const hi = max === '+inf' ? Infinity : Number(max);
            if (s >= lo && s <= hi) results.push(member);
        }
        // Sort by score ascending
        results.sort((a, b) => zset.get(a) - zset.get(b));
        return results;
    }

    async zrem(key, ...members) {
        const zset = this._sortedSets.get(key);
        if (!zset) return 0;
        let removed = 0;
        for (const m of members) {
            if (zset.delete(m)) removed++;
        }
        if (zset.size === 0) this._sortedSets.delete(key);
        return removed;
    }

    async zcard(key) {
        const zset = this._sortedSets.get(key);
        return zset ? zset.size : 0;
    }

    // --- Connection (no-op for memory) ---
    async ping() { return 'PONG'; }
    async quit() { return 'OK'; }
    disconnect() { }
    duplicate() { return new MemoryFallback(); }
}

// ==================== Redis Client Singleton ====================

let client = null;
let mode = 'uninitialized'; // 'redis' | 'memory' | 'uninitialized'

function createClient() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl || !Redis) {
        if (!Redis) {
            console.log('[Redis] ioredis not installed, using in-memory fallback');
        } else {
            console.log('[Redis] No REDIS_URL, using in-memory fallback');
        }
        client = new MemoryFallback();
        mode = 'memory';
        return client;
    }

    console.log('[Redis] Connecting to Redis...');
    client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            if (times > 10) {
                console.error('[Redis] Max reconnect attempts reached, giving up');
                return null; // stop retrying
            }
            const delay = Math.min(times * 200, 5000); // exponential backoff, max 5s
            console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
            return delay;
        },
        lazyConnect: false,
        enableReadyCheck: true,
        connectTimeout: 10000,
    });

    client.on('connect', () => {
        console.log('[Redis] Connected');
        mode = 'redis';
    });

    client.on('ready', () => {
        console.log('[Redis] Ready');
        mode = 'redis';
    });

    client.on('error', (err) => {
        console.error('[Redis] Error:', err.message);
    });

    client.on('close', () => {
        console.log('[Redis] Connection closed');
    });

    client.on('end', () => {
        console.log('[Redis] Connection ended — falling back to memory');
        // Don't replace client here — ioredis will auto-reconnect if retryStrategy allows
    });

    mode = 'redis';
    return client;
}

function getRedisClient() {
    if (!client) {
        createClient();
    }
    return client;
}

function isRedisAvailable() {
    if (!client) return false;
    if (client instanceof MemoryFallback) return false;
    return client.status === 'ready';
}

function getRedisMode() {
    return mode;
}

function getRedisStatus() {
    if (!client) return { connected: false, mode: 'uninitialized' };
    if (client instanceof MemoryFallback) {
        return { connected: false, mode: 'memory' };
    }
    return {
        connected: client.status === 'ready',
        mode: 'redis',
        status: client.status,
    };
}

module.exports = {
    getRedisClient,
    isRedisAvailable,
    getRedisMode,
    getRedisStatus,
    MemoryFallback, // exported for testing
};
