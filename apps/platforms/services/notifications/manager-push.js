// ==================================================================================
// MANAGER PUSH - manager-android kullanıcılarına FCM bildirimi
// ==================================================================================
// OUTAGE_RESILIENCE_PLAN Faz 1 — production-domain fcm-notifier.ts deseninin JS uyarlaması.
// Token kaynağı: tenantUsers/{userId}.devices[].fcmToken
// Şube filtresi: kullanıcının branchId'si eşit VEYA boş (çoklu şube yöneticisi)
//                VEYA branches[] dizisi şubeyi içeriyor.
// Hatalar yutulur ve loglanır — bildirim kaçırmak ana akışı asla bozmamalı.

const admin = require('firebase-admin');

class ManagerPushService {
    /**
     * @param {object} db - Firestore instance
     * @param {function} [messagingFactory] - test için enjekte edilebilir admin.messaging() fabrikası
     */
    constructor(db, messagingFactory = () => admin.messaging()) {
        this.db = db;
        this.messagingFactory = messagingFactory;
    }

    /**
     * Tenant'ın (şube kapsamına giren) yöneticilerine CRITICAL tipinde push gönderir.
     * manager-android tarafında 'critical' kanalına düşer (HIGH importance + titreşim + ışık).
     *
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.branchId
     * @param {string} params.title
     * @param {string} params.body
     * @param {object} [params.extraData] - data payload'a eklenecek string alanlar
     * @returns {Promise<{sent: number, failed: number, tokenCount: number}>}
     */
    async sendCriticalAlert({ tenantId, branchId, title, body, extraData }) {
        const result = { sent: 0, failed: 0, tokenCount: 0 };
        if (!this.db || !tenantId || !branchId) return result;

        try {
            const tokens = await this.collectTokens(tenantId, branchId);
            result.tokenCount = tokens.length;
            if (tokens.length === 0) {
                console.log(`[ManagerPush] Token yok — tenant=${tenantId} branch=${branchId}`);
                return result;
            }

            const data = {
                type: 'CRITICAL',
                title: String(title || ''),
                body: String(body || ''),
                branchId: String(branchId),
                tenantId: String(tenantId)
            };
            if (extraData && typeof extraData === 'object') {
                for (const [key, value] of Object.entries(extraData)) {
                    if (value !== undefined && value !== null) data[key] = String(value);
                }
            }

            const message = {
                tokens,
                data,
                android: { priority: 'high' }
            };

            const response = await this.messagingFactory().sendEachForMulticast(message);
            result.sent = response.successCount;
            result.failed = response.failureCount;
            console.log(`[ManagerPush] Gönderildi — tenant=${tenantId} branch=${branchId} ok=${response.successCount} fail=${response.failureCount}`);
            return result;
        } catch (error) {
            // Yutulur: bildirim hatası bekçi döngüsünü/ana akışı bozmamalı
            console.warn(`[ManagerPush] Gönderim hatası (yutuldu): ${error.message}`);
            return result;
        }
    }

    /**
     * Tenant kullanıcılarından şube kapsamına girenlerin FCM token'larını toplar.
     * fcm-notifier.ts collectTokens ile birebir aynı eşleşme kuralı.
     *
     * @param {string} tenantId
     * @param {string} branchId
     * @returns {Promise<string[]>}
     */
    async collectTokens(tenantId, branchId) {
        const snap = await this.db.collection('tenantUsers')
            .where('tenantId', '==', tenantId)
            .get();

        const tokens = [];
        const seen = new Set();
        for (const doc of snap.docs) {
            const data = doc.data() || {};
            const userBranchId = data.branchId;
            const branches = data.branches;
            const matches =
                userBranchId === branchId ||
                userBranchId === undefined ||
                userBranchId === null ||
                userBranchId === '' ||
                (Array.isArray(branches) && branches.includes(branchId));
            if (!matches) continue;

            const devices = data.devices;
            if (!Array.isArray(devices)) continue;
            for (const device of devices) {
                const token = device && device.fcmToken;
                if (typeof token === 'string' && token.length > 0 && !seen.has(token)) {
                    seen.add(token);
                    tokens.push(token);
                }
            }
        }
        return tokens;
    }
}

module.exports = ManagerPushService;
