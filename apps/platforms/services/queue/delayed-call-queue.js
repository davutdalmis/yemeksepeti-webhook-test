// ==================================================================================
// DELAYED CALL QUEUE — GetirYemek "1 dk kuralı" için server-side delayed API queue
// ==================================================================================
// RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.1 + 1.2
//
// Firestore collection: delayedApiCalls/{platform}_{orderId}_{action}
//
// Schema:
//   {
//     platform:      "GetirYemek" | ...,
//     orderId:       string,
//     branchId:      string,
//     action:        "verify" | "prepare" | "deliver" | "handover" | "cancel",
//     payload:       object,                       // optional, action'a özgü ek veri
//     scheduledAt:   Timestamp,                    // worker bu zamandan sonra alır
//     earliestAt:    Timestamp,                    // 1 dk kuralı için earliest execution time
//     status:        "pending" | "processing" | "completed" | "failed",
//     attempts:      number,                       // 0..maxAttempts
//     maxAttempts:   number,                       // default 5
//     lastError:     string?,
//     lastAttemptAt: Timestamp?,
//     createdAt:     Timestamp,
//     completedAt:   Timestamp?
//   }
//
// Doc ID deterministik: `{platform}_{orderId}_{action}` → idempotent enqueue.
// Aynı sipariş için aynı aksiyon 2x enqueue edilirse alreadyQueued=true döner.
//
// Bu sınıf SADECE Firestore CRUD + retry/backoff sağlar. Worker loop ve connector
// dispatch ayrı dosyalarda (Faz 1.3 ve 1.4):
//   - Faz 1.3: server-v4.js'te new DelayedCallQueue(db) + .start()
//   - Faz 1.4: getiryemek-connector.js'e executeAction(action, orderId, payload)
// ==================================================================================

const admin = require('firebase-admin');

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;          // 2^attempts * 30sn → 30, 60, 120, 240, 480
const CLEANUP_AGE_HOURS = 24;             // completed kayıtlar 24 saat sonra silinir
const COLLECTION = 'delayedApiCalls';
const DEFAULT_WORKER_INTERVAL_MS = 10_000;
const PROCESS_BATCH_LIMIT = 20;

const VALID_ACTIONS = ['verify', 'prepare', 'deliver', 'handover', 'cancel'];
const VALID_PLATFORMS = ['GetirYemek'];   // Faz 5.2'de YS, TG, Migros, Fuudy eklenir

class DelayedCallQueue {
    constructor(db, registry = null, metrics = null) {
        if (!db) throw new Error('[DelayedCallQueue] db handle required');
        this.db = db;
        this.registry = registry;            // PlatformRegistry (Faz 1.4'te executeAction çağrılacak)
        this.metrics = metrics;              // Optional MetricsCollector (Faz 1.6) — late-bind via setMetrics
        this._intervalId = null;             // worker setInterval handle
        this._inMemoryLocks = new Set();     // {docId} — aynı process'te paralel işlemeyi engeller
    }

    /**
     * Late-bind metrics collector (server-v4 boots queue before metrics).
     */
    setMetrics(metrics) {
        this.metrics = metrics;
    }

    _recordMetric(name, labels = {}) {
        if (!this.metrics || typeof this.metrics.increment !== 'function') return;
        try {
            this.metrics.increment(name, labels);
        } catch (e) { /* never let metrics break the queue */ }
    }

    /**
     * Start the worker loop. No-op if registry is missing (queue can still be used as a CRUD store).
     */
    start(intervalMs = DEFAULT_WORKER_INTERVAL_MS) {
        if (this._intervalId) return;
        if (!this.registry) {
            console.warn('[DelayedCallQueue] start() called without registry — worker disabled (CRUD only)');
            return;
        }
        console.log(`[DelayedCallQueue] Worker started (interval ${intervalMs}ms)`);
        this._intervalId = setInterval(() => this.processQueue(), intervalMs);
        // Kick off immediately
        this.processQueue();
    }

