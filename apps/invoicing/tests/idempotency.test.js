const { IdempotencyService, buildIdempotencyKey } = require('../lib/IdempotencyService');

// Minimal Firestore-API mock
function makeFakeDb() {
    const store = new Map();
    function refFor(coll, id) {
        const key = `${coll}/${id}`;
        return {
            get: async () => ({
                exists: store.has(key),
                data: () => store.get(key),
            }),
            create: async (data) => {
                if (store.has(key)) {
                    const e = new Error('already exists');
                    e.code = 6;
                    throw e;
                }
                store.set(key, data);
            },
            set: async (data, opts) => {
                if (opts && opts.merge && store.has(key)) {
                    store.set(key, { ...store.get(key), ...data });
                } else {
                    store.set(key, data);
                }
            },
            update: async (data) => {
                if (!store.has(key)) throw new Error('not found');
                store.set(key, { ...store.get(key), ...data });
            },
        };
    }
    return {
        _store: store,
        collection(coll) {
            return { doc: (id) => refFor(coll, id) };
        },
    };
}

describe('buildIdempotencyKey', () => {
    test('deterministic from inputs', () => {
        const k1 = buildIdempotencyKey({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1' });
        const k2 = buildIdempotencyKey({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1' });
        expect(k1).toBe(k2);
    });

    test('different inputs produce different keys', () => {
        const k1 = buildIdempotencyKey({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1' });
        const k2 = buildIdempotencyKey({ tenantId: 't2', sourceType: 'stockTransfer', sourceId: 'TR-1' });
        expect(k1).not.toBe(k2);
    });

    test('throws on missing parts', () => {
        expect(() => buildIdempotencyKey({})).toThrow();
        expect(() => buildIdempotencyKey({ tenantId: 't' })).toThrow();
    });
});

describe('IdempotencyService.ensureDraft', () => {
    test('creates draft on first call', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        const r = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1', data: { amount: 100 } });
        expect(r.existing).toBe(false);
        expect(r.doc.amount).toBe(100);
        expect(r.doc.status).toBe('draft');
    });

    test('second call returns existing (no duplicate)', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1', data: {} });
        const r2 = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1', data: {} });
        expect(r2.existing).toBe(true);
    });

    test('different sourceId produces different doc', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        const a = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1', data: {} });
        const b = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-2', data: {} });
        expect(a.id).not.toBe(b.id);
        expect(a.existing).toBe(false);
        expect(b.existing).toBe(false);
    });

    test('different tenant produces different doc (cross-tenant isolation)', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        const a = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'TR-1', data: {} });
        const b = await svc.ensureDraft({ tenantId: 't2', sourceType: 'stockTransfer', sourceId: 'TR-1', data: {} });
        expect(a.id).not.toBe(b.id);
    });
});

describe('IdempotencyService.getById/update', () => {
    test('round-trip', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        const r = await svc.ensureDraft({ tenantId: 't1', sourceType: 'stockTransfer', sourceId: 'X', data: {} });
        await svc.update(r.id, { status: 'sent' });
        const fetched = await svc.getById(r.id);
        expect(fetched.status).toBe('sent');
    });

    test('getById returns null for unknown', async () => {
        const db = makeFakeDb();
        const svc = new IdempotencyService({ db });
        expect(await svc.getById('nope')).toBe(null);
    });
});
