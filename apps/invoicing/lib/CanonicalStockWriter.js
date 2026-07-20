// Plan 30 revizyonu (2026-07-20, sahip kararı) — STOK TETİĞİ = PANEL İRSALİYE ONAYI.
//
// Firma yetkilisi panelde irsaliyeyi onayladığı anda stok, KANONİK deftere yazılır:
//   branchStocks/{branchId}_{inventoryProductId}  (WPF + panel'in okuduğu anlık stok)
//   stockMovements                                 (hareket kütüğü, TRANSFER_OUT/IN)
// İmalat deposu (imalat_<tenantId>) düşer, hedef şube artar. Şube (WPF) hiçbir
// onay/stok işlemi YAPMAZ; kurye teslim motoru (FEATURE_TRANSFER_STOCK_MOVE) da
// KAPALI tutulmalıdır — tek yazıcı burasıdır (çifte sayım koruması).
//
// Stok anahtarı çözümü production-domain TransferStockEngine ile birebir aynıdır:
// productionProducts/{productId}.inventoryProductId (yoksa productId) — böylece
// hangi motor aktif olursa olsun aynı stok kartına yazılır.
//
// İdempotency: yazımlar finalize/approve transaction'ının İÇİNDE yapılır ve o
// transaction "status zaten sent ise çık" guard'ı ile korunur → tek sefer çalışır.
//
// Acil kapatma: INVOICING_CANONICAL_STOCK_DISABLED=true (default: AÇIK).

const { Timestamp } = require('firebase-admin/firestore');

function canonicalStockEnabled() {
    return process.env.INVOICING_CANONICAL_STOCK_DISABLED !== 'true';
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Transaction ÖNCESİ hazırlık: inventoryProductId çözümlemesi + ref listeleri.
 * finalItems: [{productId, productName, unit, finalQuantity}] (onay sonrası kesin adetler).
 * Dönen plan null ise yazılacak bir şey yok (flag kapalı / branchId yok / adetler 0).
 */
async function planCanonicalStock(db, { tenantId, branchId, finalItems }) {
    if (!canonicalStockEnabled() || !branchId) return null;

    const entries = [];
    const invIdCache = new Map();
    for (const it of finalItems || []) {
        const qty = Number(it.finalQuantity);
        if (!(qty > 0) || !it.productId) continue;

        let invId = invIdCache.get(it.productId);
        if (!invId) {
            const snap = await db.collection('productionProducts').doc(it.productId).get();
            const data = snap.exists ? snap.data() : null;
            invId = (data && data.inventoryProductId) || it.productId;
            invIdCache.set(it.productId, invId);
        }

        const prev = entries.find((e) => e.invId === invId);
        if (prev) {
            prev.qty = round2(prev.qty + qty);
        } else {
            entries.push({
                invId,
                qty: round2(qty),
                name: it.productName || invId,
                unit: it.unit || 'adet',
            });
        }
    }
    if (entries.length === 0) return null;

    const imalatBranchId = `imalat_${tenantId}`;
    return {
        imalatBranchId,
        entries,
        outRefs: entries.map((e) => db.collection('branchStocks').doc(`${imalatBranchId}_${e.invId}`)),
        inRefs: entries.map((e) => db.collection('branchStocks').doc(`${branchId}_${e.invId}`)),
    };
}

/** Transaction içinde plan reflerinin okunması (tüm okumalar yazmalardan önce kuralı). */
async function readCanonicalStock(txn, plan) {
    if (!plan) return null;
    const [outSnaps, inSnaps] = await Promise.all([
        Promise.all(plan.outRefs.map((r) => txn.get(r))),
        Promise.all(plan.inRefs.map((r) => txn.get(r))),
    ]);
    return { outSnaps, inSnaps };
}

function readStock(snap) {
    if (!snap || !snap.exists) return 0;
    const d = snap.data() || {};
    return Number(d.currentStock ?? 0);
}

/**
 * Transaction içinde YAZIM (okumalar readCanonicalStock ile yapılmış olmalı):
 * imalat deposu −qty (0'da clamp, TransferStockEngine paritesi), şube +qty,
 * her kalem için TRANSFER_OUT + TRANSFER_IN stockMovements.
 */
function writeCanonicalStock(db, txn, plan, snaps, { tenantId, branchId, sourceId, sourceLabel, recordedBy, tsMillis }) {
    if (!plan || !snaps) return 0;
    const ts = Timestamp.fromMillis(tsMillis);

    for (let i = 0; i < plan.entries.length; i++) {
        const e = plan.entries[i];

        // İmalat deposu düşümü
        const outCurrent = readStock(snaps.outSnaps[i]);
        txn.set(plan.outRefs[i], {
            id: `${plan.imalatBranchId}_${e.invId}`,
            tenantId,
            branchId: plan.imalatBranchId,
            productId: e.invId,
            productName: e.name,
            currentStock: Math.max(0, round2(outCurrent - e.qty)),
            unit: e.unit,
            lastUpdated: ts,
        }, { merge: true });
        const outMoveRef = db.collection('stockMovements').doc();
        txn.set(outMoveRef, {
            id: outMoveRef.id,
            tenantId,
            branchId: plan.imalatBranchId,
            movementType: 'TRANSFER_OUT',
            productId: e.invId,
            productName: e.name,
            quantity: -e.qty,
            unit: e.unit,
            movementDate: ts,
            createdAt: ts,
            notes: `İrsaliye onayı ${sourceLabel || ''}`.trim(),
            sourceType: 'invoice_approval',
            sourceDocumentId: sourceId,
            targetBranchId: branchId,
            createdBy: recordedBy || 'invoicing-engine',
        });

        // Hedef şube girişi
        const inCurrent = readStock(snaps.inSnaps[i]);
        txn.set(plan.inRefs[i], {
            id: `${branchId}_${e.invId}`,
            tenantId,
            branchId,
            productId: e.invId,
            productName: e.name,
            currentStock: round2(inCurrent + e.qty),
            unit: e.unit,
            lastUpdated: ts,
        }, { merge: true });
        const inMoveRef = db.collection('stockMovements').doc();
        txn.set(inMoveRef, {
            id: inMoveRef.id,
            tenantId,
            branchId,
            movementType: 'TRANSFER_IN',
            productId: e.invId,
            productName: e.name,
            quantity: e.qty,
            unit: e.unit,
            movementDate: ts,
            createdAt: ts,
            notes: `İrsaliye onayı ${sourceLabel || ''} - İmalattan transfer`.trim(),
            sourceType: 'invoice_approval',
            sourceDocumentId: sourceId,
            createdBy: recordedBy || 'invoicing-engine',
        });
    }
    return plan.entries.length;
}

module.exports = {
    canonicalStockEnabled,
    planCanonicalStock,
    readCanonicalStock,
    writeCanonicalStock,
};
