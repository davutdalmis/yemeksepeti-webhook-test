// Plan 29 — Sipariş-anı irsaliye taslağı testleri
//   ProductionOrderListener._handleOrder:
//     - PENDING sipariş -> shipment DRAFT + siparişe parasutQueued damgası
//     - guard'lar: settings yok / isEnabled=false / master flag kapalı / shipmentMode=disabled
//     - idempotent: mevcut draft varsa yenisi üretilmez ama marker yine yazılır
//   ProductionOrderListener._handleCancellation:
//     - kesilmemiş draft -> otomatik void; sent -> manuel inceleme bayrağı
//   StockTransferListener çift-taslak önleme:
//     - aynı orderNumber için sipariş-tetikli doc varsa transfer shipped olunca
//       ikinci shipment draft ÜRETİLMEZ, doc linklenir (sourceTransferId + shippedAt)

const ProductionOrderListener = require('../listeners/ProductionOrderListener');
const StockTransferListener = require('../listeners/StockTransferListener');

function makeDb({ orderShipmentDocs = [] } = {}) {
    // invoiceDocuments üstünde 4'lü eşitlik sorgusu (StockTransferListener dedup) desteklenir;
    // diğer koleksiyonlar sadece constructor/start için sahte zincir döner.
    const queryResult = {
        empty: orderShipmentDocs.length === 0,
        docs: orderShipmentDocs.map((d) => ({ id: d.id, data: () => d.data })),
    };
    function makeChain() {
        const chain = {
            _filters: [],
            where(field, _op, value) { chain._filters.push([field, value]); return chain; },
            limit() { return chain; },
            async get() { return queryResult; },
            onSnapshot() { return () => {}; },
        };
        return chain;
    }
    const chains = [];
    return {
        chains,
        collection(name) {
            const chain = makeChain();
            chain._collection = name;
            chains.push(chain);
            return chain;
        },
    };
}

function makeIdempotency(initialDocs = {}) {
    const docs = { ...initialDocs };
    const calls = { ensureDraft: [], update: [], audit: [] };
    return {
        docs,
        calls,
        async ensureDraft({ tenantId, sourceType, sourceId, documentKind, data }) {
            calls.ensureDraft.push({ tenantId, sourceType, sourceId, documentKind, data });
            const key = `${sourceType}:${sourceId}:${documentKind}`;
            if (docs[key]) return { existing: true, id: key, doc: docs[key] };
            docs[key] = { tenantId, sourceType, sourceId, documentKind, status: 'draft', ...data };
            return { existing: false, id: key, doc: docs[key] };
        },
        async getById(id) {
            return docs[id] ? { id, ...docs[id] } : null;
        },
        async update(id, patch) {
            calls.update.push({ id, patch });
            docs[id] = { ...(docs[id] || {}), ...patch };
        },
        async appendAudit(id, event, by, details) {
            calls.audit.push({ id, event, by, details });
        },
    };
}

function makeOrderSnap(id, data) {
    const refUpdates = [];
    return {
        id,
        data: () => data,
        ref: { update: async (patch) => { refUpdates.push(patch); } },
        _refUpdates: refUpdates,
    };
}

const BASE_ORDER = {
    tenantId: 'T1',
    branchId: 'B1',
    branchName: 'Bafetto Maltepe',
    orderNumber: 'IM-2026-200',
    status: 'PENDING',
    items: [
        { productId: 'P1', productName: 'Pizza Hamuru', quantity: 100, unit: 'adet', unitPrice: 5, totalPrice: 500 },
        { productId: 'P2', productName: 'Domates Sos', quantity: 20, unit: 'kg', unitPrice: 8, totalPrice: 160 },
    ],
};

function makeListener(idem, { settings, masterOn = true, db } = {}) {
    return new ProductionOrderListener({
        db: db || makeDb(),
        idempotency: idem,
        settingsLoader: async () => settings !== undefined ? settings : { isEnabled: true, shipmentMode: 'manual', defaultDocumentType: 'e_archive' },
        masterFlagLoader: async () => masterOn,
    });
}

