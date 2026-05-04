// End-to-end worker pipeline test using mocks.
// BullMQ Worker is bypassed by calling _handler directly (no Redis required).

const InvoiceWorker = require('../workers/InvoiceWorker');
const { IdempotencyService } = require('../lib/IdempotencyService');
const MockInvoiceProvider = require('../providers/MockInvoiceProvider');

function isArrayUnionSentinel(v) {
    if (!v || typeof v !== 'object') return false;
    const ctor = v.constructor && v.constructor.name;
    return ctor === 'ArrayUnionTransform' || ctor === 'ArrayUnionFieldValueImpl' || '_elements' in v;
}

function applyUpdate(existing, patch) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
        if (isArrayUnionSentinel(v)) {
            const elements = v._elements || v.elements || [];
            const cur = Array.isArray(out[k]) ? out[k] : [];
            out[k] = [...cur, ...elements];
        } else {
            out[k] = v;
        }
    }
    return out;
}

function makeFakeDb() {
    const store = new Map();
    return {
        collection(coll) {
            return {
                doc(id) {
                    const key = `${coll}/${id}`;
                    return {
                        get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
                        create: async (d) => {
                            if (store.has(key)) {
                                const e = new Error('exists');
                                e.code = 6;
                                throw e;
                            }
                            store.set(key, d);
                        },
                        set: async (d, opts) => {
                            const merged = opts && opts.merge ? applyUpdate(store.get(key) || {}, d) : d;
                            store.set(key, merged);
                        },
                        update: async (d) => {
                            if (!store.has(key)) throw new Error('not found');
                            store.set(key, applyUpdate(store.get(key), d));
                        },
                    };
                },
            };
        },
        _store: store,
    };
}

function makeWorker(overrides = {}) {
    const db = overrides.db || makeFakeDb();
    const idempotency = new IdempotencyService({ db });
    const mock = overrides.provider || new MockInvoiceProvider();
    const tokenManager = overrides.tokenManager || {
        getValidToken: async () => 'mock-token',
        invalidateToken: async () => {},
    };
    const w = new InvoiceWorker({
        connection: {},
        idempotency,
        tokenManager,
        rateLimiter: null,
        providerFactory: async () => mock,
        tenantSettingsLoader: overrides.contextLoader || (async () => ({
            branch: { name: 'Sube X', taxNumber: '1234567890' },
            items: [{ name: 'Urun', quantity: 2, unitPrice: 50, vatRate: 20 }],
            currency: 'TRL',
            issueDate: '2026-05-04',
            shipmentIncluded: true,
            documentType: 'sales_invoice',
        })),
    });
    return { worker: w, idempotency, mock, db };
}

async function seed(db, idempotency, tenantId, sourceId) {
    const r = await idempotency.ensureDraft({
        tenantId,
        sourceType: 'stockTransfer',
        sourceId,
        data: { branchId: 'b1', amount: 100 },
    });
    return r.id;
}

describe('InvoiceWorker._handler', () => {
    test('happy path: contact + product + invoice + status=sent', async () => {
        const { worker, idempotency, mock, db } = makeWorker();
        const docId = await seed(db, idempotency, 't1', 'TR-1');
        const job = { id: docId, data: { documentId: docId, tenantId: 't1' }, attemptsMade: 1 };

        const result = await worker._handler(job);
        expect(result.ok).toBe(true);
        expect(mock.calls.upsertContact).toBe(1);
        expect(mock.calls.upsertProduct).toBe(1);
        expect(mock.calls.createInvoice).toBe(1);

        const final = await idempotency.getById(docId);
        expect(final.status).toBe('sent');
        expect(final.parasutInvoiceId).toMatch(/^mock-invoice-/);
        expect(final.audit.some((a) => a.event === 'sent_to_parasut')).toBe(true);
    });

    test('skips already-sent doc', async () => {
        const { worker, idempotency, mock, db } = makeWorker();
        const docId = await seed(db, idempotency, 't1', 'TR-2');
        await idempotency.update(docId, { status: 'sent' });

        const result = await worker._handler({ id: docId, data: { documentId: docId, tenantId: 't1' }, attemptsMade: 1 });
        expect(result.skipped).toBe(true);
        expect(mock.calls.createInvoice).toBe(0);
    });

    test('provider failure -> status=failed/queued + audit + rethrow', async () => {
        const mock = new MockInvoiceProvider();
        const { worker, idempotency, db } = makeWorker({ provider: mock });
        const docId = await seed(db, idempotency, 't1', 'TR-3');

        // Inject failure on first createInvoice call
        const origCreate = mock.createInvoice.bind(mock);
        mock.createInvoice = async () => {
            const e = new Error('parasut down');
            e.status = 503;
            throw e;
        };

        await expect(worker._handler({ id: docId, data: { documentId: docId, tenantId: 't1' }, attemptsMade: 1 })).rejects.toMatchObject({ status: 503 });

        const final = await idempotency.getById(docId);
        expect(final.status).toBe('queued'); // retryable
        expect(final.errorCount).toBe(1);
        expect(final.audit.some((a) => a.event === 'send_failed')).toBe(true);
    });

    test('401 from token call invalidates token', async () => {
        const invalidate = jest.fn(async () => {});
        const tokenManager = {
            getValidToken: async () => 'x',
            invalidateToken: invalidate,
        };
        const mock = new MockInvoiceProvider();
        mock.upsertContact = async () => {
            const e = new Error('unauthorized');
            e.status = 401;
            throw e;
        };
        const { worker, idempotency, db } = makeWorker({ tokenManager, provider: mock });
        const docId = await seed(db, idempotency, 't1', 'TR-4');

        await expect(worker._handler({ id: docId, data: { documentId: docId, tenantId: 't1' }, attemptsMade: 1 })).rejects.toMatchObject({ status: 401 });
        expect(invalidate).toHaveBeenCalledWith('t1');
    });

    test('rate limit blocks job', async () => {
        const rateLimiter = { tryAcquire: async () => ({ allowed: false, remaining: 0, retryAfterMs: 1000 }) };
        const db = makeFakeDb();
        const idempotency = new IdempotencyService({ db });
        const mock = new MockInvoiceProvider();
        const w = new InvoiceWorker({
            connection: {},
            idempotency,
            tokenManager: { getValidToken: async () => 'x', invalidateToken: async () => {} },
            rateLimiter,
            providerFactory: async () => mock,
            tenantSettingsLoader: async () => ({ branch: {}, items: [] }),
        });
        const docId = await seed(db, idempotency, 't1', 'TR-5');
        await expect(w._handler({ id: docId, data: { documentId: docId, tenantId: 't1' }, attemptsMade: 1 })).rejects.toMatchObject({ status: 429 });
        expect(mock.calls.createInvoice).toBe(0);
    });
});
