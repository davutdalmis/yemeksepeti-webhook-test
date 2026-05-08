// ==================================================================================
// ApprovalProcessor — Plan 28 Faz 3 atomik onay tetikleyicisi
// ==================================================================================
// invoiceDocuments draft / pending_approval -> sent yolu:
//   1. Validation (status, tenantId, edits range, finalQty bounds)
//   2. Eager-claim: status='approved' (idempotency, race safe)
//   3. Parasut createInvoice + e_archive (transaction DISINDA, basarisizsa rollback)
//   4. Firestore transaction:
//        - invoiceDocuments.status='sent', parasutInvoiceId, eArchiveId
//        - stockTransfers.status='completed'
//        - inventoryMovements +N (shipment_out + shipment_in per item)
//        - wasteRecords +M (fire reason'lar icin)
//        - branchInventory aggregate update (in-place)
//   5. Hata: Paraşüt deleteInvoice compensating action
// ==================================================================================

const { validateTransition } = require('./StatusTransitionValidator');
const { applyMovement, makeEmptyAggregate } = require('./InventoryAggregator');

class ApprovalError extends Error {
    constructor(message, { status = 500, code, payload } = {}) {
        super(message);
        this.name = 'ApprovalError';
        this.status = status;
        this.code = code || 'approval_error';
        if (payload) this.payload = payload;
    }
}

class ApprovalProcessor {
    /**
     * @param {object} deps
     * @param {object} deps.db Firestore admin db
     * @param {object} deps.idempotency IdempotencyService
     * @param {object} deps.tokenManager
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     * @param {(tenantId: string, doc: object) => Promise<object>} deps.contextLoader
     *        - Paraşüt context loader (branch info, vatRate, currency, issueDate, ...).
     *        - items burada KULLANILMAZ; doc.items + edits'ten türetilir.
     */
    constructor({ db, idempotency, tokenManager, providerFactory, contextLoader }) {
        if (!db) throw new Error('ApprovalProcessor: db required');
        if (!idempotency) throw new Error('ApprovalProcessor: idempotency required');
        if (!tokenManager) throw new Error('ApprovalProcessor: tokenManager required');
        if (!providerFactory) throw new Error('ApprovalProcessor: providerFactory required');
        if (!contextLoader) throw new Error('ApprovalProcessor: contextLoader required');
        this.db = db;
        this.idempotency = idempotency;
        this.tokenManager = tokenManager;
        this.providerFactory = providerFactory;
        this.contextLoader = contextLoader;
    }

