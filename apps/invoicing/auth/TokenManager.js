// ==================================================================================
// TokenManager — per-tenant Parasut access token cache, refresh, concurrent lock
// ==================================================================================
// Plan 27 1.3.
// Redis key: invoicing:parasut:tenant:{tenantId}:token  -> { accessToken, expiresAt, refreshToken, providerName }
// Lock key:  invoicing:parasut:tenant:{tenantId}:token:lock
// TTL: token.expires_in - 200 sn safety margin (~7000 sn for Parasut'in default 7200).
// Concurrent: SET ... NX PX ile lock; lock alinamazsa polling ile cache hit'i bekle.
//
// v0.4.9 (01.10.2026) — 401 TEK KAPISI: withToken(tenantId, fn)
//   Canli olay (30.09): Parasut token'i Redis'teki sure dolmadan reddetti; 401 sonrasi
//   yalniz InvoiceWorker cache'i siliyordu. Irsaliye senkronu/olusturma, onay, listener'lar
//   token'i alip 401'de hicbir sey yapmadigi icin ~2 saat boyunca her cagri 401 verdi
//   (14:18 inbox-sync -> 14:19 78/78 hata; 20:17 56 ok/24 hata; 20:47 80/80 hata).
//   Olasi neden: Parasut'un ayni kullanici+uygulama icin yeni password grant'ta eski
//   token'i iptal etmesi (inbox saglayicisi kendi grant'ini aliyordu) — kanit: log zaman
//   cizelgesi, KESIN DEGIL. Bu duzeltme o varsayima dayanmaz: token hangi sebeple
//   reddedilirse reddedilsin cagri BIR KEZ zorunlu yeniden kimlik dogrulamayla tekrarlanir.
//   Eszamanli 401'ler tek password grant uretir:
//     1) surec ici: ayni tenant icin devam eden zorunlu yenileme promise'i paylasilir;
//     2) surecler arasi: Redis kilidi + "cache'teki token reddedilenden farkliysa onu kullan";
//     3) FORCE_DEDUP_MS icinde zorunlu yenilenmis token tekrar zorlanmaz (ping-pong freni).
// ==================================================================================

const TOKEN_KEY = (tid) => `invoicing:parasut:tenant:${tid}:token`;
const LOCK_KEY = (tid) => `invoicing:parasut:tenant:${tid}:token:lock`;
const SAFETY_MARGIN_SEC = 200;
const LOCK_TTL_MS = 10000;
const POLL_INTERVAL_MS = 250;
const MAX_POLLS = 40;
// Son zorunlu yenilemeden bu kadar sure icinde gelen yeni zorunlu yenileme istegi
// yeni password grant ACMAZ; cache'teki token'i dondurur.
const FORCE_DEDUP_MS = 10000;

/** 401 mi? InvoiceProviderError.status, duz axios hatasi (response.status) ve statusCode. */
function isUnauthorizedError(err) {
    if (!err) return false;
    if (err.status === 401 || err.statusCode === 401) return true;
    return !!(err.response && err.response.status === 401);
}

class TokenManager {
    /**
     * @param {object} deps
     * @param {object} deps.redis  ioredis-uyumlu client (shared/redis-client'tan)
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     *        TenantId verilince IInvoiceProvider instance dondurur (cred decrypt + new Provider).
     */
    constructor({ redis, providerFactory, log }) {
        if (!redis) throw new Error('TokenManager: redis required');
        if (!providerFactory) throw new Error('TokenManager: providerFactory required');
        this.redis = redis;
        this.providerFactory = providerFactory;
        this.log = log || console;
        // tenantId -> devam eden zorunlu yenileme promise'i (surec ici tekillestirme)
        this._forceInflight = new Map();
    }

