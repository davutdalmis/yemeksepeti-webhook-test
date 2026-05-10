// ==================================================================================
// PRE-DISPATCH BUFFER — Plan 29 Faz 2.3
// ==================================================================================
// Sektör ilhamı: DoorDash 60-180sn buffer + Open Door Logistics meal delivery routing.
// Sipariş geldiğinde anında atama yerine kısa pencere bekler:
// - Yakında dönen kurye olabilir (capacity-aware)
// - Aynı yöne ek sipariş gelebilir (Faz 3 batching ile sinerji)
//
// Geriye uyumlu: bufferSeconds=0 (default) → buffer atlanır, eski akış devam eder.
// Branch override: branches/{id}/settings/dispatchSettings.bufferSeconds (0-180 clamp)
//
// Firestore: dispatchBuffer/{autoId}
// Status: pending → assigned | timeout (timeout=buffer süresi doldu, normal dispatchQueue'ya devret)

const admin = require('firebase-admin');

const PROCESS_INTERVAL_MS = 10 * 1000; // 10 saniye
const MAX_BUFFER_SECONDS = 180;        // 3 dakika üst sınır
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000;

class PreDispatchBuffer {
    constructor(db, smartDispatch, registry, dispatchQueue) {
        this.db = db;
        this.smartDispatch = smartDispatch;
        this.registry = registry;
        this.dispatchQueue = dispatchQueue;
        this._intervalId = null;
        this._settingsCache = new Map(); // branchId → { bufferSeconds, expiresAt }
    }

    start() {
        if (this._intervalId) return;
        console.log('[PreDispatchBuffer] Started — processing every 10s');
        this._intervalId = setInterval(() => this.processExpired(), PROCESS_INTERVAL_MS);
    }

    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }
    }

    /**
     * Şube için bufferSeconds (0-180 clamp). 5 dk cache.
     */
    async getBufferSecondsForBranch(branchId) {
        if (!this.db || !branchId) return 0;
        const cached = this._settingsCache.get(branchId);
        if (cached && Date.now() < cached.expiresAt) return cached.bufferSeconds;

        let bufferSeconds = 0;
        try {
            const doc = await this.db.doc(`branches/${branchId}/settings/dispatchSettings`).get();
            if (doc.exists) {
                const raw = doc.data().bufferSeconds;
                if (typeof raw === 'number' && raw > 0) {
                    bufferSeconds = Math.min(Math.max(0, Math.floor(raw)), MAX_BUFFER_SECONDS);
                }
            }
        } catch (err) {
            console.warn('[PreDispatchBuffer] settings read error:', err.message);
        }

        this._settingsCache.set(branchId, {
            bufferSeconds,
            expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS
        });
        return bufferSeconds;
    }

    /**
     * Sipariş geldi — buffer aktifse kuyruğa yaz, değilse direkt assignBestCourier.
     * Geriye uyumlu wrapper: caller bufferSeconds'i bilmek zorunda değil.
     *
     * @returns {Promise<{ courier?: object, buffered: boolean, deferredId?: string }>}
     */
    async enqueueOrAssign({ orderId, platformId, branchId, deliveryLocation, estimatedReadyAt }) {
        const bufferSeconds = await this.getBufferSecondsForBranch(branchId);

        if (bufferSeconds <= 0) {
            // Buffer kapalı — eski akış: direkt atama
            const courier = await this.smartDispatch.assignBestCourier(branchId, deliveryLocation, {
                orderId, estimatedReadyAt
            });
            return { courier, buffered: false };
        }

        // Buffer açık — Firestore'a yaz, processExpired toplar
        try {
            const expireAt = admin.firestore.Timestamp.fromMillis(Date.now() + bufferSeconds * 1000);
            const ref = await this.db.collection('dispatchBuffer').add({
                orderId,
                platformId,
                branchId,
                deliveryLocation: deliveryLocation || { latitude: 0, longitude: 0 },
                estimatedReadyAt: estimatedReadyAt || null,
                status: 'pending',
                bufferSeconds,
                expireAt,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[PreDispatchBuffer] Buffered ${platformId}/${orderId} (${bufferSeconds}s)`);
            return { buffered: true, deferredId: ref.id };
        } catch (err) {
            // Yazma hatası → fallback: direkt atama (mevcut işleyişi bozma)
            console.warn('[PreDispatchBuffer] write fail, fallback to direct assign:', err.message);
            const courier = await this.smartDispatch.assignBestCourier(branchId, deliveryLocation, {
                orderId, estimatedReadyAt
            });
            return { courier, buffered: false };
        }
    }

    /**
     * Süresi dolmuş buffer girişlerini işle.
     * Çalışma anı interval (10sn). Süresi dolmuşları assignBestCourier'a sürer;
     * kurye yoksa normal dispatchQueue'ya devreder.
     */
    async processExpired() {
        if (!this.db || !this.smartDispatch) return;
        try {
            const now = admin.firestore.Timestamp.now();
            const snapshot = await this.db.collection('dispatchBuffer')
                .where('status', '==', 'pending')
                .where('expireAt', '<=', now)
                .limit(20)
                .get();

            if (snapshot.empty) return;

            console.log(`[PreDispatchBuffer] Processing ${snapshot.size} expired buffer entries`);

            for (const doc of snapshot.docs) {
                const data = doc.data();
                await this._processOne(doc.ref, data);
            }
        } catch (err) {
            console.error('[PreDispatchBuffer] processExpired error:', err.message);
        }
    }

    async _processOne(docRef, data) {
        const { orderId, platformId, branchId, deliveryLocation, estimatedReadyAt } = data;
        try {
            const courier = await this.smartDispatch.assignBestCourier(branchId, deliveryLocation, {
                orderId, estimatedReadyAt, retryAttempt: 0
            });

            if (courier) {
                const connector = this.registry?.getConnector(platformId);
                if (connector) {
                    await connector.assignCourier(orderId, courier.id, courier.name);
                }
                await docRef.update({
                    status: 'assigned',
                    assignedCourierId: courier.id,
                    assignedCourierName: courier.name,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[PreDispatchBuffer] Assigned after buffer: ${courier.name} -> ${platformId}/${orderId}`);
            } else {
                // Kurye yok — normal dispatchQueue'ya devret (15sn × 30 deneme)
                await docRef.update({
                    status: 'timeout',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                if (this.dispatchQueue) {
                    await this.dispatchQueue.enqueue({
                        orderId, platformId, branchId, deliveryLocation,
                        reason: 'buffer_timeout_no_courier'
                    });
                }
                console.log(`[PreDispatchBuffer] Timeout, deferred to dispatchQueue: ${platformId}/${orderId}`);
            }
        } catch (err) {
            console.error(`[PreDispatchBuffer] _processOne error for ${orderId}:`, err.message);
        }
    }
}

module.exports = PreDispatchBuffer;
