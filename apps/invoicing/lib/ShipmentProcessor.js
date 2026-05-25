// ==================================================================================
// ShipmentProcessor — Plan 28++ e-irsaliye akisi
// ==================================================================================
// invoiceDocuments documentKind='shipment' draft -> created -> sent yolu:
//
//   create(docId): manuel modda yetkili "İrsaliye Oluştur" -> Parasut'a shipment_document
//                  POST + parasutShipmentId yazilir, status='pending_approval'.
//
//   saveEdits(docId, edits): yetkili kalemleri duzeltir (eksik fire vb.) -> Parasut
//                            updateShipmentDocument + Firestore approvalMeta guncellenir.
//
//   finalize(docId): yetkili "Onayla" -> Firestore transaction (status='sent',
//                    inventory hareketleri, stockTransfer.completed). Parasut tarafinda
//                    convert_to_e_shipment endpoint'i yok; resmiyet Parasut otomasyonu/paneli
//                    araciligiyla GİB'e gider. Yemigo sadece dahili akisi tamamlar.
// ==================================================================================

const { applyMovement, makeEmptyAggregate } = require('./InventoryAggregator');

/** Firestore Timestamp / ms / Date / null -> ms (Plan 28++ Date(Invalid) bugfix) */
function tsToMs(v) {
    if (v == null) return Date.now();
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'object') {
        if (typeof v.toMillis === 'function') return v.toMillis();
        if (typeof v._seconds === 'number') return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
        if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
    return Date.now();
}

/**
 * Plan 28+++ — Paraşüt description alanı belge BAŞLIĞINA basıldığı için sade tutulur.
 * Sürücü/TCKN/plaka bilgisi description'a yazılmaz (başlık şişer); Yemigo Firestore'da
 * shipmentDetails alanında saklanır. Yetkili GİB onayı sırasında Paraşüt panelinden
 * "Sürücü Bilgileri" alanını manuel doldurur (Paraşüt API'sinde bu alan yok).
 *
 * Description = baseDescription (sadece sevkiyat no). Boşsa Paraşüt default başlık koyar.
 */
function buildShipmentDescription(baseDescription /* , shipmentDetails */) {
    return baseDescription || '';
}

class ShipmentError extends Error {
    constructor(message, { status = 500, code, payload } = {}) {
        super(message);
        this.name = 'ShipmentError';
        this.status = status;
        this.code = code || 'shipment_error';
        if (payload) this.payload = payload;
    }
}

class ShipmentProcessor {
    /**
     * @param {object} deps
     * @param {object} deps.db Firestore admin db
     * @param {object} deps.idempotency IdempotencyService
     * @param {object} deps.tokenManager
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     * @param {(tenantId: string, doc: object) => Promise<object>} deps.contextLoader
     */
    constructor({ db, idempotency, tokenManager, providerFactory, contextLoader }) {
        if (!db) throw new Error('ShipmentProcessor: db required');
        if (!idempotency) throw new Error('ShipmentProcessor: idempotency required');
        if (!tokenManager) throw new Error('ShipmentProcessor: tokenManager required');
        if (!providerFactory) throw new Error('ShipmentProcessor: providerFactory required');
        if (!contextLoader) throw new Error('ShipmentProcessor: contextLoader required');
        this.db = db;
        this.idempotency = idempotency;
        this.tokenManager = tokenManager;
        this.providerFactory = providerFactory;
        this.contextLoader = contextLoader;
    }

