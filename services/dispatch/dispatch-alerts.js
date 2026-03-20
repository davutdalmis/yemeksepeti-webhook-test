// ==================================================================================
// DISPATCH ALERTS - Dispatch uyarılarını Firestore'a yaz
// ==================================================================================
// Non-fatal: uyarı hatası dispatch akışını bloklamaz

const admin = require('firebase-admin');

class DispatchAlerts {
    constructor(db) {
        this.db = db;
        // Track consecutive failures per branch
        this.consecutiveFailures = new Map(); // branchId → count
    }

    /**
     * Record a dispatch attempt and check for alert conditions
     * @param {string} branchId
     * @param {boolean} success
     */
    async recordAttempt(branchId, success) {
        if (!this.db || !branchId) return;

        try {
            if (success) {
                this.consecutiveFailures.set(branchId, 0);
            } else {
                const count = (this.consecutiveFailures.get(branchId) || 0) + 1;
                this.consecutiveFailures.set(branchId, count);

                if (count >= 5) {
                    await this._writeAlert(branchId, {
                        type: 'consecutive_failures',
                        message: `Son ${count} kurye atama denemesi başarısız oldu. Müsait kurye olmayabilir.`,
                        severity: count >= 10 ? 'error' : 'warning',
                    });
                }
            }
        } catch (error) {
            console.warn('[DispatchAlerts] recordAttempt error (non-fatal):', error.message);
        }
    }

    /**
     * Check for long-preparing orders (30+ min in PREPARING without PICKED_UP)
     * @param {string} branchId
     * @param {string} orderId
     * @param {string} status
     * @param {Date} statusSince - when the order entered PREPARING
     */
    async checkLongPreparing(branchId, orderId, status, statusSince) {
        if (!this.db || !branchId) return;
        if (status !== 'PREPARING') return;

        try {
            const elapsed = Date.now() - statusSince.getTime();
            const thirtyMinutes = 30 * 60 * 1000;

            if (elapsed >= thirtyMinutes) {
                await this._writeAlert(branchId, {
                    type: 'long_preparing',
                    message: `Sipariş ${orderId.slice(0, 12)} ${Math.round(elapsed / 60000)} dakikadır PREPARING durumunda.`,
                    severity: elapsed >= 60 * 60 * 1000 ? 'error' : 'warning',
                });
            }
        } catch (error) {
            console.warn('[DispatchAlerts] checkLongPreparing error (non-fatal):', error.message);
        }
    }

    /**
     * Check if all couriers are at capacity
     * @param {string} branchId
     * @param {Array} couriers - list of available couriers
     * @param {number} maxOrdersPerCourier - capacity threshold
     */
    async checkAllAtCapacity(branchId, couriers, maxOrdersPerCourier = 3) {
        if (!this.db || !branchId) return;
        if (!couriers || couriers.length === 0) return;

        try {
            const onDuty = couriers.filter(c => c.isOnDuty);
            if (onDuty.length === 0) {
                await this._writeAlert(branchId, {
                    type: 'no_couriers_on_duty',
                    message: 'Görevde kurye bulunmuyor. Yeni siparişler atanamayacak.',
                    severity: 'error',
                });
                return;
            }

            const allAtCapacity = onDuty.every(c => (c.activeOrderCount || 0) >= maxOrdersPerCourier);
            if (allAtCapacity) {
                await this._writeAlert(branchId, {
                    type: 'all_at_capacity',
                    message: `Tüm kuryeler (${onDuty.length}) kapasitede. Yeni atama yapılamıyor.`,
                    severity: 'warning',
                });
            }
        } catch (error) {
            console.warn('[DispatchAlerts] checkAllAtCapacity error (non-fatal):', error.message);
        }
    }

    /**
     * Write an alert to Firestore
     * Deduplicates by type within 10 minutes
     */
    async _writeAlert(branchId, alertData) {
        try {
            const notifRef = this.db.collection('branches').doc(branchId).collection('notifications');

            // Check for recent duplicate (same type within 10 min)
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
            const existing = await notifRef
                .where('category', '==', 'dispatch')
                .where('type', '==', alertData.type)
                .where('timestamp', '>', tenMinAgo)
                .limit(1)
                .get();

            if (!existing.empty) return; // Skip duplicate

            await notifRef.add({
                category: 'dispatch',
                type: alertData.type,
                message: alertData.message,
                severity: alertData.severity || 'warning',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                resolved: false,
            });

            console.log(`[DispatchAlerts] Alert written: ${alertData.type} for branch ${branchId}`);
        } catch (error) {
            console.warn('[DispatchAlerts] _writeAlert error (non-fatal):', error.message);
        }
    }
}

module.exports = DispatchAlerts;
