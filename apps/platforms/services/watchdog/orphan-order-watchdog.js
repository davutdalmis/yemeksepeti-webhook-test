// ==================================================================================
// ORPHAN ORDER WATCHDOG - Sahipsiz sipariş bekçisi
// ==================================================================================
// OUTAGE_RESILIENCE_PLAN Faz 1 — Sipariş Firestore'a yazıldı ama şube WPF'i
// N dakikadır işlemedi (internet/elektrik kesintisi, çökme, kapalı PC — sebep fark
// etmez) → yöneticinin telefonuna (manager-android) CRITICAL push.
//
// Açılış şartları (ikisi birden):
//   - env ORPHAN_WATCHDOG_ENABLED !== 'false'  (global kill-switch, default açık)
//   - branches/{branchId}.orphanOrderAlertEnabled === true  (şube bazlı, default KAPALI)
// Eşik: branches/{branchId}.orphanOrderAlertMinutes (default 3 dk)
//
// Durum kaydı: orphanAlerts/{platform}_{orderId} — hub restart'a dayanıklı cooldown
// + Faz 2 günlük raporunun veri kaynağı.

const admin = require('firebase-admin');

const PROCESS_INTERVAL_MS = 60 * 1000;       // 60 sn'de bir tarama
const LOOKBACK_MINUTES = 30;                 // sadece son 30 dk'nın siparişleri (index gerektirmez)
const DEFAULT_THRESHOLD_MINUTES = 3;         // bu yaştan büyük NEW sipariş = aday
const REMINDER_MINUTES = 5;                  // ilk bildirimden sonra hâlâ sahipsizse 1 hatırlatma
const MAX_NOTIFY_COUNT = 2;                  // sipariş başına en fazla 2 bildirim
const HEARTBEAT_STALE_MINUTES = 5;           // cihaz 5+ dk sessizse "çevrimdışı görünüyor"
const BRANCH_CACHE_TTL_MS = 5 * 60 * 1000;   // branch doc okuma cache'i
const STATE_RETENTION_MS = 2 * 60 * 60 * 1000; // bellek durum kaydı 2 saat sonra temizlenir

// Platform-bağımsız iskelet: yeni platform eklemek = bir satır.
// Faz 1 kapsamı sadece YemekSepeti (canary sonrası genişletilecek).
const PLATFORMS = [
    { id: 'yemeksepeti', collection: 'yemekSepetiOrders', displayName: 'YemekSepeti' }
];

class OrphanOrderWatchdog {
    /**
     * @param {object} db - Firestore instance
     * @param {object} managerPush - ManagerPushService instance
     * @param {object} [options]
     * @param {Array}  [options.platforms] - test için platform listesi override
     * @param {function} [options.now] - test için saat enjeksiyonu (() => millis)
     */
    constructor(db, managerPush, options = {}) {
        this.db = db;
        this.managerPush = managerPush;
        this.platforms = options.platforms || PLATFORMS;
        this._now = options.now || (() => Date.now());
        this._intervalId = null;

        // key: `${platform}_${orderId}` → { notifyCount, firstDetectedAt, lastNotifiedAt, resolved }
        this._alerts = new Map();
        // key: branchId → { data, fetchedAt }
        this._branchCache = new Map();
    }

    start() {
        if (this._intervalId) return;
        if (process.env.ORPHAN_WATCHDOG_ENABLED === 'false') {
            console.log('[OrphanWatchdog] ORPHAN_WATCHDOG_ENABLED=false — bekçi devre dışı');
            return;
        }
        console.log(`[OrphanWatchdog] Başladı — ${PROCESS_INTERVAL_MS / 1000} sn'de bir tarama, platformlar: ${this.platforms.map(p => p.id).join(',')}`);
        this._intervalId = setInterval(() => this.processCycle(), PROCESS_INTERVAL_MS);
        this.processCycle();
    }

