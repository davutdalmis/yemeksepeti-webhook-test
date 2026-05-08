// ==================================================================================
// StockTransferListener — Firestore listener: stockTransfers.status='shipped'
// ==================================================================================
// Plan 27 Faz 2.1, Plan 28 Faz 1.1.3 ile guncellendi.
// Yeni shipped doc gelince:
//   1. Tenant settings'i yukle (invoicingCredentials/{tenantId}/providers/parasut)
//   2. isEnabled false -> skip
//   3. IdempotencyService ile invoiceDocuments draft olustur (race-safe)
//   4. stockTransfer dok'una parasutQueued=true yaz (re-process onle)
// Plan 28: artik 'auto' modda dahi otomatik kuyruga ALMAZ. Yetkili panelden
// onaylayinca engine /invoicing/draft/:id/approve endpoint'i tetiklenir,
// queued/sent gecisleri orada yapilir. automationMode bu noktada read-only kalsin.
// ==================================================================================

class StockTransferListener {
    /**
     * @param {object} deps
     * @param {object} deps.db Firestore db
     * @param {object} deps.idempotency  IdempotencyService
     * @param {object} deps.queue  InvoiceQueue
     * @param {(tenantId: string) => Promise<object>} deps.settingsLoader  -> { isEnabled, automationMode, defaultDocumentType, ... }
     * @param {string} [deps.collection]  default 'stockTransfers'
     */
    constructor({ db, idempotency, queue, settingsLoader, collection = 'stockTransfers' }) {
        if (!db) throw new Error('StockTransferListener: db required');
        if (!idempotency) throw new Error('StockTransferListener: idempotency required');
        if (!settingsLoader) throw new Error('StockTransferListener: settingsLoader required');
        this.db = db;
        this.idempotency = idempotency;
        this.queue = queue;
        this.settingsLoader = settingsLoader;
        this.collection = collection;
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

        // Plan 28: auto-enqueue intentionally removed.
        // Owner approval (panel "Onayla" -> POST /invoicing/draft/:id/approve)
        // is now the sole trigger for Parasut POST. Draft remains in 'draft' status
        // until pending_approval -> approved -> queued path runs in approve handler.
    }
}

module.exports = StockTransferListener;
