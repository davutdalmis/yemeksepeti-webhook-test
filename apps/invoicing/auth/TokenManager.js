// ==================================================================================
// TokenManager — per-tenant Parasut access token cache, refresh, concurrent lock
// ==================================================================================
// Plan 27 1.3.
// Redis key: invoicing:parasut:tenant:{tenantId}:token  -> { accessToken, expiresAt, refreshToken, providerName }
// Lock key:  invoicing:parasut:tenant:{tenantId}:token:lock
// TTL: token.expires_in - 200 sn safety margin (~7000 sn for Parasut'in default 7200).
// Concurrent: SET ... NX PX ile lock; lock alinamazsa polling ile cache hit'i bekle.
// ==================================================================================

const TOKEN_KEY = (tid) => `invoicing:parasut:tenant:${tid}:token`;
const LOCK_KEY = (tid) => `invoicing:parasut:tenant:${tid}:token:lock`;
const SAFETY_MARGIN_SEC = 200;
const LOCK_TTL_MS = 10000;
const POLL_INTERVAL_MS = 250;
const MAX_POLLS = 40;

class TokenManager {
    /**
     * @param {object} deps
     * @param {object} deps.redis  ioredis-uyumlu client (shared/redis-client'tan)
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     *        TenantId verilince IInvoiceProvider instance dondurur (cred decrypt + new Provider).
     */
    constructor({ redis, providerFactory }) {
        if (!redis) throw new Error('TokenManager: redis required');
        if (!providerFactory) throw new Error('TokenManager: providerFactory required');
        this.redis = redis;
        this.providerFactory = providerFactory;
    }

    /**
     * Get a valid access token for the tenant.
     * Cache hit -> instant return.
     * Cache miss -> acquire lock, fetch via provider.authenticate(), cache, return.
     * Lock contention -> poll cache.
     */
    async getValidToken(tenantId) {
        if (!tenantId) throw new Error('tenantId required');

        const cached = await this._readCache(tenantId);
        if (cached && this._isFresh(cached)) {
            return cached.accessToken;
        }

        const lockAcquired = await this._tryLock(tenantId);
        if (!lockAcquired) {
            return await this._waitForCache(tenantId);
        }

        try {
            // Double-check in case another process populated while we waited
            const recheck = await this._readCache(tenantId);
            if (recheck && this._isFresh(recheck)) {
                return recheck.accessToken;
            }

            const token = await this._fetchAndCache(tenantId, cached);
            return token.accessToken;
        } finally {
            await this._releaseLock(tenantId).catch(() => {});
        }
    }

    /**
     * Force refresh — used after 401 from provider.
     */
    async refreshToken(tenantId) {
        await this._releaseLock(tenantId).catch(() => {});
        const cached = await this._readCache(tenantId);
        const lockAcquired = await this._tryLock(tenantId);
        if (!lockAcquired) {
            return await this._waitForCache(tenantId);
        }
        try {
            const token = await this._fetchAndCache(tenantId, cached, true);
            return token.accessToken;
        } finally {
            await this._releaseLock(tenantId).catch(() => {});
        }
    }

    async invalidateToken(tenantId) {
        await this.redis.del(TOKEN_KEY(tenantId));
    }

    // ------------------ internals ------------------

    async _readCache(tenantId) {
        const raw = await this.redis.get(TOKEN_KEY(tenantId));
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    _isFresh(entry) {
        if (!entry || !entry.expiresAt) return false;
        return Date.now() + 1000 < Number(entry.expiresAt);
    }

    async _tryLock(tenantId) {
        const r = await this.redis.set(
            LOCK_KEY(tenantId),
            String(process.pid),
            'PX', LOCK_TTL_MS,
            'NX'
        );
        return r === 'OK' || r === 1 || r === true;
    }

    async _releaseLock(tenantId) {
        await this.redis.del(LOCK_KEY(tenantId));
    }

    async _waitForCache(tenantId) {
        for (let i = 0; i < MAX_POLLS; i++) {
            await sleep(POLL_INTERVAL_MS);
            const e = await this._readCache(tenantId);
            if (e && this._isFresh(e)) return e.accessToken;
        }
        // Lock holder didn't write — try once more on our own (no lock to avoid deadlock loop)
        const fresh = await this._fetchAndCache(tenantId, null);
        return fresh.accessToken;
    }

    async _fetchAndCache(tenantId, previousEntry, forceAuth = false) {
        const provider = await this.providerFactory(tenantId);
        let result;

        if (!forceAuth && previousEntry && previousEntry.refreshToken && typeof provider.refresh === 'function') {
            try {
                result = await provider.refresh(previousEntry.refreshToken);
            } catch (e) {
                result = await provider.authenticate();
            }
        } else {
            result = await provider.authenticate();
        }

        const ttlSec = Math.max(60, (result.expiresIn || 7200) - SAFETY_MARGIN_SEC);
        const entry = {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken || (previousEntry && previousEntry.refreshToken) || null,
            expiresAt: Date.now() + ttlSec * 1000,
            providerName: provider.providerName || 'unknown',
            cachedAt: Date.now(),
        };
        await this.redis.setex(TOKEN_KEY(tenantId), ttlSec, JSON.stringify(entry));
        return entry;
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

module.exports = TokenManager;
