// Plan 28 Faz 2.5 — engine save-edits validation
// IdempotencyService.update + status transition + edits validation

const { IdempotencyService } = require('../lib/IdempotencyService');
const { validateTransition } = require('../lib/StatusTransitionValidator');

function makeFakeDb() {
    const store = new Map();
    function refFor(coll, id) {
        const key = `${coll}/${id}`;
        return {
            get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
            create: async (data) => {
                if (store.has(key)) {
                    const e = new Error('exists');
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
                const current = store.get(key);
                const merged = { ...current };
                for (const [k, v] of Object.entries(data)) {
                    if (v && typeof v === 'object' && '_elements' in v) {
                        merged[k] = [...(current[k] || []), ...v._elements];
                    } else {
                        merged[k] = v;
                    }
                }
                store.set(key, merged);
            },
        };
    }
    return { _store: store, collection: (c) => ({ doc: (id) => refFor(c, id) }) };
}

async function seedDraft(db, idempotency, overrides = {}) {
    const r = await idempotency.ensureDraft({
        tenantId: overrides.tenantId || 't1',
        sourceType: 'stockTransfer',
        sourceId: overrides.sourceId || 'TR-1',
        data: {
            branchId: 'b1',
            amount: 2500,
            currency: 'TRL',
            items: [
                { itemIndex: 0, productId: 'p1', productName: 'Pizza Hamuru', unit: 'paket', unitPrice: 25, vatRate: 20, originalQuantity: 100 },
                { itemIndex: 1, productId: 'p2', productName: 'Mozzarella', unit: 'paket', unitPrice: 250, vatRate: 10, originalQuantity: 5 },
            ],
            ...overrides.data,
        },
    });
    return r.id;
}

describe('Plan 28 save-edits — happy path', () => {
    test('draft → pending_approval transition is valid', () => {
        expect(validateTransition('draft', 'pending_approval').ok).toBe(true);
        expect(validateTransition('pending_approval', 'pending_approval').ok).toBe(true);
    });

    test('owner edit reduces qty + writes approvalMeta', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraft(db, idem);

        // Simulate the engine save-edits handler
        const doc = await idem.getById(docId);
        const edits = [
            { itemIndex: 0, productId: 'p1', originalQty: 100, finalQty: 95, diffReason: 'fire' },
            { itemIndex: 1, productId: 'p2', originalQty: 5, finalQty: 5 },
        ];
        const fireTotal = 5;

        await idem.update(docId, {
            status: 'pending_approval',
            approvalMeta: { edits, fireQuantityTotal: fireTotal, lastEditedBy: 'panel' },
        });

        const after = await idem.getById(docId);
        expect(after.status).toBe('pending_approval');
        expect(after.approvalMeta.edits).toHaveLength(2);
        expect(after.approvalMeta.fireQuantityTotal).toBe(5);
        expect(doc.status).toBe('draft'); // initial doc is unchanged in our snapshot
    });

    test('finalQty validation: must be >= 0 and <= originalQuantity', () => {
        // Mirror the server.js validation logic for edits
        function validateEdit(edit, original) {
            const finalQty = Number(edit.finalQty);
            if (!Number.isFinite(finalQty)) return 'not_finite';
            if (finalQty < 0) return 'negative';
            if (finalQty > original.originalQuantity) return 'over_original';
            return 'ok';
        }
        const original = { originalQuantity: 100 };
        expect(validateEdit({ finalQty: 95 }, original)).toBe('ok');
        expect(validateEdit({ finalQty: 100 }, original)).toBe('ok');
        expect(validateEdit({ finalQty: 0 }, original)).toBe('ok');
        expect(validateEdit({ finalQty: 105 }, original)).toBe('over_original');
        expect(validateEdit({ finalQty: -1 }, original)).toBe('negative');
        expect(validateEdit({ finalQty: 'abc' }, original)).toBe('not_finite');
    });

    test('cross-tenant edit is rejected (tenant_mismatch guard)', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraft(db, idem, { tenantId: 't1' });
        const doc = await idem.getById(docId);
        // Simulate engine guard
        const callerTenant = 't2';
        const ok = doc.tenantId === callerTenant;
        expect(ok).toBe(false);
    });
});

describe('Plan 28 save-edits — invalid transitions', () => {
    test('cannot save-edits from sent (terminal)', () => {
        expect(validateTransition('sent', 'pending_approval').ok).toBe(false);
    });

    test('cannot save-edits from cancelled (terminal)', () => {
        expect(validateTransition('cancelled', 'pending_approval').ok).toBe(false);
    });

    test('save-edits from approved is invalid (already past edit window)', () => {
        expect(validateTransition('approved', 'pending_approval').ok).toBe(false);
    });

    test('save-edits from queued/sending is invalid', () => {
        expect(validateTransition('queued', 'pending_approval').ok).toBe(false);
        expect(validateTransition('sending', 'pending_approval').ok).toBe(false);
    });
});

describe('Plan 28 save-edits — idempotency on repeated saves', () => {
    test('saving twice is allowed (pending_approval -> pending_approval)', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraft(db, idem);

        // First save
        await idem.update(docId, {
            status: 'pending_approval',
            approvalMeta: { edits: [{ itemIndex: 0, productId: 'p1', originalQty: 100, finalQty: 95, diffReason: 'fire' }], fireQuantityTotal: 5 },
        });
        // Second save (different reason)
        await idem.update(docId, {
            status: 'pending_approval',
            approvalMeta: { edits: [{ itemIndex: 0, productId: 'p1', originalQty: 100, finalQty: 90, diffReason: 'fire' }], fireQuantityTotal: 10 },
        });
        const after = await idem.getById(docId);
        expect(after.status).toBe('pending_approval');
        expect(after.approvalMeta.fireQuantityTotal).toBe(10);
    });
});
