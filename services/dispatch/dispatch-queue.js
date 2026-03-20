// ==================================================================================
// DISPATCH QUEUE - Kurye atanamayan siparişler için retry kuyruğu
// ==================================================================================
// Firestore: pendingDispatches/{autoId}
// Status: pending → assigned | failed

const admin = require('firebase-admin');

const MAX_ATTEMPTS = 5;
const PROCESS_INTERVAL_MS = 30 * 1000; // 30 seconds

class DispatchQueue {
    constructor(db, smartDispatch, registry, dispatchMetrics) {
        this.db = db;
        this.smartDispatch = smartDispatch;
        this.registry = registry;
        this.dispatchMetrics = dispatchMetrics;
        this._intervalId = null;
    }

    /**
     * Start processing the queue on an interval
     */
    start() {
        if (this._intervalId) return;

        console.log('[DispatchQueue] Started — processing every 30s');
        this._intervalId = setInterval(() => this.processQueue(), PROCESS_INTERVAL_MS);

        // Process once immediately on start
        this.processQueue();
    }

    /**
     * Stop processing
     */
    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            console.log('[DispatchQueue] Stopped');
        }
    }

    /**
     * Enqueue a failed dispatch for retry
     * @param {object} params
     * @param {string} params.orderId
     * @param {string} params.platformId
     * @param {string} params.branchId
     * @param {object} params.deliveryLocation - { latitude, longitude }
     * @param {string} [params.reason] - why initial dispatch failed
     */
    async enqueue({ orderId, platformId, branchId, deliveryLocation, reason }) {
        if (!this.db) return;

        try {
            // Check if already in queue
            const existing = await this.db.collection('pendingDispatches')
                .where('orderId', '==', orderId)
                .where('status', '==', 'pending')
                .limit(1)
                .get();

            if (!existing.empty) {
                console.log(`[DispatchQueue] Order ${orderId} already in queue — skipping`);
                return;
            }

            await this.db.collection('pendingDispatches').add({
                orderId,
                platformId,
                branchId,
                deliveryLocation: deliveryLocation || { latitude: 0, longitude: 0 },
                status: 'pending',
                attempts: 0,
                reason: reason || 'no_courier_available',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log(`[DispatchQueue] Enqueued: ${platformId}/${orderId} (branch: ${branchId})`);
        } catch (error) {
            console.error('[DispatchQueue] Enqueue error:', error.message);
        }
    }

    /**
     * Mark a pending dispatch as assigned (called externally if needed)
     */
    async markAssigned(orderId) {
        if (!this.db) return;

        try {
            const snapshot = await this.db.collection('pendingDispatches')
                .where('orderId', '==', orderId)
                .where('status', '==', 'pending')
                .get();

            const batch = this.db.batch();
            snapshot.docs.forEach(doc => {
                batch.update(doc.ref, {
                    status: 'assigned',
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
            await batch.commit();
        } catch (error) {
            console.error('[DispatchQueue] markAssigned error:', error.message);
        }
    }

    /**
     * Process pending dispatches — called on interval
     */
    async processQueue() {
        if (!this.db || !this.smartDispatch) return;

        try {
            const snapshot = await this.db.collection('pendingDispatches')
                .where('status', '==', 'pending')
                .orderBy('createdAt', 'asc')
                .limit(20)
                .get();

            if (snapshot.empty) return;

            console.log(`[DispatchQueue] Processing ${snapshot.size} pending dispatch(es)`);

            for (const doc of snapshot.docs) {
                const data = doc.data();
                await this._processOne(doc.ref, data);
            }
        } catch (error) {
            console.error('[DispatchQueue] processQueue error:', error.message);
        }
    }

    /**
     * Process a single pending dispatch
     */
    async _processOne(docRef, data) {
        const { orderId, platformId, branchId, deliveryLocation, attempts } = data;

        // Max attempts reached → mark failed
        if (attempts >= MAX_ATTEMPTS) {
            await docRef.update({
                status: 'failed',
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                failReason: `max_attempts_reached (${MAX_ATTEMPTS})`
            });
            console.warn(`[DispatchQueue] FAILED after ${MAX_ATTEMPTS} attempts: ${platformId}/${orderId}`);

            if (this.dispatchMetrics) {
                await this.dispatchMetrics.recordRetry(branchId, attempts, false);
            }
            return;
        }

        // Increment attempt counter
        await this._incrementAttempt(docRef);

        try {
            // Try to assign
            const courier = await this.smartDispatch.assignBestCourier(branchId, deliveryLocation);

            if (!courier) {
                console.log(`[DispatchQueue] Attempt ${attempts + 1}/${MAX_ATTEMPTS}: No courier for ${platformId}/${orderId}`);
                return; // Will retry next interval
            }

            // Found a courier — assign via connector
            const connector = this.registry.getConnector(platformId);
            if (!connector) {
                console.error(`[DispatchQueue] Connector not found: ${platformId}`);
                return;
            }

            const result = await connector.assignCourier(orderId, courier.id, courier.name);

            if (result.success) {
                await docRef.update({
                    status: 'assigned',
                    assignedCourierId: courier.id,
                    assignedCourierName: courier.name,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`[DispatchQueue] Assigned on retry: ${courier.name} -> ${platformId}/${orderId}`);

                if (this.dispatchMetrics) {
                    await this.dispatchMetrics.recordRetry(branchId, attempts + 1, true);
                }
            } else {
                console.log(`[DispatchQueue] Assignment failed: ${result.reason} — will retry`);
            }
        } catch (error) {
            console.error(`[DispatchQueue] Process error for ${orderId}:`, error.message);
        }
    }

    /**
     * Increment the attempt counter on a pending dispatch doc
     */
    async _incrementAttempt(docRef) {
        try {
            await docRef.update({
                attempts: admin.firestore.FieldValue.increment(1),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.warn('[DispatchQueue] Increment attempt error:', error.message);
        }
    }
}

module.exports = DispatchQueue;
