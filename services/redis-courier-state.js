// ==================================================================================
// CourierStateStore — Redis-backed Courier State with In-Memory Fallback
// ==================================================================================
// Manages three courier-related stores:
//   1. Connected Couriers (courierId → socketId mapping)
//   2. Courier Locations (courierId → location data)
//   3. Pending Assignments (courierId → assignment count with TTL)
//
// Redis key schema:
//   HASH   courier:connected            → { courierId: socketId }
//   HASH   courier:connected:branch     → { courierId: branchId }
//   HASH   courier:locations            → { courierId: JSON(locationData) }
//   ZSET   courier:locations:ts         → score=timestamp, member=courierId
//   STRING courier:pending:{courierId}  → pending count (with PEXPIRE)
// ==================================================================================

class CourierStateStore {
    constructor(redisClient, redisAvailableFn) {
        this._redis = redisClient;
        this._isRedisAvailable = redisAvailableFn;

        // In-memory fallback
        this._connected = new Map();       // courierId → socketId
        this._connectedBranch = new Map(); // courierId → branchId
        this._locations = new Map();       // courierId → locationData (object)
        this._pending = new Map();         // courierId → count
        this._pendingTimers = new Map();   // courierId → [timeoutIds]
    }

    _useRedis() {
        return typeof this._isRedisAvailable === 'function'
            ? this._isRedisAvailable()
            : !!this._isRedisAvailable;
    }

    // ==================== Connected Couriers ====================

