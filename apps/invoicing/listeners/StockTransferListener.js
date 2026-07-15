// ==================================================================================
// StockTransferListener — Firestore listener: stockTransfers.status='shipped'
// ==================================================================================
// Plan 27 Faz 2.1, Plan 28 Faz 1.1.3, Plan 28+ (e-fatura taslak), Plan 28++ (e-irsaliye)
// ile guncellendi.
//
// Tenant settings iki ayri mod kontrol eder:
//   settings.invoiceDraftMode = 'enabled' (default) | 'disabled'
//     - Plan 28+ sales_invoice draft akisi
//   settings.shipmentMode = 'disabled' (default) | 'manual' | 'auto'
//     - Plan 28++ shipment_document (e-irsaliye) akisi
//     - 'manual': Firestore'da documentKind='shipment' DRAFT yaratilir, Parasut'a POST yapilmaz
//                 (yetkili panelden "Irsaliye Olustur" basinca tetiklenir)
//     - 'auto':   Firestore DRAFT + Parasut'a otomatik POST /shipment_documents
//
// Yeni shipped doc gelince:
//   1. Tenant settings yukle (invoicingCredentials/{tenantId}/providers/parasut)
//   2. isEnabled false -> skip
//   3. invoiceDraftMode != 'disabled' ise: invoice DRAFT + (Plan 28+ taslak fatura POST)
//   4. shipmentMode != 'disabled' ise: shipment DRAFT + (auto modda shipment_document POST)
//   5. stockTransfer dok'una parasutQueued=true yaz (re-process onle)
//
// Plan 28: invoice akisinda 'auto' modda dahi otomatik KUYRUGA ALMAZ. Yetkili panelden
// onaylayinca engine /invoicing/draft/:id/approve endpoint'i tetiklenir.
// ==================================================================================

const { validateTransition } = require('../lib/StatusTransitionValidator');

/**
 * Firestore Timestamp / ms / Date / null degerlerini guvenle ms'e cevirir.
 * Plan 28++: shipped_at gibi alanlar `firestore.SERVER_TIMESTAMP` ile yazildigi zaman
 * Timestamp objesi olur; downstream'da new Date(ts).toISOString() Invalid Date verir.
 */
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

class StockTransferListener {
    /**
     * @param {object} deps
     * @param {object} deps.db Firestore db
     * @param {object} deps.idempotency  IdempotencyService
     * @param {object} deps.queue  InvoiceQueue
     * @param {(tenantId: string) => Promise<object>} deps.settingsLoader  -> { isEnabled, automationMode, defaultDocumentType, ... }
     * @param {string} [deps.collection]  default 'stockTransfers'
     * @param {(tenantId: string) => Promise<object>} [deps.providerFactory]  Plan 28+: ParasutProvider factory
     * @param {object} [deps.tokenManager]  Plan 28+: TokenManager
     * @param {(tenantId: string, doc: object) => Promise<object>} [deps.contextLoader]  Plan 28+: invoice context loader
     */
    constructor({ db, idempotency, queue, settingsLoader, collection = 'stockTransfers', providerFactory, tokenManager, contextLoader, masterFlagLoader }) {
        if (!db) throw new Error('StockTransferListener: db required');
        if (!idempotency) throw new Error('StockTransferListener: idempotency required');
        if (!settingsLoader) throw new Error('StockTransferListener: settingsLoader required');
        this.db = db;
        this.idempotency = idempotency;
        this.queue = queue;
        this.settingsLoader = settingsLoader;
        this.collection = collection;
        this.providerFactory = providerFactory || null;
        this.tokenManager = tokenManager || null;
        this.contextLoader = contextLoader || null;
        // Plan 27 5.1.1: tenants/{id}.features.parasut_isEnabled — master kill-switch.
        this.masterFlagLoader = masterFlagLoader || null;
        this._unsubscribe = null;
        this._unsubscribeCancel = null;
    }

