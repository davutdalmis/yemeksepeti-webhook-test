// Plan 28++ — ShipmentProcessor unit testleri
// create / saveEdits / finalize akislari, mock Firestore + Parasut provider ile.

const { ShipmentProcessor, ShipmentError } = require('../lib/ShipmentProcessor');

function makeMockDb() {
    const docs = new Map();
    const txnQueue = [];
    return {
        _docs: docs,
        collection(name) {
            return {
                doc(id) {
                    return {
                        async set(data) { docs.set(`${name}/${id}`, data); },
                        async get() {
                            const d = docs.get(`${name}/${id}`);
                            return { exists: !!d, data: () => d };
                        },
                        async update(patch) {
                            const cur = docs.get(`${name}/${id}`) || {};
                            docs.set(`${name}/${id}`, { ...cur, ...patch });
                        },
                    };
                },
            };
        },
        async runTransaction(fn) {
            // Gerçek Firestore kuralı: tüm okumalar yazmalardan ÖNCE gelmeli.
            // 2026-07-15: finalize'daki get-after-write bu mock denetlemediği için
            // canlıya kadar sızdı — artık mock da aynı kuralı uygular.
            let wrote = false;
            const txn = {
                async get(ref) {
                    if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
                    return ref.get();
                },
                set(ref, data) { wrote = true; ref.set(data); },
                update(ref, patch) { wrote = true; ref.update(patch); },
            };
            txnQueue.push(fn);
            return await fn(txn);
        },
    };
}

function makeMockIdempotency(initialDocs = {}) {
    const store = new Map(Object.entries(initialDocs));
    return {
        _store: store,
        async getById(id) {
            const d = store.get(id);
            return d ? { id, ...d } : null;
        },
        async update(id, patch) {
            const cur = store.get(id) || {};
            store.set(id, { ...cur, ...patch, updatedAt: Date.now() });
        },
        async appendAudit(id, event, by, details) {
            const cur = store.get(id) || {};
            cur.audit = cur.audit || [];
            cur.audit.push({ ts: Date.now(), event, by, details });
            store.set(id, cur);
        },
    };
}

function makeMockProvider({ shipmentResult, shipmentUpdateResult } = {}) {
    return {
        async upsertContact(_t, _b) { return { contactId: 'C1', created: false }; },
        async upsertProduct(_t, p) { return { productId: `P-${p.sku || p.name}`, created: false }; },
        async createShipmentDocument(_t, _payload) {
            if (shipmentResult) return shipmentResult;
            return {
                providerShipmentId: '777',
                shipmentNumber: 'IRS-001',
                pdfUrl: 'https://parasut.com/print/777.pdf',
            };
        },
        async updateShipmentDocument(_t, _id, _payload) {
            if (shipmentUpdateResult) return shipmentUpdateResult;
            return { providerShipmentId: '777', shipmentNumber: 'IRS-001', pdfUrl: null };
        },
    };
}

