// ==================================================================================
// WebhookStore — Redis-backed GetirYemek Webhook Queue with In-Memory Fallback
// ==================================================================================
// Stores GetirYemek webhook events. WPF polls these via REST API, optionally
// filtered by restaurantSecretKey. Replaces the old getirYemekWebhooks[] array
// and getirWebhookIndex Map.
//
// Redis key schema:
//   HASH   webhooks:getiryemek                              → { webhookId: JSON(webhook) }
//   ZSET   webhooks:getiryemek:ts                           → score=timestamp, member=webhookId
//   SET    webhooks:getiryemek:keys                         → all restaurantSecretKey values
//   HASH   webhooks:getiryemek:idx:{restaurantSecretKey}    → { webhookId: JSON(webhook) }
//   STRING webhooks:getiryemek:_lookup:{webhookId}          → restaurantSecretKey (reverse)
// ==================================================================================

class WebhookStore {
    constructor(redisClient, redisAvailableFn) {
        this._redis = redisClient;
        this._isRedisAvailable = redisAvailableFn;

        // In-memory fallback
        this._webhooks = [];                    // ordered array (FIFO)
        this._index = new Map();                // restaurantSecretKey → Map<webhookId, webhook>
    }

    _useRedis() {
        return typeof this._isRedisAvailable === 'function'
            ? this._isRedisAvailable()
            : !!this._isRedisAvailable;
    }

    _keyFor(webhookId) {
        return `webhooks:getiryemek:_lookup:${webhookId}`;
    }

    _idxKey(restaurantSecretKey) {
        return `webhooks:getiryemek:idx:${restaurantSecretKey}`;
    }

    // ==================== Core Operations ====================

