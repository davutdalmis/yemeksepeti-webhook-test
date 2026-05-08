// ==================================================================================
// StockTransferListener — Firestore listener: stockTransfers.status='shipped'
// ==================================================================================
// Plan 27 Faz 2.1, Plan 28 Faz 1.1.3, Plan 28+ (e-fatura taslak) ile guncellendi.
// Yeni shipped doc gelince:
//   1. Tenant settings yukle (invoicingCredentials/{tenantId}/providers/parasut)
//   2. isEnabled false -> skip
//   3. IdempotencyService ile invoiceDocuments draft olustur (race-safe)
//   4. **Plan 28+**: Eger providerFactory + tokenManager + contextLoader verilmisse,
//      Parasut'e dogrudan taslak sales_invoice POST eder (e-belge degil, GİB'e gitmez)
//      ve parasutInvoiceId + parasutPdfUrl alanlarini Firestore'a yazar.
//      Sevkiyatci PDF link'ini hemen alabilsin diye. Hata olursa sessizce devam eder
//      (yetkili onay aninda eski createInvoice yolu fallback olarak calisir).
//   5. stockTransfer dok'una parasutQueued=true yaz (re-process onle)
// Plan 28: 'auto' modda dahi otomatik KUYRUGA ALMAZ. Yetkili panelden onaylayinca
// engine /invoicing/draft/:id/approve endpoint'i tetiklenir.
// ==================================================================================

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
        const shipmentMeta = {
            shippedAt: transfer.shippedAt || Date.now(),
            shippedBy: transfer.preparedBy || transfer.shippedBy || null,
            sourceBranchId: transfer.sourceBranchId || null,
            targetBranchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId || null,
            targetBranchName: transfer.targetBranchName || null,
        };

        // Create draft via idempotency service
        const result = await this.idempotency.ensureDraft({
            tenantId,
            sourceType: 'stockTransfer',
            sourceId: transferId,
            data: {
                branchId: transfer.destinationBranchId || transfer.targetBranchId || transfer.branchId,
                provider: 'parasut',
                sourceTransferNumber: transfer.transferNumber || transfer.code,
                amount: transfer.totalAmount || 0,
                currency: transfer.currency || 'TRL',
                documentType: settings.defaultDocumentType || 'sales_invoice',
                shipmentIncluded: !!settings.shipmentIncludedDefault,
                items: itemsSnapshot,
                shipmentMeta,
            },
        });

        // Mark transfer as queued (whether new or existing)
        try {
            await docSnap.ref.update({ parasutQueued: true, parasutDocumentId: result.id });
        } catch (e) {
            console.warn(`[StockTransferListener] could not mark transfer ${transferId} as queued:`, e.message);
        }

        // Plan 28+: Yeni yaratilan draft icin Parasut'e taslak sales_invoice POST et.
        // Mevcut belge ise (existing=true) atla — onceden taslak Parasut'te var demek.
        if (
            result.existing === false &&
            this.providerFactory &&
            this.tokenManager &&
            this.contextLoader
        ) {
            await this._tryCreateParasutDraft({
                tenantId,
                docId: result.id,
                transferId,
                transfer,
            });
        }

        // Plan 28: auto-enqueue intentionally removed.
        // Owner approval (panel "Onayla" -> POST /invoicing/draft/:id/approve)
        // is now the sole trigger for Parasut finalization (convert_to_invoice).
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
