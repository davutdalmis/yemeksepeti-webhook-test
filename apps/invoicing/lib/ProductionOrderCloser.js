// ==================================================================================
// ProductionOrderCloser — irsaliyesi kesilen imalat siparisini kapatir (31.08.2026)
// ==================================================================================
// SORUN (canli teshis, Bafetto): WPF'ten gelen siparis icin ProductionOrderListener
// aninda irsaliye taslagi aciyor (Plan 29). Yetkili panelden onayliyor; onay stogu
// hareket ettiriyor (Plan 30) ama siparisin `status` alanina HIC dokunmuyordu.
// Sonuc: siparis PENDING/version=0 olarak kaliyor, imalat-web "Bugun" sayfasinda
// birikiyordu. 31.08 olcumu: 70 aktif siparisin 70'inin de irsaliyesi kesilmisti,
// 67'si version=0 idi (kimse "Uretime Al"a basmamisti), en eskisi 15 Temmuz'dandi.
//
// NEDEN ONAY ANINDA DEGIL, GECIKMELI:
// Kapatmayi finalize()'in icine koymak ilk akla gelen cozumdu ama canli veri buna
// izin vermedi. Gercek yetkilinin onay saatleri (test hesabi ayiklandiktan sonra):
//   Kartal    28.07 18:14 siparis -> 28.07 18:35 onay
//   Fikirtepe 28.07 21:29 siparis -> 29.07 10:46 onay
//   Kartal    25.08 18:16 siparis -> 26.08 11:18 onay
//   Fikirtepe 25.08 21:23 siparis -> 26.08 11:18 onay
// Yani siparis aksam giriliyor, onay ERTESI SABAH ~11:00'de veriliyor — uretim daha
// yapilmadan. Onay aninda kapatsaydik is, imalatin ekranindan gun ortasinda kaybolur,
// hic uretilmeden "teslim edildi" gorunurdu. Bugunku hatadan (FAZLA is gorunuyor)
// daha kotusu olurdu: EKSIK is gorunurdu.
//
// COZUM: onaydan MIN_AGE_HOURS (18 saat) sonra kapat. Zamanlayici server.js'te.
//   onay 11:00 -> kapanis ertesi gun 05:00  (imalat tum gun gorur)
//   onay 23:00 -> kapanis ertesi gun 17:00  (imalat tum mesai gorur)
// 18 saat, hangi saatte onaylanirsa onaylansin siparisin en az bir tam calisma gunu
// ekranda kalmasini garanti eder.
//
// Durum makinesi (production-domain: PENDING->APPROVED->IN_PROGRESS->READY->SHIPPED
// ->DELIVERED, kisayol yok) burada ACIKCA kisa devre yapiliyor ve iz birakiliyor:
//   - productionOrderEvents'e STATUS_CHANGED (reason: 'irsaliye_onayi')
//   - siparise closedByShipmentDocumentId
// Boylece "bu siparis neden PENDING'den DELIVERED'a atladi" veriden yanitlanir.
// ==================================================================================

const { Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');

const ORDERS_COLLECTION = 'productionOrders';
const EVENTS_COLLECTION = 'productionOrderEvents';
const DOCS_COLLECTION = 'invoiceDocuments';

/** production-domain ile ayni aktif kume. */
const ACTIVE = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'READY'];
/** Kapanmis siparise dokunulmaz. */
const TERMINAL = new Set(['DELIVERED', 'CANCELLED']);
/** Onaydan sonra siparisin ekranda kalacagi asgari sure. Gerekce yukarida. */
const MIN_AGE_HOURS = 18;

/** Firestore Timestamp / ms / ISO -> ms */
function toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}

/**
 * Tek siparisi kapatir. KENDI transaction'ini acar.
 * @returns {'closed'|'skipped_missing'|'skipped_terminal'|'skipped_tenant'}
 */
