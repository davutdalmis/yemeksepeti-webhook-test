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
    constructor({ db, idempotency, queue, settingsLoader, collection = 'stockTransfers', providerFactory, tokenManager, contextLoader }) {
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
        this._unsubscribe = null;
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
    }

    stop() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
            console.log('[StockTransferListener] unsubscribed');
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
            shipmentResult = await this.idempotency.ensureDraft({
                tenantId,
                sourceType: 'stockTransfer',
                sourceId: transferId,
                documentKind: 'shipment',
                data: baseDraftData,
            });
            shipmentDocId = shipmentResult.id;
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
                description: ctx.description,
                address: ctx.branch && ctx.branch.address,
                city: ctx.branch && ctx.branch.city,
                district: ctx.branch && ctx.branch.district,
                procurementNumber: transfer.transferNumber || transfer.code,
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
