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
// BİRİM (02.09.2026): sipariş kalemi kendi birimiyle gelir (ör. "1 kg"), stok kartı başka
// birimde olabilir (gram). Hedef birim = mevcut satırın birimi > inventoryProducts kart
// birimi > sipariş birimi; mevcut satırın birimi ASLA ezilmez; miktar hedef birime çevrilir
// (kg↔g, lt↔ml — UnitConversion). Çevrilemeyen çift (adet↔g) TAHMİN EDİLMEZ: miktar aynen
// yazılır, hareket `unitMismatch: true`; sourceQuantity/sourceUnit her zaman saklanır.
//
// ÜRETİLEN ÜRÜN (02.09.2026, Davut kararı): productionProducts.supplyType === 'produced'
// (Pizza Hamuru, tatlılar, Makarna) STOK DEĞİLDİR. İmalat deposundan TRANSFER_OUT yazılmaz
// ve satır açılmaz; yerine aktif productionRecipes reçetesi imalat hammaddesinden düşülür
// (PRODUCTION_CONSUME — production-domain RecipeStockEngine ile aynı hesap ve aynı
// idempotency işareti `productionStockLog/{orderId}_consume`: imalat-web'de "Üretime Al"
// basılmışsa ikinci kez düşülmez; burada düşüldüyse "Üretime Al" ikinci kez düşmez).
// Şube tarafı değişmez: üretilen ürün şubeye TRANSFER_IN ile girer.
//
// İdempotency: yazımlar finalize/approve transaction'ının İÇİNDE yapılır ve o
// transaction "status zaten sent ise çık" guard'ı ile korunur → tek sefer çalışır.
//
// Acil kapatma: INVOICING_CANONICAL_STOCK_DISABLED=true (default: AÇIK).

const { Timestamp } = require('firebase-admin/firestore');
const { normalizeUnit, convertQuantity, roundQty } = require('./UnitConversion');

const STOCK_LOG_COLLECTION = 'productionStockLog';

function canonicalStockEnabled() {
    return process.env.INVOICING_CANONICAL_STOCK_DISABLED !== 'true';
}

/** Aktif reçete (en yüksek version) — RecipeStockEngine.getActiveRecipe paritesi. */
async function getActiveRecipe(db, tenantId, productionProductId) {
    const snap = await db.collection('productionRecipes')
        .where('tenantId', '==', tenantId)
        .where('productionProductId', '==', productionProductId)
        .get();
    const active = snap.docs.map((d) => d.data()).filter((r) => r.isActive !== false && !r.isArchived)
        .sort((a, b) => (b.version || 1) - (a.version || 1));
    return active[0] || null;
}

/**
 * Transaction ÖNCESİ hazırlık: inventoryProductId çözümlemesi + kart birimi + üretilen/ticari
 * ayrımı + reçete düşüm planı + ref listeleri.
 * finalItems: [{productId, productName, unit, finalQuantity}] (onay sonrası kesin adetler).
 * orderId/orderNumber: kaynak üretim siparişi (reçete düşümü işareti için); yoksa sourceId kullanılır.
 * Dönen plan null ise yazılacak bir şey yok (flag kapalı / branchId yok / adetler 0).
 */