async function closeOrder(db, { orderId, tenantId, documentId, sourceLabel, approvedBy, tsMillis }) {
    const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
    return db.runTransaction(async (txn) => {
        const snap = await txn.get(orderRef);
        if (!snap.exists) return 'skipped_missing';
        const cur = snap.data() || {};
        // Kiraci guard'i: baska firmanin siparisiyse DOKUNMA.
        if (cur.tenantId && cur.tenantId !== tenantId) return 'skipped_tenant';
        if (TERMINAL.has(cur.status)) return 'skipped_terminal';

        const ts = Timestamp.fromMillis(tsMillis);
        const fromStatus = cur.status || 'PENDING';
        const fromVersion = Number(cur.version || 0);
        const toVersion = fromVersion + 1;

        const patch = {
            status: 'DELIVERED',
            version: toVersion,
            updatedAt: ts,
            closedByShipmentDocumentId: documentId,
            closedByShipmentAt: ts,
        };
        // production-domain stampLifecycle ile ayni: DELIVERED yalniz actualDeliveryDate
        // damgalar ve varsa uzerine YAZMAZ.
        if (!cur.actualDeliveryDate) patch.actualDeliveryDate = ts;
        txn.update(orderRef, patch);

        const eventId = crypto.randomUUID();
        txn.set(db.collection(EVENTS_COLLECTION).doc(eventId), {
            id: eventId,
            orderId,
            tenantId,
            branchId: cur.branchId || null,
            eventType: 'STATUS_CHANGED',
            payload: {
                fromStatus,
                toStatus: 'DELIVERED',
                reason: 'irsaliye_onayi',
                shipmentDocumentId: documentId,
                shipmentNumber: sourceLabel || null,
            },
            actorUserId: approvedBy || null,
            actorChannel: 'panel',
            fromVersion,
            toVersion,
            createdAt: ts,
        });
        return 'closed';
    });
}

/**
 * Bir tur: irsaliyesi ONAYLANMIS (status='sent') ve onayi MIN_AGE_HOURS'tan eski olan
 * aktif siparisleri kapatir.
 *
 * GUVENLIK SINIRI: yalniz `status='sent'` irsaliyeler sayilir. Taslak / onay bekleyen /
 * IPTAL edilmis irsaliye siparisi KAPATMAZ — iptal edilmis irsaliye "mal cikti" demek
 * degildir (26.08'de 58 taslak toplu iptal edilmisti, onlar kapanmamali).
 *
 * @returns {{scanned:number, closed:number, skipped:number, errors:number}}
 */
async function runCloseCycle(db, { now = Date.now(), limit = 300, log = console } = {}) {
    const sonuc = { scanned: 0, closed: 0, skipped: 0, errors: 0 };
    const esik = now - MIN_AGE_HOURS * 60 * 60 * 1000;

    // Tek alan sorgusu (`in`) — bilesik index gerektirmez.
    const snap = await db.collection(ORDERS_COLLECTION).where('status', 'in', ACTIVE).limit(limit).get();
    sonuc.scanned = snap.size;

    for (const d of snap.docs) {
        const order = d.data() || {};
        const docId = order.parasutShipmentDocumentId;
        if (!docId || !order.tenantId) { sonuc.skipped++; continue; }
        try {
            const inv = await db.collection(DOCS_COLLECTION).doc(docId).get();
            if (!inv.exists) { sonuc.skipped++; continue; }
            const doc = inv.data() || {};
            if (doc.tenantId !== order.tenantId) { sonuc.skipped++; continue; }
            if (doc.documentKind !== 'shipment' || doc.status !== 'sent') { sonuc.skipped++; continue; }

            const onay = toMs(doc.approvalMeta && doc.approvalMeta.approvedAt);
            if (onay === null || onay > esik) { sonuc.skipped++; continue; }

            const r = await closeOrder(db, {
                orderId: d.id,
                tenantId: order.tenantId,
                documentId: docId,
                sourceLabel: doc.sourceTransferNumber || doc.parasutShipmentNumber || '',
                approvedBy: (doc.approvalMeta && doc.approvalMeta.approvedBy) || null,
                tsMillis: now,
            });
            if (r === 'closed') {
                sonuc.closed++;
                log.log('[order-close] ' + (order.orderNumber || d.id) + ' (' + (order.branchName || order.branchId) + ') -> DELIVERED, irsaliye ' + docId);
            } else {
                sonuc.skipped++;
            }
        } catch (e) {
            sonuc.errors++;
            log.warn('[order-close] ' + d.id + ' kapatilamadi: ' + e.message);
        }
    }
    return sonuc;
}

module.exports = { closeOrder, runCloseCycle, MIN_AGE_HOURS, ACTIVE };
