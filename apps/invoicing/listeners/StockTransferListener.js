// ==================================================================================
// StockTransferListener — Firestore listener: stockTransfers.status='shipped'
// ==================================================================================
// Plan 27 Faz 2.1.
// Yeni shipped doc gelince:
//   1. Tenant settings'i yukle (invoicingCredentials/{tenantId}/providers/parasut)
//   2. isEnabled false -> skip
//   3. IdempotencyService ile invoiceDocuments draft olustur (race-safe)
//   4. automationMode='auto' -> kuyruga ekle
//      automationMode='manual' -> sadece draft, panel'den onay bekler
//   5. stockTransfer dok'una parasutQueued=true yaz (re-process onle)
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

        // Create draft via idempotency service
        const result = await this.idempotency.ensureDraft({
            tenantId,
            sourceType: 'stockTransfer',
            sourceId: transferId,
            data: {
                branchId: transfer.destinationBranchId || transfer.branchId,
                provider: 'parasut',
                sourceTransferNumber: transfer.transferNumber || transfer.code,
                amount: transfer.totalAmount || 0,
                currency: transfer.currency || 'TRL',
                documentType: settings.defaultDocumentType || 'sales_invoice',
                shipmentIncluded: !!settings.shipmentIncludedDefault,
            },
        });

        // Mark transfer as queued (whether new or existing)
        try {
            await docSnap.ref.update({ parasutQueued: true, parasutDocumentId: result.id });
        } catch (e) {
            console.warn(`[StockTransferListener] could not mark transfer ${transferId} as queued:`, e.message);
        }

        // Auto-mode: enqueue immediately
        if (!result.existing && settings.automationMode === 'auto' && this.queue && this.queue.available) {
            try {
                await this.queue.add({ documentId: result.id, tenantId, sourceTransferId: transferId });
                await this.idempotency.appendAudit(result.id, 'queued', 'StockTransferListener', { auto: true });
            } catch (e) {
                console.error(`[StockTransferListener] enqueue failed for doc ${result.id}:`, e.message);
            }
        }
    }
}

module.exports = StockTransferListener;
