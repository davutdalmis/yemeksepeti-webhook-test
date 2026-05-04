// ==================================================================================
// OrderStore — Redis-backed Order Storage with In-Memory Fallback
// ==================================================================================
// Unified abstraction for order storage. Uses Redis when available for
// horizontal scaling (multiple Railway instances share state), falls back
// to in-memory Maps when Redis is unavailable.
//
// Redis key schema:
//   HASH   orders:{branchId}              → { orderId: JSON(orderData) }
//   ZSET   orders:ts:{branchId}           → score=timestamp, member=orderId
//   SET    orders:branches                 → all branchIds with orders
//   STRING orders:_lookup:{orderId}        → branchId (reverse lookup)
// ==================================================================================

class OrderStore {
    constructor(redisClient, redisAvailableFn, options = {}) {
        this._redis = redisClient;
        this._isRedisAvailable = redisAvailableFn;
        this._maxPerBranch = options.maxPerBranch || 500;
        this._maxTotal = options.maxTotal || 10000;

        // In-memory fallback (used when Redis is not available)
        this._orders = new Map();              // orderId → { order, status, createdAt }
        this._branchIndex = new Map();         // branchId → Set<orderId>
    }

    _useRedis() {
        return typeof this._isRedisAvailable === 'function'
            ? this._isRedisAvailable()
            : !!this._isRedisAvailable;
    }

    // ==================== Core CRUD ====================