async function planCanonicalStock(db, { tenantId, branchId, finalItems, orderId, orderNumber }) {
    if (!canonicalStockEnabled() || !branchId) return null;

    const entries = [];
    const consume = new Map(); // ingredient invId -> { invId, name, qty, unit, ... }
    const prodCache = new Map();
    const cardUnitCache = new Map();
    const cardUnitOf = async (invId) => {
        if (!cardUnitCache.has(invId)) {
            const cs = await db.collection('inventoryProducts').doc(invId).get();
            const cd = cs.exists ? cs.data() : null;
            cardUnitCache.set(invId, cd && cd.unit ? normalizeUnit(cd.unit, null) : null);
        }
        return cardUnitCache.get(invId);
    };
    const addEntry = (list, key, { invId, name, qty, unit, cardUnit }) => {
        const orderUnit = normalizeUnit(unit, 'adet');
        const prev = list instanceof Map ? list.get(key) : list.find((e) => e.invId === key);
        if (prev) {
            const c = convertQuantity(qty, orderUnit, prev.unit);
            prev.qty = roundQty(prev.qty + c.qty);
            prev.converted = prev.converted || c.converted;
            prev.mismatch = prev.mismatch || c.mismatch;
            if (prev.sourceUnit === orderUnit) prev.sourceQty = roundQty(prev.sourceQty + qty);
            else { prev.sourceQty = null; prev.sourceUnit = null; } // karışık kaynak birim — iz tutulamaz
            return prev;
        }
        const target = cardUnit || orderUnit;
        const c = convertQuantity(qty, orderUnit, target);
        const e = { invId, name, qty: c.qty, unit: target, cardUnit, sourceQty: roundQty(qty), sourceUnit: orderUnit, converted: c.converted, mismatch: c.mismatch };
        if (list instanceof Map) list.set(key, e); else list.push(e);
        return e;
    };

    for (const it of finalItems || []) {
        const qty = Number(it.finalQuantity);
        if (!(qty > 0) || !it.productId) continue;

        if (!prodCache.has(it.productId)) {
            const snap = await db.collection('productionProducts').doc(it.productId).get();
            prodCache.set(it.productId, snap.exists ? snap.data() : null);
        }
        const pd = prodCache.get(it.productId);
        const invId = (pd && pd.inventoryProductId) || it.productId;
        const produced = !!(pd && pd.supplyType === 'produced');
        const cardUnit = await cardUnitOf(invId);

        const e = addEntry(entries, invId, { invId, name: it.productName || invId, qty, unit: it.unit, cardUnit });
        e.produced = e.produced || produced;

        if (produced) {
            // Reçete düşümü: item.qty / outputQuantity × ingredient.quantity (RecipeStockEngine paritesi)
            const recipe = await getActiveRecipe(db, tenantId, it.productId);
            if (!recipe) { e.noRecipe = true; continue; }
            const output = recipe.outputQuantity > 0 ? recipe.outputQuantity : 1;
            const mult = qty / output;
            for (const ing of recipe.ingredients || []) {
                if (!ing.inventoryProductId || !(ing.quantity > 0)) continue;
                const ce = addEntry(consume, ing.inventoryProductId, {
                    invId: ing.inventoryProductId,
                    name: ing.inventoryProductName || ing.inventoryProductId,
                    qty: ing.quantity * mult,
                    unit: ing.unit,
                    cardUnit: await cardUnitOf(ing.inventoryProductId),
                });
                ce.forProducts = ce.forProducts || new Set(); ce.forProducts.add(it.productName || it.productId);
            }
        }
    }
    if (entries.length === 0) return null;

    const imalatBranchId = `imalat_${tenantId}`;
    const consumeEntries = [...consume.values()];
    const markerKey = orderId ? `${orderId}_consume` : null;
    return {
        imalatBranchId,
        orderId: orderId || null,
        orderNumber: orderNumber || null,
        entries,
        // üretilen ürün için imalat çıkış satırı YOK (stok değil)
        outRefs: entries.map((e) => (e.produced ? null : db.collection('branchStocks').doc(`${imalatBranchId}_${e.invId}`))),
        inRefs: entries.map((e) => db.collection('branchStocks').doc(`${branchId}_${e.invId}`)),
        consumeEntries,
        consumeRefs: consumeEntries.map((e) => db.collection('branchStocks').doc(`${imalatBranchId}_${e.invId}`)),
        markerRef: consumeEntries.length && markerKey ? db.collection(STOCK_LOG_COLLECTION).doc(markerKey) : null,
    };
}

