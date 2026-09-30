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
//
// SİLİNMİŞ BELGE İŞARETİ (30.09.2026, F3 bulgu 5): Paraşüt'te silinmiş 11 irsaliye Yemigo'da
// "sent" kaldı, stoğu hareket etmişti ve kapatıcı bağlı siparişi DELIVERED yaptı; `parasutSync.deleted`
// hiçbir yerde okunmuyordu. Artık silinmiş bulunan belgeye üst düzey bayrak yazılır:
//   deletedInParasut: true, deletedInParasutAt, deletedInParasutWhileStatus, deletedInParasutStockMoved
// ve ilk tespitte `integrationAuditLogs` kaydı (type SHIPMENT_DELETED_IN_PARASUT) düşülür.
// Kapatıcı (ProductionOrderCloser) ve onay (ShipmentProcessor.finalize) bu bayrağa bakar.
// STOK OTOMATİK TERS ÇEVRİLMEZ (Davut kararı bekliyor) — ters kayıt için ayrı betik gerekir.
// `status` alanına yine dokunulmaz.
// ==================================================================================

const { Timestamp } = require('firebase-admin/firestore');
const { runWithToken } = require('../auth/TokenManager');

const ACTIVE_STATUSES = ['draft', 'pending_approval', 'sent'];
const AUDIT_COLLECTION = 'integrationAuditLogs';
const AUDIT_TYPE_DELETED = 'SHIPMENT_DELETED_IN_PARASUT';

/** Belge Paraşüt'te silinmiş olarak işaretli mi (üst bayrak ya da son senkron sonucu). */
function isDeletedInParasut(doc) {
    if (!doc) return false;
    return doc.deletedInParasut === true || !!(doc.parasutSync && doc.parasutSync.deleted === true);
}

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
        // v0.4.9: 401'de token zorunlu yenilenip bir kez tekrar denenir (TokenManager.withToken).
        const status = await runWithToken(this.tokenManager, doc.tenantId,
            (token) => provider.getShipmentDocumentStatus(token, doc.parasutShipmentId));
        const now = this.now();
        const sync = { ...status, checkedAt: now };
        const update = { parasutSync: sync, updatedAt: now };
        // Resmi numara gelince ekranların kullandığı alanı da doldur (önceden hep null kalıyordu).
        if (status.despatchNo && !doc.parasutShipmentNumber) update.parasutShipmentNumber = status.despatchNo;

        const newlyDeleted = status.deleted === true && doc.deletedInParasut !== true;
        if (newlyDeleted) {
            update.deletedInParasut = true;
            update.deletedInParasutAt = now;
            update.deletedInParasutWhileStatus = doc.status || null;
            // 'sent' = onay stoğu hareket ettirmiş (TRANSFER_OUT/IN + reçete düşümü yazılmış)
            update.deletedInParasutStockMoved = doc.status === 'sent';
        } else if (status.deleted !== true && status.found === true && doc.deletedInParasut === true) {
            // Aynı belgede Paraşüt kimliği değişmiş (yeniden kesilmiş) ve bulunuyor → bayrak kalkar.
            update.deletedInParasut = false;
            update.deletedInParasutClearedAt = now;
        }
        await ref.update(update);

        if (newlyDeleted) await this._auditDeleted(docId, doc, now);
        return { docId, parasutShipmentId: String(doc.parasutShipmentId), sync, newlyDeleted };
    }

    /** İlk tespitte bir kez yazılır; yazılamazsa senkron durmaz (bayrak zaten belgede). */
    async _auditDeleted(docId, doc, now) {
        const stockMoved = doc.status === 'sent';
        try {
            await this.db.collection(AUDIT_COLLECTION).add({
                type: AUDIT_TYPE_DELETED,
                collection: 'invoiceDocuments',
                docId,
                tenantId: doc.tenantId || null,
                branchId: doc.branchId || null,
                yemigoStatus: doc.status || null,
                parasutShipmentId: doc.parasutShipmentId ? String(doc.parasutShipmentId) : null,
                sourceType: doc.sourceType || null,
                sourceId: doc.sourceId || null,
                sourceTransferNumber: doc.sourceTransferNumber || null,
                stockMoved,
                action: stockMoved
                    ? 'Stok onayda hareket etti; otomatik ters kayit YAPILMADI (karar yetkilide, ters kayit icin betik gerekir). Bagli siparis kapatilmaz.'
                    : 'Onaylanmamis belge; stok hareketi yok. Onay engellendi.',
                source: 'invoicing-engine/ShipmentStatusSync',
                createdAt: Timestamp.fromMillis(now),
                createdAtMs: now,
            });
        } catch (e) {
            this.log.warn('[shipment-sync] ' + docId + ' silinmis belge audit yazilamadi: ' + (e && e.message));
        }
        this.log.warn('[shipment-sync] ' + docId + ' (' + (doc.sourceTransferNumber || '-') + ') PARASUTTA SILINMIS, Yemigo durumu=' + doc.status + (stockMoved ? ' — stok hareket etmis, ters kayit yok' : ''));
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
        const out = { scanned: snap.size, synced: 0, skipped: 0, errors: 0, legalized: 0, deleted: 0, newlyDeleted: 0, draft: 0, items: [] };
        for (const d of snap.docs) {
            const data = d.data() || {};
            if (!data.parasutShipmentId) { out.skipped++; continue; }
            try {
                const r = await this.syncDocument(d.id, { tenantId });
                if (!r.sync) { out.skipped++; continue; }
                out.synced++;
                if (r.sync.deleted) { out.deleted++; if (r.newlyDeleted) out.newlyDeleted++; }
                else if (r.sync.legalized) out.legalized++;
                else out.draft++;
                out.items.push({
                    docId: d.id,
                    sourceTransferNumber: data.sourceTransferNumber || null,
                    yemigoStatus: data.status,
                    deleted: r.sync.deleted,
                    stockMoved: !!(r.sync.deleted && data.status === 'sent'),
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

module.exports = { ShipmentStatusSync, ACTIVE_STATUSES, isDeletedInParasut, AUDIT_TYPE_DELETED };