    async add(webhook) {
        const key = webhook.restaurantSecretKey || '__no_key__';
        const ts = webhook.timestamp instanceof Date
            ? webhook.timestamp.getTime()
            : new Date(webhook.timestamp).getTime();

        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hset('webhooks:getiryemek', webhook.id, JSON.stringify(webhook));
                pipeline.zadd('webhooks:getiryemek:ts', ts, webhook.id);
                pipeline.sadd('webhooks:getiryemek:keys', key);
                pipeline.hset(this._idxKey(key), webhook.id, JSON.stringify(webhook));
                pipeline.set(this._keyFor(webhook.id), key);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[WebhookStore] Redis add error, falling back to memory:', err.message);
            }
        }

        // Memory fallback
        this._webhooks.push(webhook);
        if (!this._index.has(key)) this._index.set(key, new Map());
        this._index.get(key).set(webhook.id, webhook);
    }

    async getByRestaurantKey(restaurantSecretKey) {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall(this._idxKey(restaurantSecretKey));
                if (!all || Object.keys(all).length === 0) return [];
                return Object.values(all).map(raw => JSON.parse(raw));
            } catch (err) {
                console.error('[WebhookStore] Redis getByRestaurantKey error, falling back to memory:', err.message);
            }
        }

        const map = this._index.get(restaurantSecretKey);
        return map ? Array.from(map.values()) : [];
    }

    async getAll() {
        if (this._useRedis()) {
            try {
                // Return in timestamp order (FIFO) using ZSET
                const ids = await this._redis.zrange('webhooks:getiryemek:ts', 0, -1);
                if (!ids || ids.length === 0) return [];
                const results = [];
                // Batch fetch from hash
                const pipeline = this._redis.pipeline();
                for (const id of ids) {
                    pipeline.hget('webhooks:getiryemek', id);
                }
                const rawResults = await pipeline.exec();
                for (const [err, raw] of rawResults) {
                    if (!err && raw) results.push(JSON.parse(raw));
                }
                return results;
            } catch (err) {
                console.error('[WebhookStore] Redis getAll error, falling back to memory:', err.message);
            }
        }

        return [...this._webhooks];
    }

    async deleteById(webhookId) {
        if (this._useRedis()) {
            try {
                const key = await this._redis.get(this._keyFor(webhookId));
                if (!key) return null;
                const raw = await this._redis.hget('webhooks:getiryemek', webhookId);
                const webhook = raw ? JSON.parse(raw) : null;

                const pipeline = this._redis.pipeline();
                pipeline.hdel('webhooks:getiryemek', webhookId);
                pipeline.zrem('webhooks:getiryemek:ts', webhookId);
                pipeline.hdel(this._idxKey(key), webhookId);
                pipeline.del(this._keyFor(webhookId));
                await pipeline.exec();

                // Clean up empty key set entry
                const remaining = await this._redis.hlen(this._idxKey(key));
                if (remaining === 0) {
                    await this._redis.srem('webhooks:getiryemek:keys', key);
                }

                return webhook;
            } catch (err) {
                console.error('[WebhookStore] Redis deleteById error, falling back to memory:', err.message);
            }
        }

        // Memory fallback
        const index = this._webhooks.findIndex(w => w.id === webhookId);
        if (index === -1) return null;
        const removed = this._webhooks[index];
        this._webhooks.splice(index, 1);

        // Remove from index
        const key = removed.restaurantSecretKey || '__no_key__';
        const map = this._index.get(key);
        if (map) {
            map.delete(webhookId);
            if (map.size === 0) this._index.delete(key);
        }

        return removed;
    }

    // ==================== Info ====================

    async size() {
        if (this._useRedis()) {
            try {
                return await this._redis.hlen('webhooks:getiryemek');
            } catch (err) {
                console.error('[WebhookStore] Redis size error, falling back to memory:', err.message);
            }
        }
        return this._webhooks.length;
    }

    async indexedKeyCount() {
        if (this._useRedis()) {
            try {
                return await this._redis.scard('webhooks:getiryemek:keys');
            } catch (err) {
                console.error('[WebhookStore] Redis indexedKeyCount error, falling back to memory:', err.message);
            }
        }
        return this._index.size;
    }

    // ==================== Cleanup ====================

    async deleteOlderThan(date) {
        const threshold = date instanceof Date ? date.getTime() : new Date(date).getTime();
        let deleted = 0;

        if (this._useRedis()) {
            try {
                const old = await this._redis.zrangebyscore('webhooks:getiryemek:ts', '-inf', threshold);
                if (old.length > 0) {
                    for (const webhookId of old) {
                        const key = await this._redis.get(this._keyFor(webhookId));
                        const pipeline = this._redis.pipeline();
                        pipeline.hdel('webhooks:getiryemek', webhookId);
                        pipeline.zrem('webhooks:getiryemek:ts', webhookId);
                        if (key) {
                            pipeline.hdel(this._idxKey(key), webhookId);
                            pipeline.del(this._keyFor(webhookId));
                        }
                        await pipeline.exec();

                        // Clean up empty key set entry
                        if (key) {
                            const remaining = await this._redis.hlen(this._idxKey(key));
                            if (remaining === 0) {
                                await this._redis.srem('webhooks:getiryemek:keys', key);
                            }
                        }
                        deleted++;
                    }
                }
                if (deleted > 0) {
                    console.log(`[WebhookStore] Cleanup: removed ${deleted} webhooks older than ${new Date(threshold).toISOString()}`);
                }
                return deleted;
            } catch (err) {
                console.error('[WebhookStore] Redis deleteOlderThan error, falling back to memory:', err.message);
            }
        }

        // Memory fallback
        for (let i = this._webhooks.length - 1; i >= 0; i--) {
            if (new Date(this._webhooks[i].timestamp).getTime() < threshold) {
                const removed = this._webhooks[i];
                this._webhooks.splice(i, 1);
                // Remove from index
                const key = removed.restaurantSecretKey || '__no_key__';
                const map = this._index.get(key);
                if (map) {
                    map.delete(removed.id);
                    if (map.size === 0) this._index.delete(key);
                }
                deleted++;
            }
        }
        if (deleted > 0) {
            console.log(`[WebhookStore] Cleanup: removed ${deleted} webhooks older than ${new Date(threshold).toISOString()}`);
        }
        return deleted;
    }
}

module.exports = WebhookStore;