/** Transaction içinde plan reflerinin okunması (tüm okumalar yazmalardan önce kuralı). */
async function readCanonicalStock(txn, plan) {
    if (!plan) return null;
    const [outSnaps, inSnaps, consumeSnaps, markerSnap] = await Promise.all([
        Promise.all(plan.outRefs.map((r) => (r ? txn.get(r) : Promise.resolve(null)))),
        Promise.all(plan.inRefs.map((r) => txn.get(r))),
        Promise.all((plan.consumeRefs || []).map((r) => txn.get(r))),
        plan.markerRef ? txn.get(plan.markerRef) : Promise.resolve(null),
    ]);
    return { outSnaps, inSnaps, consumeSnaps, markerSnap };
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

/** Plan kalemini bu satır için hedef birime çevirir: satır birimi > kart birimi > sipariş birimi. */
function resolveForRow(e, snap) {
    const rowUnit = readRowUnit(snap);
    const target = rowUnit || e.unit;
    const c = convertQuantity(e.qty, e.unit, target);
    return { qty: c.qty, unit: target, converted: e.converted || c.converted, mismatch: e.mismatch || c.mismatch };
}

function movementBase(e, r) {
    const m = { productId: e.invId, productName: e.name, unit: r.unit, sourceQuantity: e.sourceQty, sourceUnit: e.sourceUnit };
    if (r.mismatch) m.unitMismatch = true;
    return m;
}

function mismatchNote(e, r) {
    return r.mismatch ? ` (birim uyuşmazlığı: ${e.sourceUnit || '?'} → ${r.unit}, çevrilmedi)` : '';
}

/**
 * Transaction içinde YAZIM (okumalar readCanonicalStock ile yapılmış olmalı):
 *  - ticari kalem: imalat −qty (0'da clamp), şube +qty, TRANSFER_OUT + TRANSFER_IN
 *  - üretilen kalem: şube +qty (TRANSFER_IN); imalatta reçete hammaddesi −qty (PRODUCTION_CONSUME),
 *    productionStockLog işareti varsa (Üretime Al düşmüş) reçete düşümü atlanır.
 * Dönüş: yazılan kalem sayısı (entries.length).
 */
function writeCanonicalStock(db, txn, plan, snaps, { tenantId, branchId, sourceId, sourceLabel, recordedBy, tsMillis }) {
    if (!plan || !snaps) return 0;
    const ts = Timestamp.fromMillis(tsMillis);

    for (let i = 0; i < plan.entries.length; i++) {
        const e = plan.entries[i];

        if (!e.produced) {
            // İmalat deposu düşümü (ticari / hammadde)
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
                notes: `İrsaliye onayı ${sourceLabel || ''}`.trim() + mismatchNote(e, out),
                sourceType: 'invoice_approval',
                sourceDocumentId: sourceId,
                targetBranchId: branchId,
                createdBy: recordedBy || 'invoicing-engine',
            });
        }

        // Hedef şube girişi (ticari + üretilen)
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
            notes: `İrsaliye onayı ${sourceLabel || ''} - İmalattan transfer`.trim() + mismatchNote(e, inn) + (e.produced ? ' (üretilen ürün)' : ''),
            sourceType: 'invoice_approval',
            sourceDocumentId: sourceId,
            createdBy: recordedBy || 'invoicing-engine',
        });
    }

    // Üretilen ürünlerin reçete düşümü (imalat hammaddesi)
    const consumeEntries = plan.consumeEntries || [];
    const alreadyConsumed = !!(snaps.markerSnap && snaps.markerSnap.exists);
    if (consumeEntries.length && !alreadyConsumed) {
        for (let i = 0; i < consumeEntries.length; i++) {
            const e = consumeEntries[i];
            const snap = snaps.consumeSnaps[i];
            const r = resolveForRow(e, snap);
            const current = readStock(snap);
            txn.set(plan.consumeRefs[i], {
                id: `${plan.imalatBranchId}_${e.invId}`,
                tenantId,
                branchId: plan.imalatBranchId,
                productId: e.invId,
                productName: e.name,
                currentStock: Math.max(0, roundQty(current - r.qty)),
                unit: r.unit,
                lastUpdated: ts,
            }, { merge: true });
            const mvRef = db.collection('stockMovements').doc();
            txn.set(mvRef, {
                id: mvRef.id,
                tenantId,
                branchId: plan.imalatBranchId,
                movementType: 'PRODUCTION_CONSUME',
                ...movementBase(e, r),
                quantity: -r.qty,
                movementDate: ts,
                createdAt: ts,
                notes: `Üretim siparişi: ${plan.orderNumber || sourceLabel || ''}`.trim() + ' (irsaliye onayında reçete düşümü: ' + [...(e.forProducts || [])].join(', ') + ')' + mismatchNote(e, r),
                sourceType: 'invoice_approval',
                sourceDocumentId: sourceId,
                sourceOrderId: plan.orderId || null,
                createdBy: recordedBy || 'invoicing-engine',
            });
        }
        if (plan.markerRef) {
            txn.set(plan.markerRef, {
                orderId: plan.orderId,
                orderNumber: plan.orderNumber || null,
                tenantId,
                phase: 'consume',
                count: consumeEntries.length,
                source: 'invoice_approval',
                sourceDocumentId: sourceId,
                createdAt: ts,
            });
        }
    }
    return plan.entries.length;
}

module.exports = {
    canonicalStockEnabled,
    planCanonicalStock,
    readCanonicalStock,
    writeCanonicalStock,
};