    start() {
        if (this._unsubscribe) return;
        const q = this.db.collection(this.collection)
            .where('status', '==', 'shipped')
            .where('parasutQueued', '==', false);

        this._unsubscribe = q.onSnapshot(
            (snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        await this._handleTransfer(change.doc).catch((e) => {
                            console.error(`[StockTransferListener] handle error for ${change.doc.id}:`, e.message);
                        });
                    }
                });
            },
            (err) => {
                console.error('[StockTransferListener] snapshot error:', err.message);
            }
        );
        console.log(`[StockTransferListener] subscribed to ${this.collection} where status=shipped`);

        // Plan 27 — IPTAL GUVENLIK AGI: shipped'ten sonra (parasutQueued=true) iptal edilen
        // transferleri yakala. Belge zaten kesilmemisse (draft vb.) otomatik void et;
        // GIB'e kesilmis (sent) belge varsa OTOMATIK BOZMA — manuel inceleme bayragi koy.
        // Ayni (status, parasutQueued) composite index'i kapsar (shipped+false / cancelled+true).
        const cancelQ = this.db.collection(this.collection)
            .where('status', '==', 'cancelled')
            .where('parasutQueued', '==', true);

        this._unsubscribeCancel = cancelQ.onSnapshot(
            (snapshot) => {
                snapshot.docChanges().forEach(async (change) => {
                    if (change.type === 'added' || change.type === 'modified') {
                        await this._handleCancellation(change.doc).catch((e) => {
                            console.error(`[StockTransferListener] cancel handle error for ${change.doc.id}:`, e.message);
                        });
                    }
                });
            },
            (err) => {
                console.error('[StockTransferListener] cancel snapshot error:', err.message);
            }
        );
        console.log(`[StockTransferListener] subscribed to ${this.collection} where status=cancelled (cancellation safety net)`);
    }

    stop() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
            console.log('[StockTransferListener] unsubscribed');
        }
        if (this._unsubscribeCancel) {
            this._unsubscribeCancel();
            this._unsubscribeCancel = null;
            console.log('[StockTransferListener] unsubscribed (cancel)');
        }
    }

    async _handleTransfer(docSnap) {
        const transfer = docSnap.data();
        const transferId = docSnap.id;

        if (transfer.parasutQueued === true) return;

        const tenantId = transfer.tenantId;
        if (!tenantId) {
            console.warn(`[StockTransferListener] transfer ${transferId} has no tenantId — skipping`);
            return;
        }

        let settings;
        try {
            settings = await this.settingsLoader(tenantId);
        } catch (e) {
            console.warn(`[StockTransferListener] no Parasut settings for tenant ${tenantId} — skipping (${e.message})`);
            return;
        }

        if (!settings || settings.isEnabled === false) {
            return;
        }

        // Master kill-switch: admin panelden kapatıldıysa (features.parasut_isEnabled !== true)
        // hiçbir taslak/POST üretme. Loader hatasında fail-safe KAPALI davranır.
        if (this.masterFlagLoader) {
            let masterOn = false;
            try {
                masterOn = await this.masterFlagLoader(tenantId);
            } catch (e) {
                console.warn(`[StockTransferListener] master flag read failed for ${tenantId} — skipping (${e.message})`);
            }
            if (!masterOn) return;
        }

        // Plan 28: items snapshot — modal+approve endpoint icin items[]'i drafte yaz.
        // originalQuantity sevkiyat anindaki miktar; finalQuantity onay sirasinda
        // duzenlenebilir (default = originalQuantity).
        const itemsSnapshot = Array.isArray(transfer.items)
            ? transfer.items.map((it, idx) => ({
                  itemIndex: idx,
                  productId: it.productId || '',
                  productName: it.productName || '',
                  unit: it.unit || 'adet',
                  unitPrice: Number(it.unitPrice || 0),
                  vatRate: Number(it.vatRate || 0),
                  originalQuantity: Number(
                      it.shippedQuantity != null ? it.shippedQuantity :
                      it.approvedQuantity != null ? it.approvedQuantity :
                      it.requestedQuantity || 0
                  ),
                  batchId: it.batchId || null,
                  batchNumber: it.batchNumber || null,
              }))
            : [];

        // Plan 28: shipmentMeta — sevkiyat zamanindaki bilgiler.
        // Plan 28++: Timestamp -> ms cevrim, downstream'da Date(ts).toISOString() ile patlamasin.
        const shipmentMeta = {
            shippedAt: tsToMs(transfer.shippedAt),
            shippedBy: transfer.preparedBy || transfer.shippedBy || null,
            sourceBranchId: transfer.sourceBranchId || null,
            targetBranchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId || null,
            targetBranchName: transfer.targetBranchName || null,
        };

        const baseDraftData = {
            branchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId,
            provider: 'parasut',
            sourceTransferNumber: transfer.transferNumber || transfer.code,
            amount: transfer.totalAmount || 0,
            currency: transfer.currency || 'TRL',
            documentType: settings.defaultDocumentType || 'sales_invoice',
            shipmentIncluded: !!settings.shipmentIncludedDefault,
            items: itemsSnapshot,
            shipmentMeta,
        };

        const invoiceDraftMode = settings.invoiceDraftMode || 'enabled';
        // Plan 28++: shipmentMode default 'disabled' — geriye uyumluluk (mevcut tenant'lar etkilenmez).
        const shipmentMode = settings.shipmentMode || 'disabled';

        let invoiceDocId = null;
        let invoiceResult = null;
        let shipmentDocId = null;
        let shipmentResult = null;

        // Plan 28+ — sales_invoice (fatura) DRAFT akisi
        if (invoiceDraftMode !== 'disabled') {
            invoiceResult = await this.idempotency.ensureDraft({
                tenantId,
                sourceType: 'stockTransfer',
                sourceId: transferId,
                documentKind: 'invoice',
                data: baseDraftData,
            });
            invoiceDocId = invoiceResult.id;
        }

        // Plan 28++ — shipment_document (e-irsaliye) DRAFT akisi
        if (shipmentMode !== 'disabled') {
            // Plan 29 — ÇİFT TASLAK ÖNLEME: irsaliye taslağı artık sipariş anında
            // (ProductionOrderListener) üretiliyor. Aynı orderNumber (== transferNumber)
            // için sipariş-tetikli shipment doc VARSA yenisini üretme; yalnız linkle
            // ve gerçek sevkiyat zamanını (shippedAt) doc'a işle.
            const orderShipmentDoc = await this._findOrderShipmentDoc(tenantId, transfer.transferNumber || transfer.code);
            if (orderShipmentDoc) {
                shipmentDocId = orderShipmentDoc.id;
                await this.idempotency.update(orderShipmentDoc.id, {
                    // ShipmentProcessor.finalize bu alanla transferi 'completed' yapar.
                    sourceTransferId: transferId,
                    shipmentMeta: {
                        shippedAt: tsToMs(transfer.shippedAt),
                        shippedBy: transfer.preparedBy || transfer.shippedBy || null,
                        sourceBranchId: transfer.sourceBranchId || null,
                    },
                }).catch((e) => {
                    console.warn(`[StockTransferListener] could not link transfer ${transferId} to order doc ${orderShipmentDoc.id}:`, e.message);
                });
                await this.idempotency.appendAudit(orderShipmentDoc.id, 'transfer_linked', 'listener', {
                    transferId,
                    transferNumber: transfer.transferNumber || transfer.code || null,
                }).catch(() => {});
                console.log(`[StockTransferListener] transfer ${transferId} sipariş-tetikli doc ${orderShipmentDoc.id} ile eşleşti — yeni shipment draft üretilmedi`);
            } else {
                shipmentResult = await this.idempotency.ensureDraft({
                    tenantId,
                    sourceType: 'stockTransfer',
                    sourceId: transferId,
                    documentKind: 'shipment',
                    data: baseDraftData,
                });
                shipmentDocId = shipmentResult.id;
            }
        }

        // Mark transfer as queued (whether new or existing). parasutDocumentId
        // ile invoice doc'unu, parasutShipmentDocumentId ile shipment doc'unu referansla.
        try {
            const update = { parasutQueued: true };
            if (invoiceDocId) update.parasutDocumentId = invoiceDocId;
            if (shipmentDocId) update.parasutShipmentDocumentId = shipmentDocId;
            await docSnap.ref.update(update);
        } catch (e) {
            console.warn(`[StockTransferListener] could not mark transfer ${transferId} as queued:`, e.message);
        }

        // Plan 28+: Yeni yaratilan invoice draft icin Parasut'e taslak sales_invoice POST et.
        if (
            invoiceResult &&
            invoiceResult.existing === false &&
            this.providerFactory &&
            this.tokenManager &&
            this.contextLoader
        ) {
            await this._tryCreateParasutDraft({
                tenantId,
                docId: invoiceResult.id,
                transferId,
                transfer,
            });
        }

        // Plan 28++: 'auto' modda yeni shipment draft icin Parasut'a POST /shipment_documents.
        // 'manual' modda Firestore'da DRAFT olarak kalir, yetkili panelden tetikler.
        if (
            shipmentResult &&
            shipmentResult.existing === false &&
            shipmentMode === 'auto' &&
            this.providerFactory &&
            this.tokenManager &&
            this.contextLoader
        ) {
            await this._tryCreateParasutShipment({
                tenantId,
                docId: shipmentResult.id,
                transferId,
                transfer,
            });
        }

        // Plan 28: auto-enqueue intentionally removed.
        // Owner approval (panel "Onayla" -> POST /invoicing/draft/:id/approve)
        // is now the sole trigger for Parasut finalization (convert_to_invoice).
    }

    /**
     * Plan 29 — sipariş-tetikli (sourceType='productionOrder') shipment doc araması.
     * transferNumber, imalat-web buildTransferDoc'ta order.orderNumber'dan kopyalanır;
     * sipariş-anı taslağı da sourceTransferNumber=orderNumber yazar — eşleşme bu alandan.
     * Sorgu hatasında null döner (fail-open: eski transfer-tetikli davranış devam eder;
     * en kötü durumda çift taslak oluşur, veri kaybı olmaz).
     */
    async _findOrderShipmentDoc(tenantId, transferNumber) {
        if (!transferNumber) return null;
        try {
            const snap = await this.db.collection('invoiceDocuments')
                .where('tenantId', '==', tenantId)
                .where('documentKind', '==', 'shipment')
                .where('sourceType', '==', 'productionOrder')
                .where('sourceTransferNumber', '==', transferNumber)
                .limit(1)
                .get();
            if (snap.empty) return null;
            return { id: snap.docs[0].id, ...snap.docs[0].data() };
        } catch (e) {
            console.warn(`[StockTransferListener] order shipment doc lookup failed for ${transferNumber}: ${e.message}`);
            return null;
        }
    }

    /**
     * Plan 27 — IPTAL GUVENLIK AGI.
     * shipped sonrasi iptal edilen (status='cancelled', parasutQueued=true) bir transfer'in
     * iliskili invoiceDocuments belgelerini guvenle ele alir:
     *   - Belge KESILMEMIS (draft/pending_approval/approved/queued/failed):
     *       otomatik void -> status='cancelled'. Parasut'ta taslak varsa best-effort sil.
     *   - Belge KESILMIS (sent): durumu DEGISTIRME (GIB belgesi yasal olarak duruyor).
     *       cancellationRequested=true bayragi + audit + uyari -> manuel inceleme
     *       (iade faturasi / e-Arsiv iptali insan karari, runbook'a gore).
     *   - sending: mid-flight, dokunma (cancelled gecisi gecersiz) -> sadece bayrak+uyari.
     * Idempotency: transfer'e parasutCancellationHandled=true damgasi.
     */
    async _handleCancellation(docSnap) {
        const transfer = docSnap.data();
        const transferId = docSnap.id;

        if (transfer.parasutCancellationHandled === true) return;

        const docIds = [transfer.parasutDocumentId, transfer.parasutShipmentDocumentId]
            .filter((id) => typeof id === 'string' && id.length > 0);

        if (docIds.length === 0) {
            // Hicbir belge yaratilmamis (ornegin shipmentMode/invoiceDraftMode disabled).
            // Sadece damga vur, bir daha bakma.
            await this._markCancellationHandled(docSnap, { documents: 0 });
            return;
        }

        const tenantId = transfer.tenantId || null;
        const results = [];

        for (const docId of docIds) {
            try {
                const doc = await this.idempotency.getById(docId);
                if (!doc) {
                    results.push({ docId, action: 'missing' });
                    continue;
                }
                const status = doc.status;

                if (status === 'cancelled') {
                    results.push({ docId, action: 'already_cancelled' });
                    continue;
                }

                if (status === 'sent') {
                    // GIB'e kesilmis belge — OTOMATIK BOZMA. Manuel inceleme bayragi.
                    await this.idempotency.update(docId, {
                        cancellationRequested: true,
                        cancellationRequestedAt: Date.now(),
                        cancellationReason: 'source_transfer_cancelled',
                    });
                    await this.idempotency.appendAudit(docId, 'transfer_cancelled_after_sent', 'listener', {
                        transferId,
                        note: 'GIB belgesi kesilmis — iade faturasi / e-Arsiv iptali MANUEL inceleme gerekir',
                    }).catch(() => {});
                    console.warn(`[StockTransferListener] MANUAL REVIEW: transfer ${transferId} iptal edildi ama doc ${docId} status=sent — iade faturasi/e-Arsiv iptali manuel ele alinmali`);
                    results.push({ docId, action: 'flagged_manual_review' });
                    continue;
                }

                if (status === 'sending') {
                    // Mid-flight — gecis gecersiz, sadece bayrak.
                    await this.idempotency.update(docId, {
                        cancellationRequested: true,
                        cancellationRequestedAt: Date.now(),
                        cancellationReason: 'source_transfer_cancelled',
                    });
                    await this.idempotency.appendAudit(docId, 'transfer_cancelled_while_sending', 'listener', {
                        transferId,
                        note: 'Belge gonderiliyor — worker bittiginde tekrar degerlendirilmeli',
                    }).catch(() => {});
                    console.warn(`[StockTransferListener] transfer ${transferId} iptal edildi ama doc ${docId} status=sending — bayrak kondu`);
                    results.push({ docId, action: 'flagged_sending' });
                    continue;
                }

                // KESILMEMIS belge (draft/pending_approval/approved/queued/failed) — guvenli void.
                // Parasut'ta taslak fatura varsa best-effort sil (DELETE sadece taslak icin gecerli).
                if (doc.parasutInvoiceId && tenantId) {
                    await this._voidParasutDraft(tenantId, docId, doc.parasutInvoiceId);
                }

                const check = validateTransition(status, 'cancelled');
                if (!check.ok) {
                    console.warn(`[StockTransferListener] doc ${docId} ${check.reason} — bayrakla birakildi`);
                    await this.idempotency.update(docId, {
                        cancellationRequested: true,
                        cancellationRequestedAt: Date.now(),
                        cancellationReason: 'source_transfer_cancelled',
                    });
                    results.push({ docId, action: `invalid_transition:${status}` });
                    continue;
                }

                await this.idempotency.update(docId, {
                    status: 'cancelled',
                    cancellationReason: 'source_transfer_cancelled',
                    cancelledAt: Date.now(),
                });
                await this.idempotency.appendAudit(docId, 'transfer_cancelled_auto_void', 'listener', {
                    transferId,
                    fromStatus: status,
                }).catch(() => {});
                console.log(`[StockTransferListener] doc ${docId} (status=${status}) -> cancelled (transfer ${transferId} iptal)`);
                results.push({ docId, action: 'auto_voided', fromStatus: status });
            } catch (e) {
                console.warn(`[StockTransferListener] cancellation handling FAILED for doc ${docId}: ${e.message}`);
                results.push({ docId, action: 'error', error: e.message });
            }
        }

        await this._markCancellationHandled(docSnap, { documents: docIds.length, results });
    }

    /**
     * Parasut'ta KESILMEMIS taslak fatura'yi best-effort siler (DELETE /sales_invoices/{id}).
     * Hata fatal degil — Firestore void yine de ilerler, audit'e yazilir.
     */
    async _voidParasutDraft(tenantId, docId, parasutInvoiceId) {
        if (!this.providerFactory || !this.tokenManager) return;
        try {
            const provider = await this.providerFactory(tenantId);
            const token = await this.tokenManager.getValidToken(tenantId);
            await provider.cancelDocument(token, parasutInvoiceId, 'source_transfer_cancelled');
            await this.idempotency.appendAudit(docId, 'parasut_draft_deleted', 'listener', {
                parasutInvoiceId,
            }).catch(() => {});
            console.log(`[StockTransferListener] Parasut draft ${parasutInvoiceId} silindi (doc ${docId})`);
        } catch (e) {
            await this.idempotency.appendAudit(docId, 'parasut_draft_delete_failed', 'listener', {
                parasutInvoiceId,
                error: e.message,
                code: e.code,
                status: e.status,
            }).catch(() => {});
            console.warn(`[StockTransferListener] Parasut draft delete FAILED ${parasutInvoiceId} (doc ${docId}): ${e.message}`);
        }
    }

    async _markCancellationHandled(docSnap, meta) {
        try {
            await docSnap.ref.update({
                parasutCancellationHandled: true,
                parasutCancellationHandledAt: Date.now(),
            });
        } catch (e) {
            console.warn(`[StockTransferListener] could not mark transfer ${docSnap.id} cancellation-handled:`, e.message);
        }
    }

    /**
     * Plan 28++ — 'auto' modda Parasut'a shipment_document POST eder.
     * 'manual' modda CALMAZ — yetkili panelden tetiklenir.
     * Hata olursa sessizce devam eder (audit'e parasut_shipment_failed yazilir).
     */
    async _tryCreateParasutShipment({ tenantId, docId, transferId, transfer }) {
        try {
            const provider = await this.providerFactory(tenantId);
            const token = await this.tokenManager.getValidToken(tenantId);
            const ctx = await this.contextLoader(tenantId, {
                tenantId,
                sourceType: 'stockTransfer',
                sourceId: transferId,
                branchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId,
            });

            // Contact upsert (alici sube)
            const contact = await provider.upsertContact(token, {
                ...ctx.branch,
                id: ctx.branch.id || transfer.destinationBranchId || transfer.targetBranchId,
            });

            // Product upsert (kalemleri Parasut'a tani)
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
                console.warn(`[StockTransferListener] doc ${docId} has 0 valid items for Parasut shipment — skipping POST`);
                return;
            }

            const shipmentDate = new Date(tsToMs(transfer.shippedAt)).toISOString();

            const shipment = await provider.createShipmentDocument(token, {
                contactId: contact.contactId,
                items: itemsWithProductIds,
                issueDate: ctx.issueDate,
                shipmentDate,
                // description boş — Paraşüt default "Giden İrsaliye" başlığını kullansın.
                // procurement_number kasten gönderilmiyor — Paraşüt otomatik üretir (BR0...).
                address: ctx.branch && ctx.branch.address,
                city: ctx.branch && ctx.branch.city,
                district: ctx.branch && ctx.branch.district,
                inflow: false,
            });

            await this.idempotency.update(docId, {
                parasutShipmentId: shipment.providerShipmentId,
                parasutShipmentNumber: shipment.shipmentNumber,
                parasutContactId: contact.contactId,
                pdfUrl: shipment.pdfUrl,
                parasutShipmentCreatedAt: Date.now(),
            });
            await this.idempotency.appendAudit(docId, 'parasut_shipment_created', 'listener', {
                parasutShipmentId: shipment.providerShipmentId,
                items: itemsWithProductIds.length,
            }).catch(() => {});

            console.log(`[StockTransferListener] Parasut shipment created for ${docId} -> parasutShipmentId=${shipment.providerShipmentId}`);
        } catch (e) {
            console.warn(`[StockTransferListener] Parasut shipment create FAILED for ${docId}: ${e.reqMethod || ''} ${e.reqUrl || ''} -> ${e.status} ${e.message} (code=${e.code || '?'})`);
            if (e.providerPayload) {
                console.warn(`[StockTransferListener]   Parasut payload:`, JSON.stringify(e.providerPayload).slice(0, 800));
            }
            await this.idempotency.appendAudit(docId, 'parasut_shipment_failed', 'listener', {
                error: e.message,
                code: e.code,
                status: e.status,
                reqUrl: e.reqUrl,
                reqMethod: e.reqMethod,
                providerPayload: e.providerPayload ? JSON.stringify(e.providerPayload).slice(0, 1000) : null,
            }).catch(() => {});
        }
    }

    async _tryCreateParasutDraft({ tenantId, docId, transferId, transfer }) {
        try {
            const provider = await this.providerFactory(tenantId);
            const token = await this.tokenManager.getValidToken(tenantId);
            const ctx = await this.contextLoader(tenantId, {
                tenantId,
                sourceType: 'stockTransfer',
                sourceId: transferId,
                branchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId,
            });

            // Contact upsert (alici sube)
            const contact = await provider.upsertContact(token, {
                ...ctx.branch,
                id: ctx.branch.id || transfer.destinationBranchId || transfer.targetBranchId,
            });

            // Product upsert (kalemleri Parasut'a tani)
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
                    unit: it.unit || 'Adet',
                });
            }

            if (itemsWithProductIds.length === 0) {
                console.warn(`[StockTransferListener] doc ${docId} has 0 valid items for Parasut draft — skipping POST`);
                return;
            }

            const draft = await provider.createDraftInvoice(token, {
                contactId: contact.contactId,
                items: itemsWithProductIds,
                currency: ctx.currency || 'TRL',
                issueDate: ctx.issueDate,
                invoiceSeries: ctx.invoiceSeriesPrefix,
                description: ctx.description,
                shipmentIncluded: !!ctx.shipmentIncluded,
                orderNo: transfer.transferNumber || transfer.code,
                orderDate: ctx.issueDate,
            });

            await this.idempotency.update(docId, {
                parasutInvoiceId: draft.providerInvoiceId,
                parasutPdfUrl: draft.pdfUrl,
                parasutDraftCreatedAt: Date.now(),
            });
            await this.idempotency.appendAudit(docId, 'parasut_draft_created', 'listener', {
                parasutInvoiceId: draft.providerInvoiceId,
                items: itemsWithProductIds.length,
            }).catch(() => {});

            console.log(`[StockTransferListener] Parasut draft created for ${docId} -> parasutInvoiceId=${draft.providerInvoiceId}`);
        } catch (e) {
            // Sessiz fallback: yetkili onay aninda eski createInvoice yolu calisir.
            console.warn(`[StockTransferListener] Parasut draft create FAILED for ${docId}: ${e.reqMethod || ''} ${e.reqUrl || ''} -> ${e.status} ${e.message} (code=${e.code || '?'})`);
            if (e.providerPayload) {
                console.warn(`[StockTransferListener]   Parasut payload:`, JSON.stringify(e.providerPayload).slice(0, 800));
            }
            await this.idempotency.appendAudit(docId, 'parasut_draft_failed', 'listener', {
                error: e.message,
                code: e.code,
                status: e.status,
                reqUrl: e.reqUrl,
                reqMethod: e.reqMethod,
                providerPayload: e.providerPayload ? JSON.stringify(e.providerPayload).slice(0, 1000) : null,
            }).catch(() => {});
        }
    }
}

module.exports = StockTransferListener;
