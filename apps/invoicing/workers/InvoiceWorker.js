// ==================================================================================
// InvoiceWorker — BullMQ worker that processes invoice jobs end-to-end
// ==================================================================================
// Plan 27 Faz 2.2 + 2.3 + 2.5.
// Pipeline:
//   1. Idempotency check (already-sent? skip)
//   2. Rate limit check
//   3. Get token (TokenManager)
//   4. upsertContact for branch
//   5. upsertProducts for items
//   6. createInvoice
//   7. Update Firestore doc status=sent + audit log
// Hata siniflandirma RetryPolicy ile yapilir; BullMQ exp backoff retry'i kendi yonetir.
// ==================================================================================

const { classify } = require('../lib/RetryPolicy');

const DEFAULT_CONCURRENCY = 5;

class InvoiceWorker {
    /**
     * @param {object} deps
     * @param {object} deps.connection  ioredis-uyumlu (BullMQ icin)
     * @param {object} deps.idempotency  IdempotencyService
     * @param {object} deps.tokenManager TokenManager
     * @param {object} deps.rateLimiter  RateLimiter
     * @param {(tenantId: string) => Promise<object>} deps.providerFactory
     * @param {(tenantId: string) => Promise<object>} deps.tenantSettingsLoader  -> branch + items info loader
     * @param {string} [deps.queueName]
     * @param {number} [deps.concurrency]
     */
    constructor({ connection, idempotency, tokenManager, rateLimiter, providerFactory, tenantSettingsLoader, queueName = 'parasut-invoices', concurrency = DEFAULT_CONCURRENCY, enableBullMQ }) {
        if (!connection) throw new Error('InvoiceWorker: connection required');
        this.idempotency = idempotency;
        this.tokenManager = tokenManager;
        this.rateLimiter = rateLimiter;
        this.providerFactory = providerFactory;
        this.tenantSettingsLoader = tenantSettingsLoader;
        this.queueName = queueName;
        this.concurrency = concurrency;
        this.worker = null;
        this.available = false;

        // Skip BullMQ Worker init if explicitly disabled or connection is not an ioredis-like object.
        // Lets _handler() be unit-tested without spinning up a real Redis listener.
        const isIoredisLike = connection && typeof connection.duplicate === 'function' && typeof connection.status === 'string';
        const shouldStart = enableBullMQ !== false && isIoredisLike;

        if (!shouldStart) {
            return;
        }

        try {
            const { Worker } = require('bullmq');
            this.worker = new Worker(queueName, this._handler.bind(this), { connection, concurrency });
            this._wireEvents();
            this.available = true;
        } catch (e) {
            console.warn('[InvoiceWorker] BullMQ Worker init failed:', e.message);
        }
    }

    _wireEvents() {
        this.worker.on('failed', (job, err) => {
            const cls = classify(err);
            console.warn(
                `[InvoiceWorker] job ${job ? job.id : '?'} failed (attempt ${job ? job.attemptsMade : '?'}) kind=${cls.kind} msg=${err.message}`
            );
        });
        this.worker.on('completed', (job) => {
            console.log(`[InvoiceWorker] job ${job.id} completed`);
        });
        this.worker.on('error', (err) => {
            console.error('[InvoiceWorker] worker error:', err.message);
        });
    }

    async _handler(job) {
        const { documentId, tenantId } = job.data || {};
        if (!documentId || !tenantId) throw new Error('InvoiceWorker: documentId + tenantId required');

        // 1. Idempotency check — already sent?
        const doc = await this.idempotency.getById(documentId);
        if (!doc) {
            throw new Error(`Document ${documentId} not found`);
        }
        if (doc.status === 'sent' || doc.status === 'cancelled') {
            console.log(`[InvoiceWorker] doc ${documentId} already in status=${doc.status}, skipping`);
            return { skipped: true, reason: doc.status };
        }

        // 2. Rate limit
        if (this.rateLimiter) {
            const rl = await this.rateLimiter.tryAcquire(tenantId);
            if (!rl.allowed) {
                const e = new Error('rate_limited');
                e.status = 429;
                e.retryAfterMs = rl.retryAfterMs;
                throw e; // BullMQ will retry per backoff schedule
            }
        }

        // 3. Mark sending
        await this.idempotency.update(documentId, { status: 'sending' });
        await this.idempotency.appendAudit(documentId, 'sending_started', 'invoicing-engine', { attempt: job.attemptsMade });

        // 4. Token + provider
        const provider = await this.providerFactory(tenantId);

        let token;
        try {
            token = await this.tokenManager.getValidToken(tenantId);
        } catch (e) {
            await this.idempotency.update(documentId, {
                status: 'failed',
                lastError: { message: e.message, code: e.code || 'TOKEN_FAIL', ts: Date.now() },
                errorCount: (doc.errorCount || 0) + 1,
            });
            throw e;
        }

        try {
            // 5. Load business context (branch + items + settings)
            const ctx = await this.tenantSettingsLoader(tenantId, doc);

            // 6. upsertContact
            const contact = await provider.upsertContact(token, ctx.branch);

            // 7. upsertProducts (per item)
            const itemsWithProductIds = [];
            for (const it of ctx.items) {
                const p = await provider.upsertProduct(token, it);
                itemsWithProductIds.push({ ...it, productId: p.productId });
            }

            // 8. createInvoice
            const invoice = await provider.createInvoice(token, {
                contactId: contact.contactId,
                items: itemsWithProductIds,
                currency: ctx.currency || 'TRL',
                issueDate: ctx.issueDate,
                shipmentIncluded: ctx.shipmentIncluded,
                documentType: ctx.documentType || 'sales_invoice',
                description: ctx.description,
                invoiceSeries: ctx.invoiceSeriesPrefix,
            });

            // 9. Update Firestore doc -> sent
            await this.idempotency.update(documentId, {
                status: 'sent',
                provider: provider.providerName,
                parasutInvoiceId: invoice.providerInvoiceId,
                parasutEArchiveId: invoice.eArchiveId,
                parasutContactId: contact.contactId,
                invoiceNumber: invoice.invoiceNumber,
                pdfUrl: invoice.pdfUrl,
            });
            await this.idempotency.appendAudit(documentId, 'sent_to_parasut', 'invoicing-engine', {
                invoiceId: invoice.providerInvoiceId,
            });

            return { ok: true, invoiceId: invoice.providerInvoiceId };
        } catch (err) {
            const cls = classify(err);
            if (cls.authError) {
                await this.tokenManager.invalidateToken(tenantId).catch(() => {});
            }
            await this.idempotency.update(documentId, {
                status: cls.retryable ? 'queued' : 'failed',
                lastError: {
                    message: err.message,
                    code: err.code || cls.kind,
                    status: err.status || null,
                    ts: Date.now(),
                },
                errorCount: (doc.errorCount || 0) + 1,
            });
            await this.idempotency.appendAudit(documentId, 'send_failed', 'invoicing-engine', {
                attempt: job.attemptsMade,
                kind: cls.kind,
                message: err.message,
            });
            throw err;
        }
    }

    async close() {
        if (this.worker) await this.worker.close();
    }
}

module.exports = InvoiceWorker;