    async setConnected(courierId, socketId, branchId) {
        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hset('courier:connected', courierId, socketId);
                if (branchId) {
                    pipeline.hset('courier:connected:branch', courierId, branchId);
                }
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CourierState] Redis setConnected error, falling back to memory:', err.message);
            }
        }

        this._connected.set(courierId, socketId);
        if (branchId) this._connectedBranch.set(courierId, branchId);
    }

    async getSocketId(courierId) {
        if (this._useRedis()) {
            try {
                return await this._redis.hget('courier:connected', courierId);
            } catch (err) {
                console.error('[CourierState] Redis getSocketId error:', err.message);
            }
        }
        return this._connected.get(courierId) || null;
    }

    async removeConnected(courierId) {
        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hdel('courier:connected', courierId);
                pipeline.hdel('courier:connected:branch', courierId);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CourierState] Redis removeConnected error:', err.message);
            }
        }

        this._connected.delete(courierId);
        this._connectedBranch.delete(courierId);
    }

    /**
     * Get all connected couriers as array of { courierId, socketId }
     */
    async getAllConnected() {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall('courier:connected');
                if (!all || Object.keys(all).length === 0) return [];
                return Object.entries(all).map(([courierId, socketId]) => ({ courierId, socketId }));
            } catch (err) {
                console.error('[CourierState] Redis getAllConnected error:', err.message);
            }
        }

        return Array.from(this._connected.entries()).map(([courierId, socketId]) => ({ courierId, socketId }));
    }

    /**
     * Get connected couriers for a specific branch
     * Returns array of { courierId, socketId }
     */
    async getConnectedByBranch(branchId) {
        if (this._useRedis()) {
            try {
                const branchMap = await this._redis.hgetall('courier:connected:branch');
                if (!branchMap) return [];
                const courierIds = Object.entries(branchMap)
                    .filter(([, bid]) => bid === branchId)
                    .map(([courierId]) => courierId);

                const results = [];
                for (const courierId of courierIds) {
                    const socketId = await this._redis.hget('courier:connected', courierId);
                    if (socketId) {
                        results.push({ courierId, socketId });
                    }
                }
                return results;
            } catch (err) {
                console.error('[CourierState] Redis getConnectedByBranch error:', err.message);
            }
        }

        const results = [];
        for (const [courierId, socketId] of this._connected.entries()) {
            if (this._connectedBranch.get(courierId) === branchId) {
                results.push({ courierId, socketId });
            }
        }
        return results;
    }

    async connectedCount() {
        if (this._useRedis()) {
            try {
                // HLEN returns the number of fields in the hash
                const all = await this._redis.hgetall('courier:connected');
                return all ? Object.keys(all).length : 0;
            } catch (err) {
                console.error('[CourierState] Redis connectedCount error:', err.message);
            }
        }

        return this._connected.size;
    }

    // ==================== Courier Locations ====================

    async setLocation(courierId, locationData) {
        const ts = Date.now();

        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hset('courier:locations', courierId, JSON.stringify(locationData));
                pipeline.zadd('courier:locations:ts', ts, courierId);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CourierState] Redis setLocation error, falling back to memory:', err.message);
            }
        }

        this._locations.set(courierId, locationData);
    }

    async getLocation(courierId) {
        if (this._useRedis()) {
            try {
                const raw = await this._redis.hget('courier:locations', courierId);
                return raw ? JSON.parse(raw) : null;
            } catch (err) {
                console.error('[CourierState] Redis getLocation error:', err.message);
            }
        }

        return this._locations.get(courierId) || null;
    }

    async removeLocation(courierId) {
        if (this._useRedis()) {
            try {
                const pipeline = this._redis.pipeline();
                pipeline.hdel('courier:locations', courierId);
                pipeline.zrem('courier:locations:ts', courierId);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CourierState] Redis removeLocation error:', err.message);
            }
        }

        this._locations.delete(courierId);
    }

    /**
     * Get all courier locations (for Firestore sync)
     * Returns array of locationData objects
     */
    async getAllLocations() {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall('courier:locations');
                if (!all || Object.keys(all).length === 0) return [];
                return Object.values(all).map(raw => JSON.parse(raw));
            } catch (err) {
                console.error('[CourierState] Redis getAllLocations error:', err.message);
            }
        }

        return Array.from(this._locations.values());
    }

    /**
     * Get locations for a specific branch
     * Returns array of [courierId, locationData]
     */
    async getLocationsByBranch(branchId) {
        if (this._useRedis()) {
            try {
                const all = await this._redis.hgetall('courier:locations');
                if (!all || Object.keys(all).length === 0) return [];
                return Object.entries(all)
                    .map(([courierId, raw]) => [courierId, JSON.parse(raw)])
                    .filter(([, loc]) => loc.branchId === branchId);
            } catch (err) {
                console.error('[CourierState] Redis getLocationsByBranch error:', err.message);
            }
        }

        return Array.from(this._locations.entries())
            .filter(([, loc]) => loc.branchId === branchId);
    }

    /**
     * Delete stale locations older than maxAgeMs
     * Returns number of deleted entries
     */
    async deleteStaleLocations(maxAgeMs) {
        const cutoff = Date.now() - maxAgeMs;
        let deleted = 0;

        if (this._useRedis()) {
            try {
                // Find couriers with timestamps older than cutoff
                const stale = await this._redis.zrangebyscore('courier:locations:ts', '-inf', cutoff);
                if (stale.length > 0) {
                    const pipeline = this._redis.pipeline();
                    for (const courierId of stale) {
                        pipeline.hdel('courier:locations', courierId);
                        pipeline.zrem('courier:locations:ts', courierId);
                    }
                    await pipeline.exec();
                    deleted = stale.length;
                }
                return deleted;
            } catch (err) {
                console.error('[CourierState] Redis deleteStaleLocations error:', err.message);
            }
        }

        const cutoffDate = new Date(cutoff);
        for (const [courierId, loc] of this._locations.entries()) {
            if (new Date(loc.timestamp) < cutoffDate) {
                this._locations.delete(courierId);
                deleted++;
            }
        }
        return deleted;
    }

    // ==================== Pending Assignments ====================

    /**
     * Increment pending assignment count for a courier.
     * In Redis mode: uses INCR + PEXPIRE (auto-expires after ttlMs).
     * In memory mode: uses Map + setTimeout (same behavior as original).
     */
    async incrementPending(courierId, ttlMs) {
        if (this._useRedis()) {
            try {
                const key = `courier:pending:${courierId}`;
                const pipeline = this._redis.pipeline();
                pipeline.incr(key);
                pipeline.pexpire(key, ttlMs);
                await pipeline.exec();
                return;
            } catch (err) {
                console.error('[CourierState] Redis incrementPending error, falling back to memory:', err.message);
            }
        }

        // Memory fallback — replicates original setTimeout-based decrement
        const current = this._pending.get(courierId) || 0;
        this._pending.set(courierId, current + 1);

        const timer = setTimeout(() => {
            const count = this._pending.get(courierId) || 0;
            if (count <= 1) {
                this._pending.delete(courierId);
            } else {
                this._pending.set(courierId, count - 1);
            }
            // Remove timer from tracking
            const timers = this._pendingTimers.get(courierId);
            if (timers) {
                const idx = timers.indexOf(timer);
                if (idx !== -1) timers.splice(idx, 1);
                if (timers.length === 0) this._pendingTimers.delete(courierId);
            }
        }, ttlMs);

        if (!this._pendingTimers.has(courierId)) this._pendingTimers.set(courierId, []);
        this._pendingTimers.get(courierId).push(timer);
    }

    /**
     * Get pending assignment count for a courier
     */
    async getPendingCount(courierId) {
        if (this._useRedis()) {
            try {
                const val = await this._redis.get(`courier:pending:${courierId}`);
                return val ? parseInt(val, 10) : 0;
            } catch (err) {
                console.error('[CourierState] Redis getPendingCount error:', err.message);
            }
        }

        return this._pending.get(courierId) || 0;
    }
}

module.exports = CourierStateStore;