describe('Plan 29 — ProductionOrderListener sipariş-anı shipment draft', () => {
    test('PENDING sipariş -> shipment DRAFT + parasutQueued damgası', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-1', { ...BASE_ORDER });

        await listener._handleOrder(snap);

        expect(idem.calls.ensureDraft).toHaveLength(1);
        const call = idem.calls.ensureDraft[0];
        expect(call.sourceType).toBe('productionOrder');
        expect(call.sourceId).toBe('ord-1');
        expect(call.documentKind).toBe('shipment');
        expect(call.data.sourceTransferNumber).toBe('IM-2026-200');
        expect(call.data.branchId).toBe('B1');
        expect(call.data.amount).toBe(100 * 5 + 20 * 8);
        expect(call.data.items).toHaveLength(2);
        expect(call.data.items[0].originalQuantity).toBe(100);
        expect(call.data.items[0].unit).toBe('adet');
        expect(call.data.items[1].originalQuantity).toBe(20);
        expect(call.data.items[1].unit).toBe('kg');
        expect(call.data.shipmentMeta.shippedAt).toBeNull();
        expect(call.data.shipmentMeta.targetBranchId).toBe('B1');

        expect(snap._refUpdates).toHaveLength(1);
        expect(snap._refUpdates[0].parasutQueued).toBe(true);
        expect(snap._refUpdates[0].parasutShipmentDocumentId).toBe('productionOrder:ord-1:shipment');
    });

    test('parasutQueued=true sipariş -> no-op', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-2', { ...BASE_ORDER, parasutQueued: true });

        await listener._handleOrder(snap);

        expect(idem.calls.ensureDraft).toHaveLength(0);
        expect(snap._refUpdates).toHaveLength(0);
    });

    test('settings yok (loader throw) -> sessiz skip', async () => {
        const idem = makeIdempotency();
        const listener = new ProductionOrderListener({
            db: makeDb(),
            idempotency: idem,
            settingsLoader: async () => { throw new Error('TENANT_SETTINGS_MISSING'); },
        });
        const snap = makeOrderSnap('ord-3', { ...BASE_ORDER });

        await listener._handleOrder(snap);

        expect(idem.calls.ensureDraft).toHaveLength(0);
        expect(snap._refUpdates).toHaveLength(0);
    });

    test('isEnabled=false -> skip', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem, { settings: { isEnabled: false, shipmentMode: 'manual' } });
        const snap = makeOrderSnap('ord-4', { ...BASE_ORDER });

        await listener._handleOrder(snap);
        expect(idem.calls.ensureDraft).toHaveLength(0);
    });

    test('master flag kapalı -> skip (fail-safe)', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem, { masterOn: false });
        const snap = makeOrderSnap('ord-5', { ...BASE_ORDER });

        await listener._handleOrder(snap);
        expect(idem.calls.ensureDraft).toHaveLength(0);
    });

    test('shipmentMode=disabled -> skip, marker YAZILMAZ (mod açılınca backfill)', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem, { settings: { isEnabled: true, shipmentMode: 'disabled' } });
        const snap = makeOrderSnap('ord-6', { ...BASE_ORDER });

        await listener._handleOrder(snap);
        expect(idem.calls.ensureDraft).toHaveLength(0);
        expect(snap._refUpdates).toHaveLength(0);
    });

    test('idempotent: mevcut draft -> yeni üretilmez ama marker yine yazılır', async () => {
        const idem = makeIdempotency({
            'productionOrder:ord-7:shipment': { status: 'draft', tenantId: 'T1' },
        });
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-7', { ...BASE_ORDER });

        await listener._handleOrder(snap);

        expect(idem.calls.ensureDraft).toHaveLength(1); // ensureDraft çağrılır ama existing döner
        expect(snap._refUpdates[0].parasutQueued).toBe(true);
    });

    test('tenantId eksik -> skip', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-8', { ...BASE_ORDER, tenantId: undefined });

        await listener._handleOrder(snap);
        expect(idem.calls.ensureDraft).toHaveLength(0);
    });
});

