// ==================================================================================
// DISPATCH AUDIT — Plan 29 Faz 2.4
// ==================================================================================
// Her atama için "neden bu kuryeye gitti" kararını kalıcı kaydeder.
// Manager + geliştirici "X kuryesi neden seçildi" sorusuna 30sn'de cevap bulabilir.
//
// Sektör ilhamı: Google SRE SLO observability + DoorDash dasher dispatch transparency.
//
// Firestore: assignmentDecisions/{autoId}
// Non-fatal: audit hatası dispatch akışını bloklamaz (try/catch dış katmanda).

const admin = require('firebase-admin');

class DispatchAudit {
    constructor(db) {
        this.db = db;
    }

    /**
     * Her atama kararını kaydeder.
     * @param {object} payload
     * @param {string} payload.orderId
     * @param {string} payload.branchId
     * @param {string} payload.decidedBy - "auto" | "manual" | "buffer" | "retry"
     * @param {Array<{courierId, name, score, breakdown}>} payload.candidates - skor sıralı (en iyi 5)
     * @param {object} payload.weights
     * @param {string} payload.selectedCourierId
     * @param {boolean} payload.tieBreakerUsed
     * @param {number} payload.scoreTimeMs
     * @param {object} [payload.context] - { estimatedReadyAt, retryAttempt, bufferDelayMs, batchPolicy }
     */
    async recordDecision(payload) {
        if (!this.db || !payload || !payload.branchId) return;

        try {
            const doc = {
                orderId: payload.orderId || null,
                branchId: payload.branchId,
                decidedBy: payload.decidedBy || 'auto',
                candidates: (payload.candidates || []).slice(0, 5).map(c => ({
                    courierId: c.courierId,
                    name: c.name,
                    score: typeof c.score === 'number' ? Number(c.score.toFixed(2)) : 0,
                    breakdown: c.breakdown || {}
                })),
                weights: payload.weights || {},
                selectedCourierId: payload.selectedCourierId || null,
                tieBreakerUsed: !!payload.tieBreakerUsed,
                scoreTimeMs: payload.scoreTimeMs || 0,
                context: payload.context || {},
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Estimated values context içine — denormalize panel kolaylığı
            if (payload.context?.estimatedReadyAt) {
                doc.estimatedReadyAt = payload.context.estimatedReadyAt;
            }

            await this.db.collection('assignmentDecisions').add(doc);
        } catch (err) {
            // Non-fatal — dispatch akışını bloklamamak için sessiz
            console.warn('[DispatchAudit] recordDecision error (non-fatal):', err.message);
        }
    }

    /**
     * Şubenin son N atama kararını döndürür (panel için).
     * @param {string} branchId
     * @param {number} limit
     */
    async getRecentDecisions(branchId, limit = 50) {
        if (!this.db || !branchId) return [];
        try {
            const snap = await this.db.collection('assignmentDecisions')
                .where('branchId', '==', branchId)
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (err) {
            console.warn('[DispatchAudit] getRecentDecisions error:', err.message);
            return [];
        }
    }
}

module.exports = DispatchAudit;