    /**
     * @param {string} documentId invoiceDocuments doc ID
     * @param {object} body { tenantId, approvedBy, edits?, fireRecords? }
     * @returns {Promise<{ ok, parasutInvoiceId, eArchiveId, fireQuantityTotal }>}
     */
    async approve(documentId, body = {}) {
        const { tenantId, approvedBy } = body;
        if (!tenantId) throw new ApprovalError('missing tenantId', { status: 400, code: 'missing_tenantId' });
        if (!approvedBy) throw new ApprovalError('missing approvedBy', { status: 400, code: 'missing_approvedBy' });

        // 1. Load + validate
        const doc = await this.idempotency.getById(documentId);
        if (!doc) throw new ApprovalError('document not found', { status: 404, code: 'not_found' });
        if (doc.tenantId !== tenantId) {
            throw new ApprovalError('tenant mismatch', { status: 403, code: 'tenant_mismatch' });
        }

        // Idempotency: already-sent docs return 409 (caller can re-fetch the existing parasutInvoiceId)
        if (doc.status === 'sent') {
            throw new ApprovalError('already approved and sent', {
                status: 409,
                code: 'already_sent',
                payload: { parasutInvoiceId: doc.parasutInvoiceId, eArchiveId: doc.parasutEArchiveId },
            });
        }
        if (doc.status === 'cancelled') {
            throw new ApprovalError('document is cancelled', { status: 409, code: 'cancelled' });
        }

        // Allowed source statuses for approval: draft (auto-approve sin düzenleme yok) veya pending_approval
        if (doc.status !== 'draft' && doc.status !== 'pending_approval') {
            throw new ApprovalError(
                `invalid status for approve: ${doc.status}`,
                { status: 409, code: 'invalid_status', payload: { current: doc.status } },
            );
        }

        const transition = validateTransition(doc.status, 'approved');
        if (!transition.ok) {
            throw new ApprovalError(transition.reason, { status: 409, code: 'invalid_transition' });
        }

        // 2. Edits doğrula + finalItems[] türet (orijinal items + edits)
        const items = Array.isArray(doc.items) ? doc.items : [];
        const editsByIdx = new Map(
            (Array.isArray(body.edits) ? body.edits : doc.approvalMeta?.edits || []).map((e) => [e.itemIndex, e]),
        );

        const finalItems = [];
        const wasteEntries = [];
        let fireTotal = 0;

        for (const it of items) {
            const e = editsByIdx.get(it.itemIndex);
            const finalQty = e ? Number(e.finalQty) : it.originalQuantity;
            if (!Number.isFinite(finalQty) || finalQty < 0 || finalQty > it.originalQuantity) {
                throw new ApprovalError(`finalQty out of range for itemIndex=${it.itemIndex}`, {
                    status: 400,
                    code: 'finalQty_out_of_range',
                    payload: { itemIndex: it.itemIndex, originalQuantity: it.originalQuantity, received: finalQty },
                });
            }
            const diff = it.originalQuantity - finalQty;
            const reason = e?.diffReason;
            if (diff > 0 && !reason) {
                throw new ApprovalError(`missing diffReason for itemIndex=${it.itemIndex}`, {
                    status: 400,
                    code: 'missing_diffReason',
                    payload: { itemIndex: it.itemIndex, diff },
                });
            }
            finalItems.push({
                itemIndex: it.itemIndex,
                productId: it.productId,
                productName: it.productName,
                unit: it.unit,
                unitPrice: it.unitPrice,
                vatRate: it.vatRate,
                originalQuantity: it.originalQuantity,
                finalQuantity: finalQty,
                diffReason: reason,
                batchId: it.batchId || null,
                batchNumber: it.batchNumber || null,
            });
            if (diff > 0 && reason === 'fire') {
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

        if (finalItems.length === 0) {
            // Plan 28 öncesi belge — items yok. Direkt onay (no inventory movement)
            console.warn(`[ApprovalProcessor] doc ${documentId} has no items snapshot — Paraşüt fallback`);
        }

        // 3. Eager-claim status='approved' to block double-approve
        // (race: iki owner aynı anda basar -> Firestore last-write-wins; biz sadece pending_approval/draft -> approved
        // izin veriyoruz; daha güçlü olmak için Firestore transaction içinde bir kontrol eklenebilir).
        await this.idempotency.update(documentId, {
            status: 'approved',
            approvalMeta: {
                ...(doc.approvalMeta || {}),
                approvedAt: Date.now(),
                approvedBy,
                edits: finalItems
                    .filter((it) => it.originalQuantity !== it.finalQuantity)
                    .map((it) => ({
                        itemIndex: it.itemIndex,
                        productId: it.productId,
                        originalQty: it.originalQuantity,
                        finalQty: it.finalQuantity,
                        diffReason: it.diffReason,
                    })),
                fireQuantityTotal: fireTotal,
            },
        });
        await this.idempotency.appendAudit(documentId, 'approved', approvedBy, { fireTotal, items: finalItems.length });

        // 4. Paraşüt POST (transaction dışında, başarısızsa status'u geri pending_approval'a çek)
        const provider = await this.providerFactory(tenantId);
        const ctx = await this.contextLoader(tenantId, doc);
        const items4Parasut = finalItems
            .filter((it) => it.finalQuantity > 0)
            .map((it) => ({
                name: it.productName,
                productName: it.productName,
                productId: it.productId,
                sku: it.productId,
                quantity: it.finalQuantity,
                unitPrice: it.unitPrice,
                vatRate: typeof it.vatRate === 'number' ? it.vatRate : ctx.defaultVatRate || 20,
                unit: it.unit || 'Adet',
            }));

        let parasutResult = null;
        // Plan 28+: Eger listener Parasut'a taslak yazmissa (doc.parasutInvoiceId var),
        // updateDraftInvoice + finalizeInvoice (convert_to_invoice) yolu kullanilir.
        // Yoksa eski tek-atis createInvoice yolu (geriye uyumlu).
        const useExistingDraft = !!doc.parasutInvoiceId;

        try {
            const token = await this.tokenManager.getValidToken(tenantId);

            if (useExistingDraft) {
                // YOL A — Plan 28+ iki asamali: mevcut taslagi guncelle + resmilestir
                // Edits varsa kalem degisiklikleri taslakta da olsun.
                if (Array.isArray(items4Parasut) && items4Parasut.length > 0) {
                    const itemsWithProductIds = [];
                    for (const it of items4Parasut) {
                        const p = await provider.upsertProduct(token, it);
                        itemsWithProductIds.push({ ...it, productId: p.productId });
                    }
                    try {
                        await provider.updateDraftInvoice(token, doc.parasutInvoiceId, {
                            items: itemsWithProductIds,
                            description: ctx.description,
                            shipmentIncluded: !!ctx.shipmentIncluded,
                            issueDate: ctx.issueDate,
                        });
                    } catch (updErr) {
                        console.warn(`[ApprovalProcessor] updateDraftInvoice fail (devam): ${updErr.message}`);
                    }
                }

                // Resmilestir — convert_to_invoice
                // documentType su an kullanmiyoruz; Parasut alici VKN'sine gore
                // otomatik e_invoice (B2B) veya e_archive (B2C) secer. Ileride
                // ctx.documentType'dan zorlanabilir.
                const finalize = await provider.finalizeInvoice(token, doc.parasutInvoiceId, {});
                parasutResult = {
                    providerInvoiceId: finalize.providerInvoiceId,
                    contactId: doc.parasutContactId || null,
                    invoiceNumber: finalize.invoiceNumber,
                    pdfUrl: finalize.pdfUrl,
                    eArchiveId: finalize.eDocType === 'e_archive' ? finalize.eDocId : null,
                    eInvoiceId: finalize.eDocType === 'e_invoice' ? finalize.eDocId : null,
                    eDocType: finalize.eDocType,
                };
            } else {
                // YOL B — Eski tek-atis (geriye uyumlu): listener Parasut'a yazmamissa
                const contact = await provider.upsertContact(token, ctx.branch);
                const itemsWithProductIds = [];
                for (const it of items4Parasut) {
                    const p = await provider.upsertProduct(token, it);
                    itemsWithProductIds.push({ ...it, productId: p.productId });
                }
                parasutResult = await provider.createInvoice(token, {
                    contactId: contact.contactId,
                    items: itemsWithProductIds.length > 0 ? itemsWithProductIds : [{
                        // Tum kalemler 0 ise (rare): tek bir "amount" kaydi olusturma
                        name: doc.sourceTransferNumber || doc.sourceId || 'Sevkiyat',
                        productName: doc.sourceTransferNumber || 'Sevkiyat',
                        sku: doc.sourceId || documentId,
                        quantity: 1,
                        unitPrice: Number(doc.amount || 0),
                        vatRate: ctx.defaultVatRate || 20,
                        unit: 'Adet',
                    }],
                    currency: ctx.currency || 'TRL',
                    issueDate: ctx.issueDate || new Date().toISOString().slice(0, 10),
                    shipmentIncluded: !!ctx.shipmentIncluded,
                    documentType: 'e_archive',
                    description: ctx.description,
                    invoiceSeries: ctx.invoiceSeriesPrefix,
                });
                parasutResult.contactId = contact.contactId;
            }
        } catch (e) {
            // Paraşüt başarısız → status'u geri pending_approval'a çek + audit
            await this.idempotency.update(documentId, {
                status: 'pending_approval',
                lastError: { message: e.message, code: e.code || 'parasut_failed', ts: Date.now() },
            });
            await this.idempotency.appendAudit(documentId, 'failed', 'invoicing-engine', {
                stage: 'parasut',
                code: e.code || 'parasut_failed',
                message: e.message,
            });
            throw new ApprovalError(`parasut failed: ${e.message}`, {
                status: e.status || 502,
                code: e.code || 'parasut_failed',
                payload: { providerPayload: e.providerPayload },
            });
        }

        // 5. Firestore transaction (atomic Firestore writes)
        const ts = Date.now();
        const productionLocationId = ctx.productionLocationId || 'central';
        const branchId = doc.branchId || ctx.branch?.id;
        if (!branchId) {
            console.warn(`[ApprovalProcessor] doc ${documentId} has no branchId — skipping inventory movements`);
        }

        try {
            await this.db.runTransaction(async (txn) => {
                // 5.1 invoiceDocuments → sent + parasutInvoiceId
                const docRef = this.db.collection('invoiceDocuments').doc(documentId);
                const fresh = await txn.get(docRef);
                if (!fresh.exists) throw new ApprovalError('document vanished', { status: 410, code: 'doc_vanished' });
                const freshData = fresh.data();
                if (freshData.status === 'sent') {
                    // Idempotent — başka bir job aynı anda işledi
                    console.warn(`[ApprovalProcessor] doc ${documentId} already sent in race — skipping txn updates`);
                    return;
                }
                if (freshData.status !== 'approved') {
                    // Beklenmeyen state — eager-claim sonrası başkasının manipule etmesi
                    throw new ApprovalError(`unexpected state in txn: ${freshData.status}`, {
                        status: 409,
                        code: 'state_changed_during_approval',
                    });
                }

                txn.update(docRef, {
                    status: 'sent',
                    parasutInvoiceId: parasutResult.providerInvoiceId,
                    parasutEArchiveId: parasutResult.eArchiveId || null,
                    parasutEInvoiceId: parasutResult.eInvoiceId || null,
                    parasutEDocType: parasutResult.eDocType || (parasutResult.eArchiveId ? 'e_archive' : null),
                    parasutContactId: parasutResult.contactId || null,
                    invoiceNumber: parasutResult.invoiceNumber,
                    pdfUrl: parasutResult.pdfUrl,
                    updatedAt: ts,
                });

                // 5.2 stockTransfers → completed
                if (doc.sourceType === 'stockTransfer' && doc.sourceId) {
                    const tRef = this.db.collection('stockTransfers').doc(doc.sourceId);
                    txn.update(tRef, { status: 'completed', completedAt: ts, updatedAt: ts });
                }

                // 5.3 inventoryMovements: shipment_out (production) + shipment_in (branch)
                if (branchId) {
                    for (const it of finalItems) {
                        if (it.finalQuantity > 0) {
                            // shipment_out from production
                            const outRef = this.db.collection('inventoryMovements').doc();
                            txn.set(outRef, {
                                tenantId,
                                type: 'shipment_out',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                unit: it.unit,
                                fromLocation: { type: 'production', id: productionLocationId },
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'invoice_approval',
                                sourceId: documentId,
                                ts,
                                recordedBy: approvedBy,
                            });
                            // shipment_in to branch
                            const inRef = this.db.collection('inventoryMovements').doc();
                            txn.set(inRef, {
                                tenantId,
                                type: 'shipment_in',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                unit: it.unit,
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'invoice_approval',
                                sourceId: documentId,
                                ts,
                                recordedBy: approvedBy,
                            });
                        }
                    }
                }

                // 5.4 wasteRecords + waste inventoryMovement (production'dan eksilen fire)
                for (const w of wasteEntries) {
                    const wRef = this.db.collection('wasteRecords').doc();
                    txn.set(wRef, {
                        tenantId,
                        branchId: branchId || null,
                        productId: w.productId,
                        productName: w.productName,
                        quantity: w.quantity,
                        unit: w.unit,
                        sourceType: 'invoice_approval',
                        sourceId: documentId,
                        reason: 'fire',
                        recordedBy: approvedBy,
                        recordedAt: ts,
                    });
                    // Plan 28 reading: fire kaydı bilgi amaçlı, stok hareketi YOK
                    // (production -finalQty zaten sevkiyatla düşüyor; fire ek hareket gerektirmiyor)
                }

                // 5.5 branchInventory aggregate (in-place merge — yarış riski sınırlı tek txn içinde)
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
                                sourceType: 'invoice_approval',
                                sourceId: documentId,
                                ts,
                            });
                            applyMovement(agg, {
                                tenantId,
                                type: 'shipment_in',
                                productId: it.productId,
                                quantity: it.finalQuantity,
                                toLocation: { type: 'branch', id: branchId },
                                sourceType: 'invoice_approval',
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
            // Compensating action: try to delete the Paraşüt invoice we just created
            console.error(`[ApprovalProcessor] Firestore transaction failed for doc ${documentId}:`, txnErr.message);
            try {
                const token = await this.tokenManager.getValidToken(tenantId);
                if (parasutResult.providerInvoiceId) {
                    await provider.deleteInvoice(token, parasutResult.providerInvoiceId);
                    console.warn(`[ApprovalProcessor] compensating: deleted Paraşüt invoice ${parasutResult.providerInvoiceId}`);
                }
            } catch (compErr) {
                console.error('[ApprovalProcessor] compensating delete FAILED:', compErr.message);
                // Sentry: surface critical alarm — Paraşüt has the invoice but our DB rolled back
                await this.idempotency.appendAudit(documentId, 'failed', 'invoicing-engine', {
                    stage: 'compensating_delete',
                    parasutInvoiceId: parasutResult.providerInvoiceId,
                    txnError: txnErr.message,
                    compError: compErr.message,
                });
            }
            // Reset doc status to pending_approval so user can retry
            await this.idempotency.update(documentId, {
                status: 'pending_approval',
                lastError: { message: txnErr.message, code: 'firestore_txn_failed', ts: Date.now() },
            }).catch(() => {});
            throw new ApprovalError(`firestore txn failed: ${txnErr.message}`, {
                status: 500,
                code: 'firestore_txn_failed',
            });
        }

        await this.idempotency.appendAudit(documentId, 'sent', 'invoicing-engine', {
            parasutInvoiceId: parasutResult.providerInvoiceId,
            eArchiveId: parasutResult.eArchiveId || null,
            eInvoiceId: parasutResult.eInvoiceId || null,
            eDocType: parasutResult.eDocType || (parasutResult.eArchiveId ? 'e_archive' : null),
            twoPhase: !!useExistingDraft,
            fireTotal,
        });

        return {
            ok: true,
            parasutInvoiceId: parasutResult.providerInvoiceId,
            eArchiveId: parasutResult.eArchiveId || null,
            eInvoiceId: parasutResult.eInvoiceId || null,
            eDocType: parasutResult.eDocType || (parasutResult.eArchiveId ? 'e_archive' : null),
            invoiceNumber: parasutResult.invoiceNumber,
            fireQuantityTotal: fireTotal,
            pdfUrl: parasutResult.pdfUrl,
        };
    }
}

module.exports = { ApprovalProcessor, ApprovalError };
