// ==================================================================================
// DISPATCH METRICS - Atama metriklerini topla ve Firestore'a yaz
// ==================================================================================
// Non-fatal: metrik hatası dispatch akışını bloklamaz

const admin = require('firebase-admin');

class DispatchMetrics {
    constructor(db) {
        this.db = db;
    }

    /**
     * Record a dispatch assignment attempt
     * @param {string} branchId
     * @param {string|null} courierId - null if no courier found
     * @param {number} scoreTimeMs - time spent scoring couriers
     * @param {boolean} success - whether assignment succeeded
     * @param {object} [extra] - additional data (reason, score, etc.)
     */
    async recordAssignment(branchId, courierId, scoreTimeMs, success, extra = {}) {
        if (!this.db || !branchId) return;

        try {
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
            const hour = now.getHours();
            const docId = `${branchId}_${dateStr}`;

            const updateData = {
                branchId,
                date: dateStr,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                totalAssignments: admin.firestore.FieldValue.increment(1),
                totalScoreTimeMs: admin.firestore.FieldValue.increment(scoreTimeMs),
                [`hourlyBreakdown.h${hour}`]: admin.firestore.FieldValue.increment(1)
            };

            if (success) {
                updateData.successCount = admin.firestore.FieldValue.increment(1);
            } else {
                updateData.failCount = admin.firestore.FieldValue.increment(1);
            }

            // Track courier distribution (only for successful assignments)
            if (success && courierId) {
                updateData[`courierDistribution.${courierId}`] = admin.firestore.FieldValue.increment(1);
            }

            // Plan 29 Faz 1.4 — Pilot Mod sayaçları
            if (extra.tieBreakerUsed === true) {
                updateData.tieBreakerCount = admin.firestore.FieldValue.increment(1);
            }
            if (success && typeof extra.recencyScore === 'number' && extra.recencyScore > 0) {
                updateData.recencyPenalizedCount = admin.firestore.FieldValue.increment(1);
            }

            await this.db.collection('dispatchMetrics').doc(docId).set(updateData, { merge: true });

        } catch (error) {
            // Non-fatal: never block dispatch flow
            console.warn('[DispatchMetrics] Record error (non-fatal):', error.message);
        }
    }

    /**
     * Record a retry queue event
     */
    async recordRetry(branchId, attempt, success) {
        if (!this.db || !branchId) return;

        try {
            const dateStr = new Date().toISOString().split('T')[0];
            const docId = `${branchId}_${dateStr}`;

            const updateData = {
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                totalRetries: admin.firestore.FieldValue.increment(1)
            };

            if (success) {
                updateData.retrySuccessCount = admin.firestore.FieldValue.increment(1);
            } else {
                updateData.retryFailCount = admin.firestore.FieldValue.increment(1);
            }

            await this.db.collection('dispatchMetrics').doc(docId).set(updateData, { merge: true });
        } catch (error) {
            console.warn('[DispatchMetrics] Retry record error (non-fatal):', error.message);
        }
    }
}

module.exports = DispatchMetrics;
