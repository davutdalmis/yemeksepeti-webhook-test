// ==================================================================================
// ShipmentStatusSync — Paraşüt'teki GERÇEK irsaliye durumunu Yemigo'ya çeker (04.09.2026)
// ==================================================================================
// TEŞHİS (canlı, Bafetto 04.09.2026): Yemigo `invoiceDocuments` 24 irsaliyeyi "sent" /
// "pending_approval" gösteriyordu. Paraşüt'ten tek tek sorgulandı: 12'si resmileşmiş e-İrsaliye
// (BR0…/BR1… numaralı, ETTN'li), 4'ü hâlâ taslak, 8'i Paraşüt panelinden SİLİNMİŞ. Yemigo
// bunların hiçbirini bilmiyordu; panel silinmiş belgeye "Hazır" rozeti ve çalışmayan bir PDF
// linki gösteriyordu. Resmileştirme adımı (plaka + şoför + "Resmileştir") bugün Paraşüt
// panelinde elle yapılıyor, Yemigo'ya geri yazılmıyor.
//
// Bu servis `parasutSync` alanını yazar: { checkedAt, deleted, legalized, despatchNo, uuid,
// legalizedAt, eStatus, vehiclePlate, driverName, ... }. Panel rozetleri ve PDF düğmesi bu
// alana bakar. Yemigo `status` alanına DOKUNMAZ — Yemigo'nun iç akışı (stok, onay) ayrıdır;
// Paraşüt'te silinmiş belgenin ne yapılacağı yetkilinin kararıdır.
// ==================================================================================

const ACTIVE_STATUSES = ['draft', 'pending_approval', 'sent'];

class ShipmentStatusSync {
    /**
     * @param {object} deps
     * @param {FirebaseFirestore.Firestore} deps.db
     * @param {object} deps.tokenManager   getValidToken(tenantId)
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     * @param {object} [deps.log]
     * @param {() => number} [deps.now]
     */
    constructor({ db, tokenManager, providerFactory, log = console, now = Date.now }) {
        if (!db) throw new Error('ShipmentStatusSync: db required');
        if (!tokenManager) throw new Error('ShipmentStatusSync: tokenManager required');
        if (!providerFactory) throw new Error('ShipmentStatusSync: providerFactory required');
        this.db = db;
        this.tokenManager = tokenManager;
        this.providerFactory = providerFactory;
        this.log = log;
        this.now = now;
    }

    /**
     * Tek belgeyi Paraşüt'ten sorgular ve `parasutSync` alanını yazar.
     * @returns {Promise<{docId:string, parasutShipmentId:string|null, sync:object|null, skipped?:string}>}
     */
    async syncDocument(docId, { tenantId } = {}) {
        const ref = this.db.collection('invoiceDocuments').doc(docId);
        const snap = await ref.get();
        if (!snap.exists) {
            const e = new Error(`invoiceDocument not found: ${docId}`);
            e.code = 'document_not_found';
            e.status = 404;
            throw e;
        }
        const doc = snap.data() || {};
        if (tenantId && doc.tenantId !== tenantId) {
            // Kiracı sınırı: başka firmanın belgesi 404 gibi davranır (bilgi sızdırmaz).
            const e = new Error(`invoiceDocument not found: ${docId}`);
            e.code = 'document_not_found';
            e.status = 404;
            throw e;
        }
        if (doc.documentKind !== 'shipment') {
            return { docId, parasutShipmentId: null, sync: null, skipped: 'not_shipment' };
        }
        if (!doc.parasutShipmentId) {
            return { docId, parasutShipmentId: null, sync: null, skipped: 'no_parasut_document' };
        }
        const provider = await this.providerFactory(doc.tenantId);
        const token = await this.tokenManager.getValidToken(doc.tenantId);
        const status = await provider.getShipmentDocumentStatus(token, doc.parasutShipmentId);
        const sync = { ...status, checkedAt: this.now() };
        const update = { parasutSync: sync, updatedAt: this.now() };
        // Resmi numara gelince ekranların kullandığı alanı da doldur (önceden hep null kalıyordu).
        if (status.despatchNo && !doc.parasutShipmentNumber) update.parasutShipmentNumber = status.despatchNo;
        await ref.update(update);
        return { docId, parasutShipmentId: String(doc.parasutShipmentId), sync };
    }

    /**
     * Firmanın aktif (draft / pending_approval / sent) irsaliyelerini tarar.
     * Paraşüt hız sınırı (10 istek / 10 sn) provider içindeki rateLimiter ile korunur; sıralı gider.
     * @returns {Promise<{scanned:number, synced:number, skipped:number, errors:number, legalized:number, deleted:number, draft:number, items:Array}>}
     */
    async syncTenant(tenantId, { limit = 200 } = {}) {
        if (!tenantId) throw new Error('ShipmentStatusSync.syncTenant: tenantId required');
        const snap = await this.db.collection('invoiceDocuments')
            .where('tenantId', '==', tenantId)
            .where('documentKind', '==', 'shipment')
            .where('status', 'in', ACTIVE_STATUSES)
            .limit(limit)
            .get();
        const out = { scanned: snap.size, synced: 0, skipped: 0, errors: 0, legalized: 0, deleted: 0, draft: 0, items: [] };
        for (const d of snap.docs) {
            const data = d.data() || {};
            if (!data.parasutShipmentId) { out.skipped++; continue; }
            try {
                const r = await this.syncDocument(d.id, { tenantId });
                if (!r.sync) { out.skipped++; continue; }
                out.synced++;
                if (r.sync.deleted) out.deleted++;
                else if (r.sync.legalized) out.legalized++;
                else out.draft++;
                out.items.push({
                    docId: d.id,
                    sourceTransferNumber: data.sourceTransferNumber || null,
                    yemigoStatus: data.status,
                    deleted: r.sync.deleted,
                    legalized: r.sync.legalized,
                    despatchNo: r.sync.despatchNo,
                });
            } catch (e) {
                out.errors++;
                this.log.warn('[shipment-sync] ' + d.id + ' senkron hatasi: ' + (e && e.message));
            }
        }
        return out;
    }
}

module.exports = { ShipmentStatusSync, ACTIVE_STATUSES };