    /**
     * Stop the worker loop. Safe to call repeatedly.
     */
    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            console.log('[DelayedCallQueue] Worker stopped');
        }
    }

    /**
     * Scan pending entries whose scheduledAt <= now and dispatch each.
     * Idempotent — safe to call multiple times.
     */
    async processQueue() {
        if (!this.db || !this.registry) return;

        try {
            const nowTs = admin.firestore.Timestamp.now();
            const snapshot = await this.db.collection(COLLECTION)
                .where('status', '==', 'pending')
                .where('scheduledAt', '<=', nowTs)
                .orderBy('scheduledAt', 'asc')
                .limit(PROCESS_BATCH_LIMIT)
                .get();

            if (snapshot.empty) return;

            console.log(`[DelayedCallQueue] processQueue: ${snapshot.size} ready entries`);

            for (const doc of snapshot.docs) {
                await this._processOne(doc);
            }
        } catch (error) {
            console.error('[DelayedCallQueue] processQueue error:', error.message);
        }
    }

    /**
     * Process a single ready entry. If the platform connector does not yet expose
     * `executeAction(action, orderId, payload)` (Faz 1.4 not deployed), the entry is
     * left untouched (no claim, no failure) so it stays pending for later runs.
     */
    async _processOne(doc) {
        const data = doc.data();
        if (!data) return;

        const lockKey = doc.id;
        if (this._inMemoryLocks.has(lockKey)) return;

        // Connector readiness check — must happen BEFORE markProcessing so dormant
        // workers don't burn through retry attempts while Faz 1.4 is still pending.
        const platformKey = (data.platform || '').toLowerCase();
        const connector = this.registry?.getConnector?.(platformKey);
        if (!connector || typeof connector.executeAction !== 'function') {
            return;
        }

        this._inMemoryLocks.add(lockKey);
        try {
            const claimed = await this.markProcessing(doc.id);
            if (!claimed) return; // race lost or already in another state

            try {
                const enrichedPayload = { ...(data.payload || {}), branchId: data.branchId };
                await connector.executeAction(data.action, data.orderId, enrichedPayload);
                await this.markCompleted(doc.id);
                console.log(`[DelayedCallQueue] Dispatched OK: ${doc.id}`);
                this._recordMetric('delayed_call_processed_total', {
                    platform: data.platform,
                    action: data.action
                });
            } catch (error) {
                const message = error?.message || String(error);
                console.warn(`[DelayedCallQueue] Dispatch failed: ${doc.id} — ${message}`);
                const failResult = await this.markFailed(doc.id, message);
                if (failResult?.finalState === 'failed') {
                    this._recordMetric('delayed_call_failed_total', {
                        platform: data.platform,
                        action: data.action
                    });
                }
            }
        } finally {
            this._inMemoryLocks.delete(lockKey);
        }
    }

    /**
     * Build deterministic document ID for a queued call.
     */
    static buildDocId(platform, orderId, action) {
        if (!platform || !orderId || !action) {
            throw new Error('[DelayedCallQueue] platform, orderId, action required');
        }
        return `${platform}_${orderId}_${action}`;
    }

    /**
     * Enqueue a delayed API call. Idempotent: same {platform, orderId, action} returns
     * the existing queue entry without creating a duplicate.
     *
     * @param {object} args
     * @param {string} args.platform
     * @param {string} args.orderId
     * @param {string} args.branchId
     * @param {string} args.action          - verify | prepare | deliver | handover | cancel
     * @param {Date}   args.earliestAt      - earliest execution time (1 dk kuralı)
     * @param {Date}   [args.scheduledAt]   - worker pickup time (default = earliestAt)
     * @param {object} [args.payload]       - action-specific extra data
     * @param {number} [args.maxAttempts]   - default 5
     * @returns {Promise<{success, queueId, alreadyQueued, scheduledAt}>}
     */
    async enqueue({ platform, orderId, branchId, action, earliestAt, scheduledAt, payload, maxAttempts }) {
        if (!VALID_PLATFORMS.includes(platform)) {
            throw new Error(`[DelayedCallQueue] invalid platform: ${platform}`);
        }
        if (!VALID_ACTIONS.includes(action)) {
            throw new Error(`[DelayedCallQueue] invalid action: ${action}`);
        }
        if (!orderId || !branchId) {
            throw new Error('[DelayedCallQueue] orderId and branchId required');
        }
        if (!earliestAt) {
            throw new Error('[DelayedCallQueue] earliestAt required');
        }

        const docId = DelayedCallQueue.buildDocId(platform, orderId, action);
        const docRef = this.db.collection(COLLECTION).doc(docId);

        const earliestTs = admin.firestore.Timestamp.fromDate(new Date(earliestAt));
        const scheduledTs = scheduledAt
            ? admin.firestore.Timestamp.fromDate(new Date(scheduledAt))
            : earliestTs;

        try {
            const result = await this.db.runTransaction(async (tx) => {
                const snap = await tx.get(docRef);
                if (snap.exists) {
                    const existing = snap.data();
                    return {
                        alreadyQueued: true,
                        queueId: docId,
                        scheduledAt: existing.scheduledAt
                    };
                }

                tx.set(docRef, {
                    platform,
                    orderId,
                    branchId,
                    action,
                    payload: payload || {},
                    scheduledAt: scheduledTs,
                    earliestAt: earliestTs,
                    status: 'pending',
                    attempts: 0,
                    maxAttempts: maxAttempts || DEFAULT_MAX_ATTEMPTS,
                    lastError: null,
                    lastAttemptAt: null,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    completedAt: null
                });

                return { alreadyQueued: false, queueId: docId, scheduledAt: scheduledTs };
            });

            console.log(
                `[DelayedCallQueue] Enqueue ${result.alreadyQueued ? 'SKIP (existing)' : 'OK'}: ${docId}`
            );

            this._recordMetric('delayed_call_enqueue_total', {
                platform,
                action,
                already_queued: result.alreadyQueued ? 'true' : 'false'
            });

            return { success: true, ...result };
        } catch (error) {
            console.error(`[DelayedCallQueue] Enqueue error for ${docId}:`, error.message);
            return { success: false, queueId: docId, error: error.message };
        }
    }

    /**
     * Atomically transition pending → processing. Returns true if claim succeeded.
     * Returns false if doc was already in another state (race with another worker).
     */
    async markProcessing(docId) {
        const docRef = this.db.collection(COLLECTION).doc(docId);

        try {
            return await this.db.runTransaction(async (tx) => {
                const snap = await tx.get(docRef);
                if (!snap.exists) {
                    console.warn(`[DelayedCallQueue] markProcessing: doc not found ${docId}`);
                    return false;
                }
                if (snap.data().status !== 'pending') {
                    return false;
                }
                tx.update(docRef, {
                    status: 'processing',
                    lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
                });
                return true;
            });
        } catch (error) {
            console.error(`[DelayedCallQueue] markProcessing error for ${docId}:`, error.message);
            return false;
        }
    }

    /**
     * Mark a call as completed.
     */
    async markCompleted(docId) {
        const docRef = this.db.collection(COLLECTION).doc(docId);
        try {
            await docRef.update({
                status: 'completed',
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastError: null
            });
            console.log(`[DelayedCallQueue] Completed: ${docId}`);
            return true;
        } catch (error) {
            console.error(`[DelayedCallQueue] markCompleted error for ${docId}:`, error.message);
            return false;
        }
    }

    /**
     * Increment attempts and schedule next retry with exponential backoff.
     * If attempts reach maxAttempts → status = 'failed' (no further retries).
     */
    async markFailed(docId, errorMessage) {
        const docRef = this.db.collection(COLLECTION).doc(docId);

        try {
            return await this.db.runTransaction(async (tx) => {
                const snap = await tx.get(docRef);
                if (!snap.exists) {
                    console.warn(`[DelayedCallQueue] markFailed: doc not found ${docId}`);
                    return { success: false, finalState: null };
                }

                const data = snap.data();
                const newAttempts = (data.attempts || 0) + 1;
                const maxAttempts = data.maxAttempts || DEFAULT_MAX_ATTEMPTS;

                if (newAttempts >= maxAttempts) {
                    tx.update(docRef, {
                        status: 'failed',
                        attempts: newAttempts,
                        lastError: errorMessage || 'unknown',
                        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.warn(
                        `[DelayedCallQueue] FAILED (max attempts ${maxAttempts}): ${docId} — ${errorMessage}`
                    );
                    return { success: true, finalState: 'failed', attempts: newAttempts };
                }

                // Exponential backoff: 2^attempts * 30sn
                const backoffSec = Math.pow(2, newAttempts - 1) * BASE_BACKOFF_SECONDS;
                const nextScheduled = new Date(Date.now() + backoffSec * 1000);

                tx.update(docRef, {
                    status: 'pending',
                    attempts: newAttempts,
                    lastError: errorMessage || 'unknown',
                    lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
                    scheduledAt: admin.firestore.Timestamp.fromDate(nextScheduled)
                });

                console.log(
                    `[DelayedCallQueue] Retry ${newAttempts}/${maxAttempts} in ${backoffSec}s: ${docId} — ${errorMessage}`
                );

                return {
                    success: true,
                    finalState: 'pending',
                    attempts: newAttempts,
                    nextScheduledAt: nextScheduled,
                    backoffSeconds: backoffSec
                };
            });
        } catch (error) {
            console.error(`[DelayedCallQueue] markFailed error for ${docId}:`, error.message);
            return { success: false, finalState: null, error: error.message };
        }
    }

    /**
     * Delete completed entries older than CLEANUP_AGE_HOURS.
     * Should be called periodically (daily) — not blocking the worker loop.
     */
    async cleanup() {
        const cutoff = new Date(Date.now() - CLEANUP_AGE_HOURS * 60 * 60 * 1000);
        const cutoffTs = admin.firestore.Timestamp.fromDate(cutoff);

        try {
            const snapshot = await this.db.collection(COLLECTION)
                .where('status', '==', 'completed')
                .where('completedAt', '<=', cutoffTs)
                .limit(100)
                .get();

            if (snapshot.empty) {
                return { deleted: 0 };
            }

            const batch = this.db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();

            console.log(`[DelayedCallQueue] Cleanup: deleted ${snapshot.size} completed entries older than ${CLEANUP_AGE_HOURS}h`);
            return { deleted: snapshot.size };
        } catch (error) {
            console.error('[DelayedCallQueue] Cleanup error:', error.message);
            return { deleted: 0, error: error.message };
        }
    }
}

module.exports = DelayedCallQueue;
module.exports.COLLECTION = COLLECTION;
module.exports.VALID_ACTIONS = VALID_ACTIONS;
module.exports.VALID_PLATFORMS = VALID_PLATFORMS;
module.exports.DEFAULT_MAX_ATTEMPTS = DEFAULT_MAX_ATTEMPTS;
module.exports.BASE_BACKOFF_SECONDS = BASE_BACKOFF_SECONDS;
module.exports.DEFAULT_WORKER_INTERVAL_MS = DEFAULT_WORKER_INTERVAL_MS;
module.exports.PROCESS_BATCH_LIMIT = PROCESS_BATCH_LIMIT;
