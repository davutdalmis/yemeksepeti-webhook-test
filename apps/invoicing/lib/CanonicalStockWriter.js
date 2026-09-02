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
// BİRİM (02.09.2026 düzeltmesi): sipariş kalemi kendi birimiyle gelir (ör. "1 kg"),
// stok kartı başka birimde olabilir (ör. gram). Eski yazım miktarı çevirmeden yazıp
// satırın birimini eziyordu (Maltepe Zeytin: 8.469 g + "1 kg" → 8.470 "kg").
// Artık:
//   - hedef birim = mevcut stok satırının birimi; satır yoksa inventoryProducts kart
//     birimi; o da yoksa sipariş birimi. Mevcut satırın birimi ASLA ezilmez.
//   - miktar hedef birime çevrilir (kg↔g, lt↔ml — UnitConversion).
//   - çevrilemeyen çift (adet↔g) TAHMİN EDİLMEZ: miktar olduğu gibi yazılır, hareket
//     `unitMismatch: true` ile işaretlenir; sourceQuantity/sourceUnit her zaman saklanır.
//
// İdempotency: yazımlar finalize/approve transaction'ının İÇİNDE yapılır ve o
// transaction "status zaten sent ise çık" guard'ı ile korunur → tek sefer çalışır.
//
// Acil kapatma: INVOICING_CANONICAL_STOCK_DISABLED=true (default: AÇIK).

const { Timestamp } = require('firebase-admin/firestore');
const { normalizeUnit, convertQuantity, roundQty } = require('./UnitConversion');

function canonicalStockEnabled() {
    return process.env.INVOICING_CANONICAL_STOCK_DISABLED !== 'true';
}

/**
 * Transaction ÖNCESİ hazırlık: inventoryProductId çözümlemesi + kart birimi + ref listeleri.
 * finalItems: [{productId, productName, unit, finalQuantity}] (onay sonrası kesin adetler).
 * Dönen plan null ise yazılacak bir şey yok (flag kapalı / branchId yok / adetler 0).
 *
 * Plan kalemi: { invId, name, qty, unit, cardUnit, sourceQty, sourceUnit, converted, mismatch }
 *   qty/unit     : kart birimine (yoksa sipariş birimine) çevrilmiş miktar
 *   sourceQty/Unit: siparişteki ham değer (denetim izi)
 */
async function planCanonicalStock(db, { tenantId, branchId, finalItems }) {
    if (!canonicalStockEnabled() || !branchId) return null;

    const entries = [];
    const invIdCache = new Map();
    const cardUnitCache = new Map();
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

        // Kart birimi (kanonik): inventoryProducts/{invId}.unit — yoksa null.
        if (!cardUnitCache.has(invId)) {
            const cs = await db.collection('inventoryProducts').doc(invId).get();
            const cd = cs.exists ? cs.data() : null;
            cardUnitCache.set(invId, cd && cd.unit ? normalizeUnit(cd.unit, null) : null);
        }
        const cardUnit = cardUnitCache.get(invId);
        const orderUnit = normalizeUnit(it.unit, 'adet');

        const prev = entries.find((e) => e.invId === invId);
        if (prev) {
            const c = convertQuantity(qty, orderUnit, prev.unit);
            prev.qty = roundQty(prev.qty + c.qty);
            prev.converted = prev.converted || c.converted;
            prev.mismatch = prev.mismatch || c.mismatch;
            if (prev.sourceUnit === orderUnit) prev.sourceQty = roundQty(prev.sourceQty + qty);
            else { prev.sourceQty = null; prev.sourceUnit = null; } // karışık kaynak birim — iz tutulamaz
        } else {
            const target = cardUnit || orderUnit;
            const c = convertQuantity(qty, orderUnit, target);
            entries.push({
                invId,
                name: it.productName || invId,
                qty: c.qty,
                unit: target,
                cardUnit,
                sourceQty: roundQty(qty),
                sourceUnit: orderUnit,
                converted: c.converted,
                mismatch: c.mismatch,
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

/** Mevcut satırın birimi (normalize); satır yoksa / birimi boşsa null. */
function readRowUnit(snap) {
    if (!snap || !snap.exists) return null;
    const d = snap.data() || {};
    return d.unit ? normalizeUnit(d.unit, null) : null;
}

/**
 * Plan kalemini bu satır için hedef birime çevirir.
 * Öncelik: satırın mevcut birimi > kart birimi (plan.unit) > sipariş birimi.
 */
function resolveForRow(e, snap) {
    const rowUnit = readRowUnit(snap);
    const target = rowUnit || e.unit;
    const c = convertQuantity(e.qty, e.unit, target);
    return {
        qty: c.qty,
        unit: target,
        converted: e.converted || c.converted,
        mismatch: e.mismatch || c.mismatch,
    };
}

function movementBase(e, r) {
    const m = {
        productId: e.invId,
        productName: e.name,
        unit: r.unit,
        sourceQuantity: e.sourceQty,
        sourceUnit: e.sourceUnit,
    };
    if (r.mismatch) m.unitMismatch = true;
    return m;
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
        const outSnap = snaps.outSnaps[i];
        const out = resolveForRow(e, outSnap);
        const outCurrent = readStock(outSnap);
        txn.set(plan.outRefs[i], {
            id: `${plan.imalatBranchId}_${e.invId}`,
            tenantId,
            branchId: plan.imalatBranchId,
            productId: e.invId,
            productName: e.name,
            currentStock: Math.max(0, roundQty(outCurrent - out.qty)),
            unit: out.unit,
            lastUpdated: ts,
        }, { merge: true });
        const outMoveRef = db.collection('stockMovements').doc();
        txn.set(outMoveRef, {
            id: outMoveRef.id,
            tenantId,
            branchId: plan.imalatBranchId,
            movementType: 'TRANSFER_OUT',
            ...movementBase(e, out),
            quantity: -out.qty,
            movementDate: ts,
            createdAt: ts,
            notes: `İrsaliye onayı ${sourceLabel || ''}`.trim() + (out.mismatch ? ` (birim uyuşmazlığı: ${e.sourceUnit || '?'} → ${out.unit}, çevrilmedi)` : ''),
            sourceType: 'invoice_approval',
            sourceDocumentId: sourceId,
            targetBranchId: branchId,
            createdBy: recordedBy || 'invoicing-engine',
        });

        // Hedef şube girişi
        const inSnap = snaps.inSnaps[i];
        const inn = resolveForRow(e, inSnap);
        const inCurrent = readStock(inSnap);
        txn.set(plan.inRefs[i], {
            id: `${branchId}_${e.invId}`,
            tenantId,
            branchId,
            productId: e.invId,
            productName: e.name,
            currentStock: roundQty(inCurrent + inn.qty),
            unit: inn.unit,
            lastUpdated: ts,
        }, { merge: true });
        const inMoveRef = db.collection('stockMovements').doc();
        txn.set(inMoveRef, {
            id: inMoveRef.id,
            tenantId,
            branchId,
            movementType: 'TRANSFER_IN',
            ...movementBase(e, inn),
            quantity: inn.qty,
            movementDate: ts,
            createdAt: ts,
            notes: `İrsaliye onayı ${sourceLabel || ''} - İmalattan transfer`.trim() + (inn.mismatch ? ` (birim uyuşmazlığı: ${e.sourceUnit || '?'} → ${inn.unit}, çevrilmedi)` : ''),
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
