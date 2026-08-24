// 2026-08-24 — Bekleyen siparişe kalem ekleme senkronu testleri
//   ProductionOrderListener._syncItemsIfChanged (parasutQueued=true yolundan):
//     - kalemler aynıysa NO-OP (update/audit çağrılmaz)
//     - draft/pending_approval + elle edit yok -> items+amount güncellenir + audit
//     - approvalMeta.edits dolu -> itemsOutOfSync bayrağı, items DOKUNULMAZ
//     - status=sent -> itemsOutOfSync bayrağı, items DOKUNULMAZ
//     - parasutShipmentId varsa Paraşüt updateShipmentDocument best-effort çağrılır
//     - Paraşüt update patlarsa Firestore güncellemesi geri alınmaz (audit'e düşer)

const ProductionOrderListener = require('../listeners/ProductionOrderListener');

function makeIdempotency(initialDocs = {}) {
    const docs = { ...initialDocs };
    const calls = { update: [], audit: [] };
    return {
        docs,
        calls,
        async ensureDraft() { throw new Error('ensureDraft cagirilmamali (parasutQueued yolu)'); },
        async getById(id) { return docs[id] ? { id, ...docs[id] } : null; },
        async update(id, patch) {
            calls.update.push({ id, patch });
            docs[id] = { ...(docs[id] || {}), ...patch };
        },
        async appendAudit(id, event, by, details) { calls.audit.push({ id, event, by, details }); },
    };
}

function makeListener({ idempotency, providerFactory, tokenManager } = {}) {
    return new ProductionOrderListener({
        db: { collection: () => ({ where: () => ({ where: () => ({ onSnapshot: () => () => {} }), onSnapshot: () => () => {} }) }) },
        idempotency,
        settingsLoader: async () => ({ isEnabled: true, shipmentMode: 'manual' }),
        providerFactory,
        tokenManager,
    });
}

function makeOrderSnap(id, data) {
    const refUpdates = [];
    return { id, data: () => data, ref: { update: async (p) => refUpdates.push(p) }, _refUpdates: refUpdates };
}

const DOC_ID = 'shipdoc1';

function baseOrder(items) {
    return {
        tenantId: 'T1',
        branchId: 'B1',
        orderNumber: 'IM-2026-300',
        status: 'PENDING',
        parasutQueued: true,
        parasutShipmentDocumentId: DOC_ID,
        items,
    };
}

function snapItem(idx, productId, qty, price) {
    return {
        itemIndex: idx, productId, productName: productId, unit: 'adet',
        unitPrice: price, vatRate: 0, originalQuantity: qty, batchId: null, batchNumber: null,
    };
}

const ORIG_ITEMS = [
    { productId: 'P1', productName: 'P1', quantity: 10, unit: 'adet', unitPrice: 5 },
    { productId: 'P2', productName: 'P2', quantity: 4, unit: 'adet', unitPrice: 8 },
];
const ORIG_SNAPSHOT = [snapItem(0, 'P1', 10, 5), snapItem(1, 'P2', 4, 8)];