    async set(orderId, orderData) {
        const branchId = orderData.order?.branchId || orderData.order?.BranchId || '_unknown';
        const ts = orderData.createdAt instanceof Date
            ? orderData.createdAt.getTime()
            : new Date(orderData.createdAt).getTime();

        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hset(`orders:${branchId}`, orderId, JSON.stringify(orderData));
                pipeline.zadd(`orders:ts:${branchId}`, ts, orderId);
                pipeline.sadd('orders:branches', branchId);
                pipeline.set(`orders:_lookup:${orderId}`, branchId);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[OrderStore] Redis set error, falling back to memory:', err.message);
            }
        }

        // Memory fallback
        this._orders.set(orderId, orderData);
        if (!this._branchIndex.has(branchId)) this._branchIndex.set(branchId, new Set());
        this._branchIndex.get(branchId).add(orderId);
    }

    async get(orderId) {
        if (this._useRedis()) {
            try {
                const branchId = await this._redis.get(`orders:_lookup:${orderId}`);
                if (!branchId) return null;
                const raw = await this._redis.hget(`orders:${branchId}`, orderId);
                return raw ? JSON.parse(raw) : null;
            } catch (err) {
                console.error('[OrderStore] Redis get error, falling back to memory:', err.message);
            }
        }
        return this._orders.get(orderId) || null;
    }

    async has(orderId) {
        if (this._useRedis()) {
            try {
                const branchId = await this._redis.get(`orders:_lookup:${orderId}`);
                if (!branchId) return false;
                const exists = await this._redis.hget(`orders:${branchId}`, orderId);
                return exists !== null;
            } catch (err) {
                console.error('[OrderStore] Redis has error, falling back to memory:', err.message);
            }
        }
        return this._orders.has(orderId);
    }

    async delete(orderId) {
        if (this._useRedis()) {
            try {
                const branchId = await this._redis.get(`orders:_lookup:${orderId}`);
                if (!branchId) return false;
                const pipeline = this._redis.pipeline();
                pipeline.hdel(`orders:${branchId}`, orderId);
                pipeline.zrem(`orders:ts:${branchId}`, orderId);
                pipeline.del(`orders:_lookup:${orderId}`);
                await pipeline.exec();
                // Check if branch still has orders
                const remaining = await this._redis.zcard(`orders:ts:${branchId}`);
                if (remaining === 0) {
                    await this._redis.srem('orders:branches', branchId);
                }
                return true;
            } catch (err) {
                console.error('[OrderStore] Redis delete error, falling back to memory:', err.message);
            }
        }

        if (!this._orders.has(orderId)) return false;
        const item = this._orders.get(orderId);
        const branchId = item?.order?.branchId || item?.order?.BranchId || '_unknown';
        this._orders.delete(orderId);
        const set = this._branchIndex.get(branchId);
        if (set) {
            set.delete(orderId);
            if (set.size === 0) this._branchIndex.delete(branchId);
        }
        return true;
    }

    // ==================== Branch Index ====================

    async getBranchOrders(branchId) {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall(`orders:${branchId}`);
                if (!all || Object.keys(all).length === 0) return [];
                return Object.entries(all).map(([orderId, raw]) => ({
                    orderId,
                    orderData: JSON.parse(raw)
                }));
            } catch (err) {
                console.error('[OrderStore] Redis getBranchOrders error:', err.message);
            }
        }

        const keys = this._branchIndex.get(branchId);
        if (!keys) return [];
        const results = [];
        for (const orderId of keys) {
            const orderData = this._orders.get(orderId);
            if (orderData) results.push({ orderId, orderData });
        }
        return results;
    }

    async getBranchOrderCount(branchId) {
        if (this._useRedis()) {
            try {
                return await this._redis.zcard(`orders:ts:${branchId}`);
            } catch (err) {
                console.error('[OrderStore] Redis getBranchOrderCount error:', err.message);
            }
        }

        const keys = this._branchIndex.get(branchId);
        return keys ? keys.size : 0;
    }

    // ==================== Queries ====================

    async findByField(field, value) {
        if (this._useRedis()) {
            try {
                // Scan all branches for matching field
                const branches = await this._redis.smembers('orders:branches');
                for (const branchId of branches) {
                    const all = await this._redis.hgetall(`orders:${branchId}`);
                    for (const [orderId, raw] of Object.entries(all)) {
                        const data = JSON.parse(raw);
                        if (data.order && (data.order[field] === value)) {
                            return { orderId, orderData: data, branchId };
                        }
                    }
                }
                return null;
            } catch (err) {
                console.error('[OrderStore] Redis findByField error:', err.message);
            }
        }

        for (const [orderId, data] of this._orders.entries()) {
            if (data.order && data.order[field] === value) {
                return { orderId, orderData: data };
            }
        }
        return null;
    }

    async getAllEntries() {
        if (this._useRedis()) {
            try {
                const branches = await this._redis.smembers('orders:branches');
                const entries = [];
                for (const branchId of branches) {
                    const all = await this._redis.hgetall(`orders:${branchId}`);
                    for (const [orderId, raw] of Object.entries(all)) {
                        entries.push([orderId, JSON.parse(raw)]);
                    }
                }
                return entries;
            } catch (err) {
                console.error('[OrderStore] Redis getAllEntries error:', err.message);
            }
        }

        return [...this._orders.entries()];
    }

    async size() {
        if (this._useRedis()) {
            try {
                const branches = await this._redis.smembers('orders:branches');
                let total = 0;
                for (const branchId of branches) {
                    total += await this._redis.zcard(`orders:ts:${branchId}`);
                }
                return total;
            } catch (err) {
                console.error('[OrderStore] Redis size error:', err.message);
            }
        }
        return this._orders.size;
    }

    async indexedBranchCount() {
        if (this._useRedis()) {
            try {
                const branches = await this._redis.smembers('orders:branches');
                return branches.length;
            } catch (err) {
                console.error('[OrderStore] Redis indexedBranchCount error:', err.message);
            }
        }
        return this._branchIndex.size;
    }

    // ==================== Cleanup / Eviction ====================

    async evictOldestInBranch(branchId) {
        const count = await this.getBranchOrderCount(branchId);
        if (count < this._maxPerBranch) return false;

        if (this._useRedis()) {
            try {
                // ZRANGE with LIMIT to get oldest member
                const oldest = await this._redis.zrangebyscore(`orders:ts:${branchId}`, '-inf', '+inf', 'LIMIT', 0, 1);
                if (oldest && oldest.length > 0) {
                    const oldestId = oldest[0];
                    const pipeline = this._redis.pipeline();
                    pipeline.hdel(`orders:${branchId}`, oldestId);
                    pipeline.zrem(`orders:ts:${branchId}`, oldestId);
                    pipeline.del(`orders:_lookup:${oldestId}`);
                    await pipeline.exec();
                    console.log(`[OrderStore] Branch ${branchId} cap (${this._maxPerBranch}), evicted oldest`);
                    return true;
                }
                return false;
            } catch (err) {
                console.error('[OrderStore] Redis evictOldestInBranch error:', err.message);
            }
        }

        // Memory fallback
        const keys = this._branchIndex.get(branchId);
        if (!keys || keys.size < this._maxPerBranch) return false;

        let oldestKey = null;
        let oldestTime = Infinity;
        for (const key of keys) {
            const item = this._orders.get(key);
            if (item) {
                const t = new Date(item.createdAt).getTime();
                if (t < oldestTime) { oldestTime = t; oldestKey = key; }
            }
        }
        if (oldestKey) {
            this._orders.delete(oldestKey);
            keys.delete(oldestKey);
            if (keys.size === 0) this._branchIndex.delete(branchId);
            console.log(`[OrderStore] Branch ${branchId} cap (${this._maxPerBranch}), evicted oldest`);
            return true;
        }
        return false;
    }

    async evictOldestGlobal() {
        const total = await this.size();
        if (total < this._maxTotal) return false;

        if (this._useRedis()) {
            try {
                // Find the globally oldest order across all branches
                const branches = await this._redis.smembers('orders:branches');
                let globalOldestId = null;
                let globalOldestBranch = null;
                let globalOldestScore = Infinity;

                for (const branchId of branches) {
                    // Get oldest in each branch (score = timestamp)
                    const result = await this._redis.zrangebyscore(
                        `orders:ts:${branchId}`, '-inf', '+inf', 'LIMIT', 0, 1
                    );
                    if (result && result.length > 0) {
                        const score = await this._redis.zscore(`orders:ts:${branchId}`, result[0]);
                        if (Number(score) < globalOldestScore) {
                            globalOldestScore = Number(score);
                            globalOldestId = result[0];
                            globalOldestBranch = branchId;
                        }
                    }
                }

                if (globalOldestId && globalOldestBranch) {
                    const pipeline = this._redis.pipeline();
                    pipeline.hdel(`orders:${globalOldestBranch}`, globalOldestId);
                    pipeline.zrem(`orders:ts:${globalOldestBranch}`, globalOldestId);
                    pipeline.del(`orders:_lookup:${globalOldestId}`);
                    await pipeline.exec();
                    // Clean up empty branch
                    const remaining = await this._redis.zcard(`orders:ts:${globalOldestBranch}`);
                    if (remaining === 0) {
                        await this._redis.srem('orders:branches', globalOldestBranch);
                    }
                    console.log(`[OrderStore] Global cap (${this._maxTotal}), evicted oldest`);
                    return true;
                }
                return false;
            } catch (err) {
                console.error('[OrderStore] Redis evictOldestGlobal error:', err.message);
            }
        }

        // Memory fallback
        if (this._orders.size < this._maxTotal) return false;
        let oldestKey = null;
        let oldestTime = Infinity;
        let oldestBranch = null;
        for (const [key, item] of this._orders.entries()) {
            const t = new Date(item.createdAt).getTime();
            if (t < oldestTime) {
                oldestTime = t;
                oldestKey = key;
                oldestBranch = item.order?.branchId || item.order?.BranchId;
            }
        }
        if (oldestKey) {
            this._orders.delete(oldestKey);
            if (oldestBranch) {
                const set = this._branchIndex.get(oldestBranch);
                if (set) {
                    set.delete(oldestKey);
                    if (set.size === 0) this._branchIndex.delete(oldestBranch);
                }
            }
            console.log(`[OrderStore] Global cap (${this._maxTotal}), evicted oldest`);
            return true;
        }
        return false;
    }

    async deleteOlderThan(date) {
        const threshold = date instanceof Date ? date.getTime() : new Date(date).getTime();
        let deleted = 0;

        if (this._useRedis()) {
            try {
                const branches = await this._redis.smembers('orders:branches');
                for (const branchId of branches) {
                    // Find all members with score < threshold
                    const old = await this._redis.zrangebyscore(`orders:ts:${branchId}`, '-inf', threshold);
                    if (old.length > 0) {
                        const pipeline = this._redis.pipeline();
                        for (const orderId of old) {
                            pipeline.hdel(`orders:${branchId}`, orderId);
                            pipeline.zrem(`orders:ts:${branchId}`, orderId);
                            pipeline.del(`orders:_lookup:${orderId}`);
                        }
                        await pipeline.exec();
                        deleted += old.length;
                    }
                    // Clean up empty branch
                    const remaining = await this._redis.zcard(`orders:ts:${branchId}`);
                    if (remaining === 0) {
                        await this._redis.srem('orders:branches', branchId);
                    }
                }
                if (deleted > 0) {
                    console.log(`[OrderStore] Scheduled cleanup: removed ${deleted} orders older than ${new Date(threshold).toISOString()}`);
                }
                return deleted;
            } catch (err) {
                console.error('[OrderStore] Redis deleteOlderThan error:', err.message);
            }
        }

        // Memory fallback
        for (const [key, item] of this._orders.entries()) {
            if (new Date(item.createdAt).getTime() < threshold) {
                const branchId = item.order?.branchId || item.order?.BranchId;
                this._orders.delete(key);
                if (branchId) {
                    const set = this._branchIndex.get(branchId);
                    if (set) {
                        set.delete(key);
                        if (set.size === 0) this._branchIndex.delete(branchId);
                    }
                }
                deleted++;
            }
        }
        if (deleted > 0) {
            console.log(`[OrderStore] Scheduled cleanup: removed ${deleted} orders older than ${new Date(threshold).toISOString()}`);
        }
        return deleted;
    }

    async cleanupBranch(branchId, thresholdMs) {
        const threshold = Date.now() - thresholdMs;
        let cleaned = 0;

        if (this._useRedis()) {
            try {
                const old = await this._redis.zrangebyscore(`orders:ts:${branchId}`, '-inf', threshold);
                if (old.length > 0) {
                    const pipeline = this._redis.pipeline();
                    for (const orderId of old) {
                        pipeline.hdel(`orders:${branchId}`, orderId);
                        pipeline.zrem(`orders:ts:${branchId}`, orderId);
                        pipeline.del(`orders:_lookup:${orderId}`);
                    }
                    await pipeline.exec();
                    cleaned = old.length;
                    // Clean up empty branch
                    const remaining = await this._redis.zcard(`orders:ts:${branchId}`);
                    if (remaining === 0) {
                        await this._redis.srem('orders:branches', branchId);
                    }
                }
                if (cleaned > 0) {
                    console.log(`[OrderStore] Branch ${branchId}: removed ${cleaned} orders older than ${thresholdMs / 60000}min`);
                }
                return cleaned;
            } catch (err) {
                console.error('[OrderStore] Redis cleanupBranch error:', err.message);
            }
        }

        // Memory fallback
        const keys = this._branchIndex.get(branchId);
        if (!keys) return 0;
        const thresholdDate = new Date(threshold);
        for (const key of keys) {
            const item = this._orders.get(key);
            if (item && new Date(item.createdAt) < thresholdDate) {
                this._orders.delete(key);
                keys.delete(key);
                cleaned++;
            }
        }
        if (keys.size === 0) this._branchIndex.delete(branchId);
        if (cleaned > 0) {
            console.log(`[OrderStore] Branch ${branchId}: removed ${cleaned} orders older than ${thresholdMs / 60000}min`);
        }
        return cleaned;
    }
}

module.exports = OrderStore;