    stop() {
        if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
            console.log('[OrphanWatchdog] Durduruldu');
        }
    }

    /**
     * Tek tarama döngüsü. Hata izolasyonu: platform/sipariş hatası diğerlerini engellemez.
     */
    async processCycle() {
        if (!this.db) return;

        for (const platform of this.platforms) {
            try {
                await this._processPlatform(platform);
            } catch (error) {
                console.error(`[OrphanWatchdog] ${platform.id} tarama hatası:`, error.message);
            }
        }

        this._pruneState();
    }

    async _processPlatform(platform) {
        const nowMs = this._now();
        const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - LOOKBACK_MINUTES * 60 * 1000);

        const snapshot = await this.db.collection(platform.collection)
            .where('CreatedAt', '>=', cutoff)
            .get();

        if (snapshot.empty) return;

        for (const doc of snapshot.docs) {
            try {
                await this._processOrder(platform, doc.id, doc.data() || {}, nowMs);
            } catch (error) {
                console.error(`[OrphanWatchdog] ${platform.id}/${doc.id} işleme hatası:`, error.message);
            }
        }
    }

    async _processOrder(platform, orderId, order, nowMs) {
        const key = `${platform.id}_${orderId}`;
        const state = this._alerts.get(key);

        const isOrphan =
            order.Status === 'NEW' &&
            order.IsCancelled !== true &&
            order.IsAccepted !== true &&
            !order.assignedCourierId;

        // Daha önce alarm verilmiş sipariş artık işlenmişse → çözüldü olarak işaretle
        if (!isOrphan) {
            if (state && !state.resolved) {
                state.resolved = true;
                await this._writeAlertDoc(key, {
                    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
                    resolvedStatus: order.Status || 'UNKNOWN'
                });
                console.log(`[OrphanWatchdog] Çözüldü: ${key} (Status=${order.Status})`);
            }
            return;
        }

        const branchId = order.branchId;
        if (!branchId) return;

        const branch = await this._getBranchInfo(branchId);
        if (!branch || branch.orphanOrderAlertEnabled !== true) return; // şube bazlı flag, default KAPALI

        const thresholdMinutes = this._thresholdMinutes(branch);
        const createdMs = this._toMillis(order.CreatedAt);
        if (createdMs === null) return;

        const ageMinutes = (nowMs - createdMs) / 60000;
        if (ageMinutes < thresholdMinutes) return;

        // Cooldown: ilk bildirim + REMINDER_MINUTES sonra hâlâ sahipsizse 1 hatırlatma, sonrası asla
        if (state) {
            if (state.notifyCount >= MAX_NOTIFY_COUNT) return;
            if (nowMs - state.lastNotifiedAt < REMINDER_MINUTES * 60 * 1000) return;
        }

        const deviceFresh = await this._isDeviceFresh(branchId, nowMs);
        const notifyCount = (state ? state.notifyCount : 0) + 1;
        const orderCode = order.ShortCode || order.Code || order.PlatformOrderId || orderId;
        const branchName = branch.branchName || branchId;
        const deviceText = deviceFresh
            ? 'cihaz açık ama siparişi işlemiyor'
            : 'şube cihazı ÇEVRİMDIŞI görünüyor';
        const prefix = notifyCount > 1 ? 'HATIRLATMA — ' : '';

        const pushResult = await this.managerPush.sendCriticalAlert({
            tenantId: branch.tenantId,
            branchId,
            title: `⚠️ Sahipsiz ${platform.displayName} siparişi!`,
            body: `${prefix}${branchName}: #${orderCode} siparişi ${Math.floor(ageMinutes)} dk'dır işlenmedi — ${deviceText}. ${platform.displayName} panelinden onaylayın veya şubeyi arayın.`,
            extraData: { platform: platform.id, orderId, orderCode }
        });

        const newState = {
            notifyCount,
            firstDetectedAt: state ? state.firstDetectedAt : nowMs,
            lastNotifiedAt: nowMs,
            resolved: false
        };
        this._alerts.set(key, newState);

        await this._writeAlertDoc(key, {
            branchId,
            platform: platform.id,
            orderId,
            orderCode: String(orderCode),
            notifyCount,
            deviceFresh,
            tokenCount: pushResult.tokenCount,
            sentCount: pushResult.sent,
            lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...(notifyCount === 1 ? { firstDetectedAt: admin.firestore.FieldValue.serverTimestamp() } : {})
        });

        console.warn(`[OrphanWatchdog] ALARM #${notifyCount}: ${key} branch=${branchId} yaş=${Math.floor(ageMinutes)}dk deviceFresh=${deviceFresh} push=${pushResult.sent}/${pushResult.tokenCount}`);
    }

    _thresholdMinutes(branch) {
        const value = Number(branch.orphanOrderAlertMinutes);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD_MINUTES;
    }

    /**
     * branches/{branchId} dokümanını okur (5 dk cache).
     * Döner: { orphanOrderAlertEnabled, orphanOrderAlertMinutes, tenantId, branchName } | null
     */
    async _getBranchInfo(branchId) {
        const cached = this._branchCache.get(branchId);
        if (cached && this._now() - cached.fetchedAt < BRANCH_CACHE_TTL_MS) {
            return cached.data;
        }

        try {
            const doc = await this.db.collection('branches').doc(branchId).get();
            const raw = doc.exists ? (doc.data() || {}) : null;
            const data = raw ? {
                orphanOrderAlertEnabled: raw.orphanOrderAlertEnabled === true,
                orphanOrderAlertMinutes: raw.orphanOrderAlertMinutes,
                tenantId: raw.tenantId || null,
                branchName: raw.branchName || raw.name || null
            } : null;
            this._branchCache.set(branchId, { data, fetchedAt: this._now() });
            return data;
        } catch (error) {
            console.warn(`[OrphanWatchdog] Branch okuma hatası ${branchId}:`, error.message);
            return cached ? cached.data : null;
        }
    }

    /**
     * branches/{branchId}/devices alt koleksiyonundaki en taze lastSeenAt'e bakar.
     * 5 dk içinde nabız varsa cihaz "taze" kabul edilir. Okuma hatasında false
     * (çevrimdışı varsay) — bildirim yine gider, sadece mesaj metni değişir.
     */
    async _isDeviceFresh(branchId, nowMs) {
        try {
            const snap = await this.db.collection('branches').doc(branchId)
                .collection('devices').get();
            let freshest = null;
            for (const doc of snap.docs) {
                const lastSeen = this._toMillis((doc.data() || {}).lastSeenAt);
                if (lastSeen !== null && (freshest === null || lastSeen > freshest)) {
                    freshest = lastSeen;
                }
            }
            if (freshest === null) return false;
            return nowMs - freshest < HEARTBEAT_STALE_MINUTES * 60 * 1000;
        } catch (error) {
            console.warn(`[OrphanWatchdog] Heartbeat okuma hatası ${branchId}:`, error.message);
            return false;
        }
    }

    async _writeAlertDoc(key, fields) {
        try {
            await this.db.collection('orphanAlerts').doc(key).set(fields, { merge: true });
        } catch (error) {
            console.warn(`[OrphanWatchdog] orphanAlerts yazma hatası ${key}:`, error.message);
        }
    }

    /**
     * Firestore Timestamp / Date / ISO string / millis → millis. Bilinmiyorsa null.
     */
    _toMillis(value) {
        if (value === undefined || value === null) return null;
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (value instanceof Date) return value.getTime();
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
    }

    _pruneState() {
        const nowMs = this._now();
        for (const [key, state] of this._alerts) {
            if (nowMs - state.firstDetectedAt > STATE_RETENTION_MS) {
                this._alerts.delete(key);
            }
        }
        for (const [branchId, entry] of this._branchCache) {
            if (nowMs - entry.fetchedAt > BRANCH_CACHE_TTL_MS * 2) {
                this._branchCache.delete(branchId);
            }
        }
    }
}

module.exports = OrphanOrderWatchdog;