describe('kalem senkronu — _handleOrder parasutQueued yolu', () => {
    test('kalemler aynıysa NO-OP', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'draft', items: ORIG_SNAPSHOT, amount: 82 },
        });
        const l = makeListener({ idempotency: idem });
        await l._handleOrder(makeOrderSnap('o1', baseOrder(ORIG_ITEMS)));
        expect(idem.calls.update).toHaveLength(0);
        expect(idem.calls.audit).toHaveLength(0);
    });

    test('draft + edit yok -> items ve amount güncellenir, audit yazılır', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'draft', items: ORIG_SNAPSHOT, amount: 82 },
        });
        const l = makeListener({ idempotency: idem });
        const newItems = [...ORIG_ITEMS, { productId: 'P3', productName: 'P3', quantity: 2, unit: 'kg', unitPrice: 100 }];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));

        expect(idem.docs[DOC_ID].items).toHaveLength(3);
        expect(idem.docs[DOC_ID].items[2].productId).toBe('P3');
        expect(idem.docs[DOC_ID].amount).toBe(10 * 5 + 4 * 8 + 2 * 100);
        expect(idem.docs[DOC_ID].itemsOutOfSync).toBe(false);
        expect(idem.calls.audit.map((a) => a.event)).toContain('items_synced_from_order');
    });

    test('pending_approval da senkronlanabilir (miktar artışı dahil)', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'pending_approval', items: ORIG_SNAPSHOT, amount: 82 },
        });
        const l = makeListener({ idempotency: idem });
        const newItems = [
            { ...ORIG_ITEMS[0], quantity: 15 }, // WPF birleştirme: aynı ürün toplandı
            ORIG_ITEMS[1],
        ];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));
        expect(idem.docs[DOC_ID].items[0].originalQuantity).toBe(15);
        expect(idem.docs[DOC_ID].amount).toBe(15 * 5 + 4 * 8);
    });

    test('approvalMeta.edits dolu -> DOKUNMA, itemsOutOfSync bayrağı', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: {
                documentKind: 'shipment', status: 'pending_approval',
                items: ORIG_SNAPSHOT, amount: 82,
                approvalMeta: { edits: [{ itemIndex: 0, finalQty: 8 }] },
            },
        });
        const l = makeListener({ idempotency: idem });
        const newItems = [...ORIG_ITEMS, { productId: 'P3', productName: 'P3', quantity: 1, unitPrice: 1 }];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));

        expect(idem.docs[DOC_ID].items).toHaveLength(2); // dokunulmadı
        expect(idem.docs[DOC_ID].itemsOutOfSync).toBe(true);
        const audit = idem.calls.audit.find((a) => a.event === 'items_out_of_sync');
        expect(audit.details.reason).toBe('approval_edits_exist');
    });

    test('status=sent -> DOKUNMA, itemsOutOfSync bayrağı', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'sent', items: ORIG_SNAPSHOT, amount: 82 },
        });
        const l = makeListener({ idempotency: idem });
        const newItems = [...ORIG_ITEMS, { productId: 'P3', productName: 'P3', quantity: 1, unitPrice: 1 }];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));

        expect(idem.docs[DOC_ID].items).toHaveLength(2);
        expect(idem.docs[DOC_ID].itemsOutOfSync).toBe(true);
        const audit = idem.calls.audit.find((a) => a.event === 'items_out_of_sync');
        expect(audit.details.reason).toBe('status_sent');
    });

    test('boş kalem listesi senkronlanmaz (küçültme iptal ağının işi)', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'draft', items: ORIG_SNAPSHOT, amount: 82 },
        });
        const l = makeListener({ idempotency: idem });
        await l._handleOrder(makeOrderSnap('o1', baseOrder([])));
        expect(idem.calls.update).toHaveLength(0);
    });

    test('parasutShipmentId varsa Paraşüt updateShipmentDocument çağrılır', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'draft', items: ORIG_SNAPSHOT, amount: 82, parasutShipmentId: 'PS-9' },
        });
        const updates = [];
        const provider = {
            upsertProduct: async (_t, p) => ({ productId: `parasut-${p.sku}` }),
            updateShipmentDocument: async (_t, id, body) => updates.push({ id, body }),
        };
        const l = makeListener({
            idempotency: idem,
            providerFactory: async () => provider,
            tokenManager: { getValidToken: async () => 'tok' },
        });
        const newItems = [...ORIG_ITEMS, { productId: 'P3', productName: 'P3', quantity: 2, unitPrice: 100 }];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));

        expect(updates).toHaveLength(1);
        expect(updates[0].id).toBe('PS-9');
        expect(updates[0].body.items).toHaveLength(3);
        expect(idem.calls.audit.map((a) => a.event)).toContain('parasut_shipment_items_updated');
    });

    test('Paraşüt update patlarsa Firestore güncel kalır, audit düşer', async () => {
        const idem = makeIdempotency({
            [DOC_ID]: { documentKind: 'shipment', status: 'draft', items: ORIG_SNAPSHOT, amount: 82, parasutShipmentId: 'PS-9' },
        });
        const provider = {
            upsertProduct: async (_t, p) => ({ productId: `parasut-${p.sku}` }),
            updateShipmentDocument: async () => { throw new Error('parasut 500'); },
        };
        const l = makeListener({
            idempotency: idem,
            providerFactory: async () => provider,
            tokenManager: { getValidToken: async () => 'tok' },
        });
        const newItems = [...ORIG_ITEMS, { productId: 'P3', productName: 'P3', quantity: 2, unitPrice: 100 }];
        await l._handleOrder(makeOrderSnap('o1', baseOrder(newItems)));

        expect(idem.docs[DOC_ID].items).toHaveLength(3); // Firestore güncel
        expect(idem.calls.audit.map((a) => a.event)).toContain('parasut_item_update_failed');
    });
});