    /**
     * Plan 28++ create — manuel modda yetkili "İrsaliye Oluştur" basinca tetiklenir.
     * Parasut'a shipment_document POST eder; basarili olursa parasutShipmentId yazilir.
     * Plan 28+++: shipmentDetails (driverName, driverTckn, vehiclePlate, shipmentDateTime)
     * body'den alinip Firestore'a kaydedilir, Parasut description'a yazilir.
     */
    async create(documentId, body = {}) {
        const { tenantId, requestedBy, shipmentDetails } = body;
        if (!tenantId) throw new ShipmentError('missing tenantId', { status: 400, code: 'missing_tenantId' });

        const doc = await this.idempotency.getById(documentId);
        if (!doc) throw new ShipmentError('document not found', { status: 404, code: 'not_found' });
        if (doc.tenantId !== tenantId) throw new ShipmentError('tenant mismatch', { status: 403, code: 'tenant_mismatch' });
        if (doc.documentKind !== 'shipment') {
            throw new ShipmentError('document is not a shipment', { status: 409, code: 'not_shipment_kind' });
        }
        if (doc.parasutShipmentId) {
            // Idempotent: zaten Parasut'a yazilmis
            return {
                ok: true,
                already: true,
                parasutShipmentId: doc.parasutShipmentId,
                parasutShipmentNumber: doc.parasutShipmentNumber,
                pdfUrl: doc.pdfUrl,
            };
        }
        if (doc.status === 'sent' || doc.status === 'cancelled') {
            throw new ShipmentError(`invalid status: ${doc.status}`, { status: 409, code: 'invalid_status' });
        }

        const provider = await this.providerFactory(tenantId);
        const token = await this.tokenManager.getValidToken(tenantId);
        const ctx = await this.contextLoader(tenantId, doc);

        // Contact upsert
        const contact = await provider.upsertContact(token, {
            ...ctx.branch,
            id: ctx.branch.id || doc.branchId,
        });

        // Product upsert
        const itemsWithProductIds = [];
        for (const it of (ctx.items || [])) {
            if (!it.quantity || it.quantity <= 0) continue;
            const p = await provider.upsertProduct(token, {
                name: it.productName || it.name,
                sku: it.productId || it.sku,
                unit: it.unit,
                vatRate: it.vatRate,
            });
            itemsWithProductIds.push({
                productId: p.productId,
                name: it.productName || it.name,
                description: it.productName || it.name,
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                vatRate: it.vatRate,
            });
        }

        if (itemsWithProductIds.length === 0) {
            throw new ShipmentError('no items to ship', { status: 400, code: 'no_items' });
        }

        let shipment;
        try {
            // Plan 28+++ — sevkiyat tarihi onceligi: form -> shipmentMeta -> simdi
            const effectiveDetails = shipmentDetails || doc.shipmentDetails || null;
            const formMs = effectiveDetails && effectiveDetails.shipmentDateTime
                ? Date.parse(effectiveDetails.shipmentDateTime)
                : NaN;
            const shipmentDateMs = Number.isFinite(formMs)
                ? formMs
                : tsToMs(doc.shipmentMeta && doc.shipmentMeta.shippedAt);
            const description = buildShipmentDescription(ctx.description, effectiveDetails);

            shipment = await provider.createShipmentDocument(token, {
                contactId: contact.contactId,
                items: itemsWithProductIds,
                issueDate: ctx.issueDate,
                shipmentDate: new Date(shipmentDateMs).toISOString(),
                description,
                address: ctx.branch && ctx.branch.address,
                city: ctx.branch && ctx.branch.city,
                district: ctx.branch && ctx.branch.district,
                // procurement_number kasten gönderilmiyor — Paraşüt otomatik üretir (BR0...).
                // Yemigo'daki kaynak transfer no Firestore doc.sourceTransferNumber'da kalır.
                inflow: false,
            });
        } catch (e) {
            await this.idempotency.update(documentId, {
                lastError: { message: e.message, code: e.code || 'parasut_shipment_failed', ts: Date.now() },
            });
            await this.idempotency.appendAudit(documentId, 'parasut_shipment_failed', 'panel', {
                error: e.message,
                code: e.code,
                status: e.status,
                providerPayload: e.providerPayload ? JSON.stringify(e.providerPayload).slice(0, 1000) : null,
            }).catch(() => {});
            throw new ShipmentError(`parasut shipment failed: ${e.message}`, {
                status: e.status || 502,
                code: e.code || 'parasut_failed',
                payload: { providerPayload: e.providerPayload },
            });
        }

        await this.idempotency.update(documentId, {
            status: 'pending_approval',
            parasutShipmentId: shipment.providerShipmentId,
            parasutShipmentNumber: shipment.shipmentNumber,
            parasutContactId: contact.contactId,
            pdfUrl: shipment.pdfUrl,
            parasutShipmentCreatedAt: Date.now(),
            // Plan 28+++ — sevkiyat detaylarini kalici sakla
            ...(shipmentDetails ? { shipmentDetails } : {}),
        });
        await this.idempotency.appendAudit(documentId, 'parasut_shipment_created', requestedBy || 'panel', {
            parasutShipmentId: shipment.providerShipmentId,
            items: itemsWithProductIds.length,
        });

        return {
            ok: true,
            parasutShipmentId: shipment.providerShipmentId,
            parasutShipmentNumber: shipment.shipmentNumber,
            pdfUrl: shipment.pdfUrl,
        };
    }