describe('Plan 28++ ShipmentProcessor', () => {
    function makeBaseDeps(extras = {}) {
        const db = makeMockDb();
        const idempotency = makeMockIdempotency(extras.docs || {});
        const tokenManager = { async getValidToken() { return 'AT'; } };
        const providerFactory = async () => makeMockProvider(extras.providerOpts || {});
        const contextLoader = async (_tid, doc) => ({
            branch: { id: 'B1', name: 'Bafetto Maltepe', address: 'Atatürk Cad.', city: 'İstanbul', district: 'Maltepe' },
            items: [
                { productId: 'pizza', productName: 'Pizza Hamuru', quantity: 100, unitPrice: 5, vatRate: 1, unit: 'adet' },
            ],
            currency: 'TRL',
            issueDate: '2026-05-08',
            shipmentIncluded: false,
            description: `Sevkiyat: ${doc.sourceTransferNumber || ''}`,
        });
        return { db, idempotency, tokenManager, providerFactory, contextLoader };
    }

    test('create — manuel modda Parasut\'a shipment_document POST eder, parasutShipmentId yazar', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D1': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    branchId: 'B1',
                    sourceType: 'stockTransfer',
                    sourceId: 'ST1',
                    sourceTransferNumber: 'PILOT-1',
                    status: 'draft',
                    shipmentMeta: { shippedAt: Date.now() },
                    items: [
                        { itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 100, unit: 'adet', unitPrice: 5, vatRate: 1 },
                    ],
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        const r = await proc.create('D1', { tenantId: 'T1', requestedBy: 'panel-owner' });

        expect(r.ok).toBe(true);
        expect(r.parasutShipmentId).toBe('777');
        expect(r.parasutShipmentNumber).toBe('IRS-001');
        expect(r.pdfUrl).toBe('https://parasut.com/print/777.pdf');

        const stored = deps.idempotency._store.get('D1');
        expect(stored.parasutShipmentId).toBe('777');
        expect(stored.status).toBe('pending_approval');
        expect(stored.parasutContactId).toBe('C1');
    });

    test('create — idempotent: parasutShipmentId varsa already=true doner, yeni POST atmaz', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D2': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    parasutShipmentId: '999',
                    parasutShipmentNumber: 'IRS-EXISTING',
                    pdfUrl: 'https://parasut.com/print/999.pdf',
                    status: 'pending_approval',
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        const r = await proc.create('D2', { tenantId: 'T1' });

        expect(r.already).toBe(true);
        expect(r.parasutShipmentId).toBe('999');
    });

    test('create — documentKind != shipment ise 409 ShipmentError', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D3': {
                    tenantId: 'T1',
                    documentKind: 'invoice', // YANLIS tip
                    status: 'draft',
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        await expect(proc.create('D3', { tenantId: 'T1' })).rejects.toMatchObject({
            name: 'ShipmentError',
            code: 'not_shipment_kind',
            status: 409,
        });
    });

    test('create — tenant mismatch -> 403', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D4': { tenantId: 'T1', documentKind: 'shipment', status: 'draft' },
            },
        });
        const proc = new ShipmentProcessor(deps);
        await expect(proc.create('D4', { tenantId: 'T_OTHER' })).rejects.toMatchObject({
            code: 'tenant_mismatch',
            status: 403,
        });
    });

    test('saveEdits — kalemler valide eder, fire toplaminin hesabini yapar', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D5': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    parasutShipmentId: '777', // create edilmis
                    status: 'pending_approval',
                    items: [
                        { itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 100, unit: 'adet', unitPrice: 5, vatRate: 1 },
                    ],
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        const r = await proc.saveEdits('D5', {
            tenantId: 'T1',
            edits: [{ itemIndex: 0, finalQty: 95, diffReason: 'fire' }],
            editedBy: 'panel',
        });
        expect(r.ok).toBe(true);
        expect(r.fireQuantityTotal).toBe(5);
        const stored = deps.idempotency._store.get('D5');
        expect(stored.approvalMeta.fireQuantityTotal).toBe(5);
        expect(stored.approvalMeta.edits[0].finalQty).toBe(95);
    });

    test('saveEdits — finalQty originalQuantity\'den buyukse 400', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D6': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    status: 'draft',
                    items: [
                        { itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 100, unit: 'adet', unitPrice: 5, vatRate: 1 },
                    ],
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        await expect(
            proc.saveEdits('D6', {
                tenantId: 'T1',
                edits: [{ itemIndex: 0, finalQty: 150 }],
            }),
        ).rejects.toMatchObject({
            code: 'finalQty_out_of_range',
            status: 400,
        });
    });

    test('finalize — parasutShipmentId yoksa 409 (henuz Parasut\'a yazilmadi)', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D7': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    status: 'draft',
                    items: [],
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        await expect(
            proc.finalize('D7', { tenantId: 'T1', approvedBy: 'owner' }),
        ).rejects.toMatchObject({
            code: 'no_parasut_shipment',
            status: 409,
        });
    });

    test('finalize — status=sent ise idempotent already=true doner', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D8': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    parasutShipmentId: '777',
                    parasutShipmentNumber: 'IRS-001',
                    status: 'sent',
                },
            },
        });
        const proc = new ShipmentProcessor(deps);
        const r = await proc.finalize('D8', { tenantId: 'T1', approvedBy: 'owner' });
        expect(r.already).toBe(true);
        expect(r.parasutShipmentId).toBe('777');
    });

    test('finalize — basari yolu: status=sent, inventory + stockTransfer txn', async () => {
        const deps = makeBaseDeps({
            docs: {
                'D9': {
                    tenantId: 'T1',
                    documentKind: 'shipment',
                    parasutShipmentId: '777',
                    parasutShipmentNumber: 'IRS-001',
                    branchId: 'B1',
                    sourceType: 'stockTransfer',
                    sourceId: 'ST9',
                    status: 'pending_approval',
                    items: [
                        { itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 100, unit: 'adet', unitPrice: 5, vatRate: 1 },
                    ],
                    approvalMeta: { edits: [] },
                },
            },
        });
        // invoiceDocuments doc'unu da db'de kayitli yap (txn icinde txn.get kullaniliyor)
        deps.db._docs.set('invoiceDocuments/D9', {
            tenantId: 'T1',
            documentKind: 'shipment',
            parasutShipmentId: '777',
            status: 'pending_approval',
            items: [
                { itemIndex: 0, productId: 'pizza', productName: 'Pizza Hamuru', originalQuantity: 100, unit: 'adet', unitPrice: 5, vatRate: 1 },
            ],
        });

        const proc = new ShipmentProcessor(deps);
        const r = await proc.finalize('D9', { tenantId: 'T1', approvedBy: 'owner-1' });
        expect(r.ok).toBe(true);
        expect(r.parasutShipmentId).toBe('777');
        // stockTransfers/ST9 status='completed' yazilmali
        const tDoc = deps.db._docs.get('stockTransfers/ST9');
        expect(tDoc.status).toBe('completed');
        // invoiceDocuments status='sent'
        const dDoc = deps.db._docs.get('invoiceDocuments/D9');
        expect(dDoc.status).toBe('sent');
    });
});
