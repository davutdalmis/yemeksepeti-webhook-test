// ==================================================================================
// InvoiceQueue — BullMQ wrapper for invoice processing jobs
// ==================================================================================
// Plan 27 Faz 2.2 + 2.6.
// Queue: parasut-invoices
// DLQ: parasut-invoices job'lar BullMQ'nun built-in failed job state'inde tutulur (ekstra DLQ kuyrugu yok).
// ==================================================================================

const QUEUE_NAME = 'parasut-invoices';

class InvoiceQueue {
    /**
     * @param {object} deps
     * @param {object} deps.connection ioredis-uyumlu client (BullMQ icin)
     */
    constructor({ connection, queueName = QUEUE_NAME }) {
        if (!connection) throw new Error('InvoiceQueue: connection required');
        this.queueName = queueName;
        this.connection = connection;
        this.queue = null;
        try {
            const { Queue } = require('bullmq');
            this.queue = new Queue(queueName, {
                connection,
                defaultJobOptions: {
                    attempts: 4,
                    backoff: { type: 'exponential', delay: 5000 },
                    removeOnComplete: { age: 24 * 3600, count: 1000 },
                    removeOnFail: { age: 7 * 24 * 3600 },
                },
            });
            this.available = true;
        } catch (e) {
            console.warn('[InvoiceQueue] BullMQ init failed (Redis required for production):', e.message);
            this.available = false;
        }
    }

    /**
     * Enqueue an invoice job.
     * @param {object} data { documentId, tenantId, sourceTransferId }
     */
    async add(data) {
        if (!this.available) {
            throw new Error('InvoiceQueue not available — real Redis required');
        }
        if (!data || !data.documentId || !data.tenantId) {
            throw new Error('InvoiceQueue.add: documentId + tenantId required');
        }
        const jobId = data.documentId; // idempotent at queue level too
        return await this.queue.add('process', data, { jobId });
    }

    async getJob(jobId) {
        if (!this.available) return null;
        return await this.queue.getJob(jobId);
    }

    async listFailed(start = 0, end = 50) {
        if (!this.available) return [];
        return await this.queue.getFailed(start, end);
    }

    async retry(jobId) {
        if (!this.available) return { ok: false, reason: 'queue_not_available' };
        const job = await this.queue.getJob(jobId);
        if (!job) return { ok: false, reason: 'not_found' };
        await job.retry();
        return { ok: true };
    }

    async cancel(jobId) {
        if (!this.available) return { ok: false, reason: 'queue_not_available' };
        const job = await this.queue.getJob(jobId);
        if (!job) return { ok: false, reason: 'not_found' };
        await job.remove();
        return { ok: true };
    }

    async stats() {
        if (!this.available) return { available: false };
        const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        return { available: true, queueName: this.queueName, ...counts };
    }

    async close() {
        if (this.queue) await this.queue.close();
    }
}

module.exports = { InvoiceQueue, QUEUE_NAME };