describe('Plan 29 — ProductionOrderListener iptal güvenlik ağı', () => {
    test('kesilmemiş draft -> otomatik void + sipariş damgalanır', async () => {
        const idem = makeIdempotency({ 'doc-1': { status: 'draft', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-c1', {
            ...BASE_ORDER,
            status: 'CANCELLED',
            parasutQueued: true,
            parasutShipmentDocumentId: 'doc-1',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['doc-1'].status).toBe('cancelled');
        expect(idem.docs['doc-1'].cancellationReason).toBe('source_order_cancelled');
        expect(idem.calls.audit.map((a) => a.event)).toContain('order_cancelled_auto_void');
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('sent belge -> status DEĞİŞMEZ, manuel inceleme bayrağı', async () => {
        const idem = makeIdempotency({ 'doc-2': { status: 'sent', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-c2', {
            ...BASE_ORDER,
            status: 'CANCELLED',
            parasutQueued: true,
            parasutShipmentDocumentId: 'doc-2',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['doc-2'].status).toBe('sent');
        expect(idem.docs['doc-2'].cancellationRequested).toBe(true);
        expect(idem.calls.audit.map((a) => a.event)).toContain('order_cancelled_after_sent');
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('parasutCancellationHandled=true -> no-op (idempotent)', async () => {
        const idem = makeIdempotency({ 'doc-3': { status: 'draft', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-c3', {
            ...BASE_ORDER,
            status: 'CANCELLED',
            parasutQueued: true,
            parasutCancellationHandled: true,
            parasutShipmentDocumentId: 'doc-3',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['doc-3'].status).toBe('draft');
        expect(snap._refUpdates).toHaveLength(0);
    });

    test('belge id yok -> sadece damga', async () => {
        const idem = makeIdempotency();
        const listener = makeListener(idem);
        const snap = makeOrderSnap('ord-c4', {
            ...BASE_ORDER,
            status: 'CANCELLED',
            parasutQueued: true,
        });

        await listener._handleCancellation(snap);
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('Paraşüt taslak shipment varsa best-effort delete', async () => {
        const idem = makeIdempotency({
            'doc-5': { status: 'pending_approval', tenantId: 'T1', parasutShipmentId: '777' },
        });
        const deleteCalls = [];
        const listener = new ProductionOrderListener({
            db: makeDb(),
            idempotency: idem,
            settingsLoader: async () => ({ isEnabled: true }),
            providerFactory: async () => ({
                async deleteShipmentDocument(token, id) { deleteCalls.push({ token, id }); return { ok: true }; },
            }),
            tokenManager: { async getValidToken() { return 'TKN'; } },
        });
        const snap = makeOrderSnap('ord-c5', {
            ...BASE_ORDER,
            status: 'CANCELLED',
            parasutQueued: true,
            parasutShipmentDocumentId: 'doc-5',
        });

        await listener._handleCancellation(snap);

        expect(deleteCalls).toHaveLength(1);
        expect(deleteCalls[0].id).toBe('777');
        expect(idem.docs['doc-5'].status).toBe('cancelled');
        expect(idem.calls.audit.map((a) => a.event)).toContain('parasut_shipment_deleted');
    });
});

describe('Plan 29 — saveEdits undefined temizliği (2026-07-15 canlı hata)', () => {
    // Firestore undefined kabul etmez: "Value for argument 'data' is not a valid
    // document. Cannot use 'undefined' (found in field approvalMeta.edits...)".
    // Sebep/not seçilmeden kaydedilirse alan hiç yazılmamalı.
    const { ShipmentProcessor } = require('../lib/ShipmentProcessor');

    test('diffReason/note seçilmemişse edits entry\'lerinde alan HİÇ olmamalı', async () => {
        const store = new Map([
            ['D1', {
                tenantId: 'T1',
                documentKind: 'shipment',
                status: 'draft',
                items: [{ itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 1, unit: 'adet', unitPrice: 0, vatRate: 0 }],
            }],
        ]);
        const idem = {
            async getById(id) { const d = store.get(id); return d ? { id, ...d } : null; },
            async update(id, patch) {
                // Gerçek Firestore davranışı: undefined değer -> hata
                const check = (obj, path) => {
                    for (const [k, v] of Object.entries(obj)) {
                        if (v === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}${k}")`);
                        if (v && typeof v === 'object' && !Array.isArray(v)) check(v, `${path}${k}.`);
                        if (Array.isArray(v)) v.forEach((el, i) => { if (el && typeof el === 'object') check(el, `${path}${k}.\`${i}\`.`); });
                    }
                };
                check(patch, '');
                store.set(id, { ...store.get(id), ...patch });
            },
            async appendAudit() {},
        };
        const proc = new ShipmentProcessor({
            db: { runTransaction: async () => {}, collection: () => ({ doc: () => ({}) }) },
            idempotency: idem,
            tokenManager: { async getValidToken() { return 'AT'; } },
            providerFactory: async () => ({}),
            contextLoader: async () => ({ branch: { id: 'B1' }, items: [] }),
        });

        // Panel "Kaydet ve Onaya Bekle": sebep seçilmedi, not boş
        const r = await proc.saveEdits('D1', {
            tenantId: 'T1',
            edits: [{ itemIndex: 0, finalQty: 1 }],
            editedBy: 'panel',
        });

        expect(r.ok).toBe(true);
        const saved = store.get('D1');
        expect(saved.approvalMeta.edits).toHaveLength(1);
        expect('diffReason' in saved.approvalMeta.edits[0]).toBe(false);
        expect('note' in saved.approvalMeta.edits[0]).toBe(false);
    });
});

describe('Plan 29 — IdempotencyService merkezi undefined temizliği', () => {
    const { IdempotencyService } = require('../lib/IdempotencyService');

    test('update() undefined alanları (iç içe/array dahil) yazmadan atar', async () => {
        const writes = [];
        const db = {
            collection: () => ({
                doc: () => ({
                    async set(data) { writes.push(data); },
                }),
            }),
        };
        const svc = new IdempotencyService({ db });
        await svc.update('X', {
            a: 1,
            b: undefined,
            nested: { c: undefined, d: 2 },
            arr: [{ e: undefined, f: 3 }],
        });
        expect(writes).toHaveLength(1);
        const w = writes[0];
        expect('b' in w).toBe(false);
        expect('c' in w.nested).toBe(false);
        expect(w.nested.d).toBe(2);
        expect('e' in w.arr[0]).toBe(false);
        expect(w.arr[0].f).toBe(3);
        expect(JSON.stringify(w)).not.toContain('undefined');
    });
});

describe('Plan 29 — StockTransferListener çift-taslak önleme', () => {
    function makeTransferSnap(id, data) {
        const refUpdates = [];
        return {
            id,
            data: () => data,
            ref: { update: async (patch) => { refUpdates.push(patch); } },
            _refUpdates: refUpdates,
        };
    }

    const SHIPPED_TRANSFER = {
        tenantId: 'T1',
        status: 'shipped',
        parasutQueued: false,
        transferNumber: 'IM-2026-200',
        destinationBranchId: 'B1',
        shippedAt: 1750000000000,
        preparedBy: 'imalatci',
        items: [
            { productId: 'P1', productName: 'Pizza Hamuru', unit: 'adet', shippedQuantity: 95, unitPrice: 5, vatRate: 1 },
        ],
    };

    test('sipariş-tetikli doc varsa shipment draft ÜRETİLMEZ, doc linklenir', async () => {
        const orderDoc = {
            id: 'order-doc-1',
            data: { tenantId: 'T1', documentKind: 'shipment', sourceType: 'productionOrder', sourceTransferNumber: 'IM-2026-200', status: 'draft' },
        };
        const idem = makeIdempotency({ 'order-doc-1': orderDoc.data });
        const listener = new StockTransferListener({
            db: makeDb({ orderShipmentDocs: [orderDoc] }),
            idempotency: idem,
            settingsLoader: async () => ({ isEnabled: true, shipmentMode: 'manual', invoiceDraftMode: 'disabled' }),
        });
        const snap = makeTransferSnap('trf-1', { ...SHIPPED_TRANSFER });

        await listener._handleTransfer(snap);

        // Yeni shipment draft üretilmedi
        const shipmentDrafts = idem.calls.ensureDraft.filter((c) => c.documentKind === 'shipment');
        expect(shipmentDrafts).toHaveLength(0);

        // Doc linklendi: sourceTransferId + gerçek shippedAt
        expect(idem.docs['order-doc-1'].sourceTransferId).toBe('trf-1');
        expect(idem.docs['order-doc-1'].shipmentMeta.shippedAt).toBe(1750000000000);
        expect(idem.calls.audit.map((a) => a.event)).toContain('transfer_linked');

        // Transfer sipariş-tetikli doc'a bağlandı
        expect(snap._refUpdates[0].parasutQueued).toBe(true);
        expect(snap._refUpdates[0].parasutShipmentDocumentId).toBe('order-doc-1');
    });

    test('sipariş-tetikli doc YOKSA eski davranış: transfer-tetikli shipment draft üretilir', async () => {
        const idem = makeIdempotency();
        const listener = new StockTransferListener({
            db: makeDb({ orderShipmentDocs: [] }),
            idempotency: idem,
            settingsLoader: async () => ({ isEnabled: true, shipmentMode: 'manual', invoiceDraftMode: 'disabled' }),
        });
        const snap = makeTransferSnap('trf-2', { ...SHIPPED_TRANSFER });

        await listener._handleTransfer(snap);

        const shipmentDrafts = idem.calls.ensureDraft.filter((c) => c.documentKind === 'shipment');
        expect(shipmentDrafts).toHaveLength(1);
        expect(shipmentDrafts[0].sourceType).toBe('stockTransfer');
        expect(shipmentDrafts[0].sourceId).toBe('trf-2');
    });

    test('dedup sorgusu hata verirse fail-open: eski davranış devam eder', async () => {
        const idem = makeIdempotency();
        const brokenDb = {
            collection() {
                return {
                    where() { return this; },
                    limit() { return this; },
                    async get() { throw new Error('index missing'); },
                    onSnapshot() { return () => {}; },
                };
            },
        };
        const listener = new StockTransferListener({
            db: brokenDb,
            idempotency: idem,
            settingsLoader: async () => ({ isEnabled: true, shipmentMode: 'manual', invoiceDraftMode: 'disabled' }),
        });
        const snap = makeTransferSnap('trf-3', { ...SHIPPED_TRANSFER });

        await listener._handleTransfer(snap);

        const shipmentDrafts = idem.calls.ensureDraft.filter((c) => c.documentKind === 'shipment');
        expect(shipmentDrafts).toHaveLength(1);
    });
});