    /**
     * Plan 28++ saveEdits — kalem duzenleme (eksik fire, miktar duzeltme).
     * Parasut tarafinda updateShipmentDocument cagirir + Firestore approvalMeta guncellenir.
     */
    async saveEdits(documentId, body = {}) {
        const { tenantId, edits, editedBy, note, shipmentDetails } = body;
        if (!tenantId) throw new ShipmentError('missing tenantId', { status: 400, code: 'missing_tenantId' });
        if (!Array.isArray(edits)) throw new ShipmentError('edits not array', { status: 400, code: 'edits_not_array' });

        const doc = await this.idempotency.getById(documentId);
        if (!doc) throw new ShipmentError('document not found', { status: 404, code: 'not_found' });
        if (doc.tenantId !== tenantId) throw new ShipmentError('tenant mismatch', { status: 403, code: 'tenant_mismatch' });
        if (doc.documentKind !== 'shipment') {
            throw new ShipmentError('not a shipment document', { status: 409, code: 'not_shipment_kind' });
        }
        if (doc.status === 'sent' || doc.status === 'cancelled') {
            throw new ShipmentError(`cannot edit in status: ${doc.status}`, { status: 409, code: 'invalid_status' });
        }

        const itemsByIdx = new Map((doc.items || []).map((it) => [it.itemIndex, it]));
        const cleanEdits = [];
        let fireTotal = 0;
        for (const e of edits) {
            const idx = Number(e.itemIndex);
            const original = itemsByIdx.get(idx);
            if (!original) {
                throw new ShipmentError(`unknown itemIndex ${idx}`, { status: 400, code: 'unknown_itemIndex' });
            }
            const finalQty = Number(e.finalQty);
            if (!Number.isFinite(finalQty) || finalQty < 0 || finalQty > original.originalQuantity) {
                throw new ShipmentError(`finalQty out of range for itemIndex=${idx}`, {
                    status: 400,
                    code: 'finalQty_out_of_range',
                    payload: { itemIndex: idx, originalQuantity: original.originalQuantity, received: finalQty },
                });
            }
            const diffReason = ['fire', 'iade', 'duzeltme'].includes(e.diffReason) ? e.diffReason : undefined;
            cleanEdits.push({
                itemIndex: idx,
                productId: original.productId,
                originalQty: original.originalQuantity,
                finalQty,
                diffReason,
                note: typeof e.note === 'string' ? e.note.slice(0, 500) : undefined,
            });
            const diff = original.originalQuantity - finalQty;
            if (diff > 0 && diffReason === 'fire') fireTotal += diff;
        }

        // Parasut tarafinda update — sadece parasutShipmentId varsa (yani daha once create edilmisse)
        if (doc.parasutShipmentId) {
            const provider = await this.providerFactory(tenantId);
            const token = await this.tokenManager.getValidToken(tenantId);
            const editsByIdx = new Map(cleanEdits.map((e) => [e.itemIndex, e]));
            const itemsForParasut = (doc.items || [])
                .map((it) => {
                    const editedQty = editsByIdx.has(it.itemIndex)
                        ? editsByIdx.get(it.itemIndex).finalQty
                        : it.originalQuantity;
                    return {
                        productId: it.productId,
                        name: it.productName,
                        quantity: editedQty,
                        unitPrice: it.unitPrice,
                        vatRate: it.vatRate,
                    };
                })
                .filter((it) => it.quantity > 0);

            // Parasut'a yeni productId'leri tanit
            const itemsWithProductIds = [];
            for (const it of itemsForParasut) {
                const p = await provider.upsertProduct(token, {
                    name: it.name,
                    sku: it.productId,
                    vatRate: it.vatRate,
                });
                itemsWithProductIds.push({ ...it, productId: p.productId });
            }

            try {
                await provider.updateShipmentDocument(token, doc.parasutShipmentId, {
                    items: itemsWithProductIds,
                });
            } catch (e) {
                console.warn(`[ShipmentProcessor] updateShipmentDocument failed: ${e.message}`);
                // Sessiz: Firestore update'i yine de yap (yetkili tekrar bastirinca duzelir)
            }
        }

        // Plan 28+++ — Parasut'a yazilmissa description + shipment_date guncelle
        if (doc.parasutShipmentId && shipmentDetails) {
            try {
                const provider = await this.providerFactory(tenantId);
                const token = await this.tokenManager.getValidToken(tenantId);
                const ctx = await this.contextLoader(tenantId, doc);
                const description = buildShipmentDescription(ctx.description, shipmentDetails);
                const formMs = shipmentDetails.shipmentDateTime
                    ? Date.parse(shipmentDetails.shipmentDateTime)
                    : NaN;
                const shipmentDateIso = Number.isFinite(formMs)
                    ? new Date(formMs).toISOString()
                    : undefined;
                await provider.updateShipmentDocument(token, doc.parasutShipmentId, {
                    description,
                    ...(shipmentDateIso ? { shipmentDate: shipmentDateIso } : {}),
                });
            } catch (e) {
                console.warn(`[ShipmentProcessor] updateShipmentDocument(meta) failed: ${e.message}`);
            }
        }

        await this.idempotency.update(documentId, {
            status: 'pending_approval',
            approvalMeta: {
                ...(doc.approvalMeta || {}),
                edits: cleanEdits,
                fireQuantityTotal: fireTotal,
                lastEditedAt: Date.now(),
                lastEditedBy: editedBy || 'panel',
            },
            ...(shipmentDetails ? { shipmentDetails } : {}),
        });
        await this.idempotency.appendAudit(documentId, 'shipment_edited', editedBy || 'panel', {
            editsCount: cleanEdits.length,
            fireTotal,
            note: note ? String(note).slice(0, 500) : undefined,
        });

        return { ok: true, edits: cleanEdits, fireQuantityTotal: fireTotal };
    }