    /**
     * 401 TEK KAPISI. fn(token) 401 ile duserse token zorunlu yenilenir (password grant,
     * kilitli, tekillestirilmis) ve fn BIR KEZ daha cagrilir. Ikinci hata aynen yukari cikar
     * — dongu yok. err.retryUnsafe=true ise (ornegin fatura olusturulduktan SONRA gelen 401)
     * tekrar DENENMEZ; cift belge riskine girilmez.
     *
     * fn tek bir saglayici cagrisini sarmalamali (blok degil): tekrar yalniz reddedilen
     * cagriyi kapsar.
     */
    async withToken(tenantId, fn) {
        const token = await this.getValidToken(tenantId);
        try {
            return await fn(token);
        } catch (err) {
            if (!isUnauthorizedError(err) || err.retryUnsafe) throw err;
            this.log.warn(`[token] ${tenantId}: Parasut 401 — token zorunlu yenilenip cagri bir kez tekrarlaniyor`);
            const fresh = await this.refreshToken(tenantId, { rejectedToken: token });
            return await fn(fresh);
        }
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
     * Zorunlu yenileme (password grant) — 401 sonrasi. Tekillestirilmis:
     *  - ayni surecte devam eden zorunlu yenileme varsa onun sonucu paylasilir;
     *  - cache'teki taze token `rejectedToken`'dan farkliysa (baskasi zaten yeniledi) o doner;
     *  - son FORCE_DEDUP_MS icinde zorunlu yenilenmis taze token varsa o doner;
     *  - aksi halde Redis kilidi alinir; alinamazsa kilit sahibinin yazdigi token beklenir.
     * Not: eski surum once kilidi SILIYORDU (baskasinin kilidini da) — eszamanli 401'lerde
     * her cagri kendi password grant'ini aciyordu. Artik silinmiyor.
     * @param {string} tenantId
     * @param {{rejectedToken?: string|null}} [opts]
     */
    async refreshToken(tenantId, { rejectedToken = null } = {}) {
        if (!tenantId) throw new Error('tenantId required');
        const inflight = this._forceInflight.get(tenantId);
        if (inflight) return inflight;
        const p = this._forceRefresh(tenantId, rejectedToken)
            .finally(() => { this._forceInflight.delete(tenantId); });
        this._forceInflight.set(tenantId, p);
        return p;
    }

    async _forceRefresh(tenantId, rejectedToken) {
        const usable = (e) => !!e && this._isFresh(e) && (
            (!!rejectedToken && e.accessToken !== rejectedToken) ||
            (!!e.forcedAt && Date.now() - Number(e.forcedAt) < FORCE_DEDUP_MS)
        );

        const cached = await this._readCache(tenantId);
        if (usable(cached)) return cached.accessToken;

        const lockAcquired = await this._tryLock(tenantId);
        if (!lockAcquired) {
            for (let i = 0; i < MAX_POLLS; i++) {
                await sleep(POLL_INTERVAL_MS);
                const e = await this._readCache(tenantId);
                if (usable(e)) return e.accessToken;
            }
            // Kilit sahibi yeni token yazmadi (coktu / zorunlu degildi) — kilitsiz bir kez dene.
            const fresh = await this._fetchAndCache(tenantId, cached, true);
            return fresh.accessToken;
        }
        try {
            const recheck = await this._readCache(tenantId);
            if (usable(recheck)) return recheck.accessToken;
            const token = await this._fetchAndCache(tenantId, recheck || cached, true);
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
            forcedAt: forceAuth ? Date.now() : null,
        };
        await this.redis.setex(TOKEN_KEY(tenantId), ttlSec, JSON.stringify(entry));
        return entry;
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cagri noktalari icin tek giris: tokenManager.withToken varsa onu kullanir; yoksa
 * (withToken'i olmayan sahte tokenManager — testlerdeki { getValidToken } nesneleri)
 * getValidToken + fn.
 */
async function runWithToken(tokenManager, tenantId, fn) {
    if (tokenManager && typeof tokenManager.withToken === 'function') {
        return tokenManager.withToken(tenantId, fn);
    }
    return fn(await tokenManager.getValidToken(tenantId));
}

/**
 * Hata firlatmak yerine sonuc nesnesi donduren saglayici metotlari (ping, checkVknInbox)
 * 401'i { status: 401 } ile bildirir. withToken'in gorebilmesi icin burada firlatilir;
 * ikinci denemede de 401 ise cagiran `err.result` ile eski sonuc nesnesine doner.
 */
function throwIfUnauthorizedResult(result) {
    if (result && result.status === 401 && (result.ok === false || result.error)) {
        const e = new Error(result.message || (typeof result.error === 'string' ? result.error : 'unauthorized'));
        e.status = 401;
        e.result = result;
        throw e;
    }
    return result;
}

module.exports = TokenManager;
module.exports.runWithToken = runWithToken;
module.exports.isUnauthorizedError = isUnauthorizedError;
module.exports.throwIfUnauthorizedResult = throwIfUnauthorizedResult;
module.exports.FORCE_DEDUP_MS = FORCE_DEDUP_MS;
