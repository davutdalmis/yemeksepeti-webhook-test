// ==================================================================================
// CancellationStore — Redis-backed Cancellation Queue with In-Memory Fallback
// ==================================================================================
// Stores YemekSepeti cancellation events. WPF polls these via REST API.
// Currently no code calls .set() — the store exists for future use and to
// keep the endpoint contract intact during the Redis migration.
//
// Redis key schema:
//   HASH   cancellations              → { cancellationId: JSON(data) }
//   ZSET   cancellations:ts           → score=timestamp, member=cancellationId
// ==================================================================================

class CancellationStore {
    constructor(redisClient, redisAvailableFn) {
        this._redis = redisClient;
        this._isRedisAvailable = redisAvailableFn;

        // In-memory fallback
        this._cancellations = new Map(); // cancellationId → data
    }

    _useRedis() {
        return typeof this._isRedisAvailable === 'function'
            ? this._isRedisAvailable()
            : !!this._isRedisAvailable;
    }

    // ==================== Core CRUD ====================

    async set(cancellationId, data) {
        const stored = { ...data, createdAt: data.createdAt || new Date().toISOString() };
        const ts = new Date(stored.createdAt).getTime();

        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hset('cancellations', cancellationId, JSON.stringify(stored));
                pipeline.zadd('cancellations:ts', ts, cancellationId);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CancellationStore] Redis set error, falling back to memory:', err.message);
            }
        }

        this._cancellations.set(cancellationId, stored);
    }

    async has(cancellationId) {
        if (this._useRedis()) {
            try {
                const exists = await this._redis.hexists('cancellations', cancellationId);
                return !!exists;
            } catch (err) {
                console.error('[CancellationStore] Redis has error, falling back to memory:', err.message);
            }
        }
        return this._cancellations.has(cancellationId);
    }

    async delete(cancellationId) {
        if (this._useRedis()) {
            try {
                const existed = await this._redis.hexists('cancellations', cancellationId);
                if (!existed) return false;
                const pipeline = this._redis.pipeline();
                pipeline.hdel('cancellations', cancellationId);
                pipeline.zrem('cancellations:ts', cancellationId);
                await pipeline.exec();
                return true;
            } catch (err) {
                console.error('[CancellationStore] Redis delete error, falling back to memory:', err.message);
            }
        }

        if (!this._cancellations.has(cancellationId)) return false;
        this._cancellations.delete(cancellationId);
        return true;
    }

    // ==================== Queries ====================

    async getAll() {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall('cancellations');
                if (!all || Object.keys(all).length === 0) return [];
                return Object.values(all).map(raw => JSON.parse(raw));
            } catch (err) {
                console.error('[CancellationStore] Redis getAll error, falling back to memory:', err.message);
            }
        }
        return Array.from(this._cancellations.values());
    }

    async getByBranch(branchId) {
        const all = await this.getAll();
        return all.filter(c => c.branchId === branchId);
    }

    async size() {
        if (this._useRedis()) {
            try {
                return await this._redis.hlen('cancellations');
            } catch (err) {
                console.error('[CancellationStore] Redis size error, falling back to memory:', err.message);
            }
        }
        return this._cancellations.size;
    }

    // ==================== Cleanup ====================

    async deleteOlderThan(date) {
        const threshold = date instanceof Date ? date.getTime() : new Date(date).getTime();
        let deleted = 0;

        if (this._useRedis()) {
            try {
                const old = await this._redis.zrangebyscore('cancellations:ts', '-inf', threshold);
                if (old.length > 0) {
                    const pipeline = this._redis.pipeline();
                    for (const id of old) {
                        pipeline.hdel('cancellations', id);
                        pipeline.zrem('cancellations:ts', id);
                    }
                    await pipeline.exec();
                    deleted = old.length;
                }
                if (deleted > 0) {
                    console.log(`[CancellationStore] Cleanup: removed ${deleted} cancellations older than ${new Date(threshold).toISOString()}`);
                }
                return deleted;
            } catch (err) {
                console.error('[CancellationStore] Redis deleteOlderThan error, falling back to memory:', err.message);
            }
        }

        for (const [key, item] of this._cancellations.entries()) {
            if (new Date(item.createdAt).getTime() < threshold) {
                this._cancellations.delete(key);
                deleted++;
            }
        }
        if (deleted > 0) {
            console.log(`[CancellationStore] Cleanup: removed ${deleted} cancellations older than ${new Date(threshold).toISOString()}`);
        }
        return deleted;
    }
}

module.exports = CancellationStore;