    /**
     * Plan 28++ finalize — yetkili "Onayla" basinca tetiklenir.
     * Firestore transaction: status='sent' + inventory hareketleri + stockTransfer.completed.
     * Parasut tarafinda convert_to_e_shipment endpoint'i yok; resmiyet Parasut otomasyonu
     * tarafindan yonetilir. Yemigo sadece dahili akisi tamamlar.
     */
    async finalize(documentId, body = {}) {
        const { tenantId, approvedBy } = body;
        if (!tenantId) throw new ShipmentError('missing tenantId', { status: 400, code: 'missing_tenantId' });
        if (!approvedBy) throw new ShipmentError('missing approvedBy', { status: 400, code: 'missing_approvedBy' });

        const doc = await this.idempotency.getById(documentId);
        if (!doc) throw new ShipmentError('document not found', { status: 404, code: 'not_found' });
        if (doc.tenantId !== tenantId) throw new ShipmentError('tenant mismatch', { status: 403, code: 'tenant_mismatch' });
        if (doc.documentKind !== 'shipment') {
            throw new ShipmentError('not a shipment document', { status: 409, code: 'not_shipment_kind' });
        }
        if (doc.status === 'sent') {
            return {
                ok: true,
                already: true,
                parasutShipmentId: doc.parasutShipmentId,
                parasutShipmentNumber: doc.parasutShipmentNumber,
            };
        }
        if (!doc.parasutShipmentId) {
            throw new ShipmentError('shipment not yet created on Parasut', { status: 409, code: 'no_parasut_shipment' });
        }

        const ctx = await this.contextLoader(tenantId, doc);
        const items = Array.isArray(doc.items) ? doc.items : [];
        const editsByIdx = new Map(
            (doc.approvalMeta && doc.approvalMeta.edits ? doc.approvalMeta.edits : []).map((e) => [e.itemIndex, e]),
        );

        const finalItems = [];
        const wasteEntries = [];
        let fireTotal = 0;

        for (const it of items) {
            const e = editsByIdx.get(it.itemIndex);
            const finalQty = e ? Number(e.finalQty) : it.originalQuantity;
            finalItems.push({
                ...it,
                finalQuantity: finalQty,
                diffReason: e ? e.diffReason : undefined,
            });
            const diff = it.originalQuantity - finalQty;
            if (diff > 0 && e && e.diffReason === 'fire') {
                wasteEntries.push({
                    itemIndex: it.itemIndex,
                    productId: it.productId,
                    productName: it.productName,
                    quantity: diff,
                    unit: it.unit,
                });
                fireTotal += diff;
            }
        }

        const ts = Date.now();
        const productionLocationId = ctx.productionLocationId || 'central';
        const branchId = doc.branchId || (ctx.branch && ctx.branch.id);

        try {
            await this.db.runTransaction(async (txn) => {
                const docRef = this.db.collection('invoiceDocuments').doc(documentId);
                const fresh = await txn.get(docRef);
                if (!fresh.exists) throw new ShipmentError('document vanished', { status: 410, code: 'doc_vanished' });
                const freshData = fresh.data();
                if (freshData.status === 'sent') return; // race idempotent

                txn.update(docRef, {
                    status: 'sent',
                    'approvalMeta.approvedAt': ts,
                    'approvalMeta.approvedBy': approvedBy,
                    'approvalMeta.fireQuantityTotal': fireTotal,
                    updatedAt: ts,
                });

                // stockTransfer.completed
                if (doc.sourceType === 'stockTransfer' && doc.sourceId) {
                    const tRef = this.db.collection('stockTransfers').doc(doc.sourceId);
                    txn.update(tRef, { status: 'completed', completedAt: ts, updatedAt: ts });
                }

                // inventoryMovements (production -> branch)
                if (branchId) {
                    for (const it of finalItems) {
                        if (it.finalQuantity > 0) {
                            const outRef = this.db.collection('inventoryMovements').doc();
                            txn.set(outRef, {
                                tenantId,
                                type: 'shipment_out',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                unit: it.unit,
                                fromLocation: { type: 'production', id: productionLocationId },
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'shipment_finalize',
                                sourceId: documentId,
                                ts,
                                recordedBy: approvedBy,
                            });
                            const inRef = this.db.collection('inventoryMovements').doc();
                            txn.set(inRef, {
                                tenantId,
                                type: 'shipment_in',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                unit: it.unit,
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'shipment_finalize',
                                sourceId: documentId,
                                ts,
                                recordedBy: approvedBy,
                            });
                        }
                    }
                }

                // wasteRecords (fire)
                for (const w of wasteEntries) {
                    const wRef = this.db.collection('wasteRecords').doc();
                    txn.set(wRef, {
                        tenantId,
                        branchId: branchId || null,
                        productId: w.productId,
                        productName: w.productName,
                        quantity: w.quantity,
                        unit: w.unit,
                        sourceType: 'shipment_finalize',
                        sourceId: documentId,
                        reason: 'fire',
                        recordedBy: approvedBy,
                        recordedAt: ts,
                    });
                }

                // branchInventory aggregate
                if (branchId) {
                    const aggRef = this.db.collection('branchInventory').doc(tenantId);
                    const aggSnap = await txn.get(aggRef);
                    let agg;
                    if (aggSnap.exists) {
                        agg = aggSnap.data();
                        if (!agg.branches) agg.branches = {};
                        if (!agg.production) agg.production = {};
                    } else {
                        agg = makeEmptyAggregate(tenantId);
                    }
                    for (const it of finalItems) {
                        if (it.finalQuantity > 0) {
                            applyMovement(agg, {
                                tenantId,
                                type: 'shipment_out',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                fromLocation: { type: 'production', id: productionLocationId },
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'shipment_finalize',
                                sourceId: documentId,
                                ts,
                            });
                            applyMovement(agg, {
                                tenantId,
                                type: 'shipment_in',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'shipment_finalize',
                                sourceId: documentId,
                                ts,
                            });
                        }
                    }
                    agg.updatedAt = ts;
                    txn.set(aggRef, agg);
                }
            });
        } catch (txnErr) {
            console.error(`[ShipmentProcessor] Firestore transaction failed for doc ${documentId}:`, txnErr.message);
            await this.idempotency.update(documentId, {
                lastError: { message: txnErr.message, code: 'firestore_txn_failed', ts: Date.now() },
            }).catch(() => {});
            throw new ShipmentError(`firestore txn failed: ${txnErr.message}`, {
                status: 500,
                code: 'firestore_txn_failed',
            });
        }

        await this.idempotency.appendAudit(documentId, 'shipment_finalized', approvedBy, {
            parasutShipmentId: doc.parasutShipmentId,
            fireTotal,
        });

        return {
            ok: true,
            parasutShipmentId: doc.parasutShipmentId,
            parasutShipmentNumber: doc.parasutShipmentNumber,
            pdfUrl: doc.pdfUrl,
            fireQuantityTotal: fireTotal,
        };
    }
}

module.exports = { ShipmentProcessor, ShipmentError };
