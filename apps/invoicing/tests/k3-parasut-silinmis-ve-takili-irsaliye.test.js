// K3 (30.09.2026) — F3 bulgu 5 + 6
//  5: Parasut'te SILINMIS irsaliye Yemigo'da "sent" kaliyor, kapatici bagli siparisi DELIVERED yapiyordu.
//     -> ShipmentStatusSync bayrak + integrationAuditLogs; kapatici ve finalize silinmisi atlar;
//        onaylanmamis silinmis belge create() ile yeniden kesilebilir. Stok TERS CEVRILMEZ.
//  6: 'queued'da kilitli irsaliye -> resetStuckToDraft (yalniz Parasut'a hic yazilmamis olanlar).

const { ShipmentStatusSync, isDeletedInParasut, AUDIT_TYPE_DELETED } = require('../lib/ShipmentStatusSync');
const { runCloseCycle, findShipmentDocByOrder } = require('../lib/ProductionOrderCloser');
const { ShipmentProcessor } = require('../lib/ShipmentProcessor');

const SAAT = 60 * 60 * 1000;
const SIMDI = Date.parse('2026-09-30T12:00:00+03:00');
const sessiz = { log() {}, warn() {} };

// ---------- ortak sahte Firestore (koleksiyon ayrimli, add + zincirli where + transaction) ----------
function makeDb(seed = {}) {
    const store = new Map(Object.entries(seed));
    let auto = 0;
    const ref = (name, id) => ({
        _key: name + '/' + id,
        async get() { const d = store.get(name + '/' + id); return { exists: !!d, id, data: () => d }; },
        async update(p) { store.set(name + '/' + id, { ...store.get(name + '/' + id), ...p }); },
        async set(d) { store.set(name + '/' + id, d); },
    });
    const query = (name, filters) => {
        const q = {
            where(f, o, v) { return query(name, [...filters, [f, o, v]]); },
            limit() { return q; },
            async get() {
                const docs = [];
                for (const [k, v] of store.entries()) {
                    if (!k.startsWith(name + '/')) continue;
                    if (filters.every(([f, o, val]) => (o === 'in' ? val.includes(v[f]) : v[f] === val))) {
                        docs.push({ id: k.slice(name.length + 1), data: () => v });
                    }
                }
                return { size: docs.length, docs };
            },
        };
        return q;
    };
    return {
        _store: store,
        rows: (name) => [...store.entries()].filter(([k]) => k.startsWith(name + '/')).map(([, v]) => v),
        collection(name) {
            return {
                doc(id) { return ref(name, id); },
                where(f, o, v) { return query(name, []).where(f, o, v); },
                async add(d) { const id = 'auto' + (++auto); store.set(name + '/' + id, d); return { id }; },
            };
        },
        async runTransaction(fn) {
            const txn = {
                async get(r) { return r.get(); },
                update(r, p) { store.set(r._key, { ...store.get(r._key), ...p }); },
                set(r, d) { store.set(r._key, d); },
            };
            return fn(txn);
        },
    };
}

const SILINMIS = { found: false, deleted: true, legalized: false, despatchNo: null, uuid: null };
const TASLAK = { found: true, deleted: false, legalized: false, despatchNo: null, uuid: null };

function syncWith(db, statusById) {
    return new ShipmentStatusSync({
        db,
        tokenManager: { getValidToken: async () => 'tok' },
        providerFactory: async () => ({ getShipmentDocumentStatus: async (_t, id) => statusById[id] || TASLAK }),
        log: sessiz,
        now: () => SIMDI,
    });
}

describe('ShipmentStatusSync — Parasut\'ta silinmis belge isareti (F3 bulgu 5)', () => {
    test('sent belge silinmis bulununca: bayrak + stockMoved + tek audit; status DEGISMEZ', async () => {
        const db = makeDb({
            'invoiceDocuments/a': {
                tenantId: 'T', branchId: 'B1', documentKind: 'shipment', status: 'sent',
                parasutShipmentId: 'X1', sourceType: 'productionOrder', sourceId: 'ORD1', sourceTransferNumber: 'IM-2026-091512',
            },
        });
        const s = syncWith(db, { X1: SILINMIS });
        const r = await s.syncDocument('a', { tenantId: 'T' });
        expect(r.newlyDeleted).toBe(true);

        const d = db._store.get('invoiceDocuments/a');
        expect(d.status).toBe('sent');
        expect(d).toMatchObject({
            deletedInParasut: true, deletedInParasutAt: SIMDI,
            deletedInParasutWhileStatus: 'sent', deletedInParasutStockMoved: true,
        });
        expect(isDeletedInParasut(d)).toBe(true);

        const audits = db.rows('integrationAuditLogs');
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
            type: AUDIT_TYPE_DELETED, docId: 'a', tenantId: 'T', branchId: 'B1', yemigoStatus: 'sent',
            parasutShipmentId: 'X1', sourceId: 'ORD1', sourceTransferNumber: 'IM-2026-091512', stockMoved: true,
        });
        expect(audits[0].action).toMatch(/ters kayit/i);

        // Ikinci tur: bayrak zaten var -> audit TEKRARLANMAZ
        const r2 = await s.syncDocument('a', { tenantId: 'T' });
        expect(r2.newlyDeleted).toBe(false);
        expect(db.rows('integrationAuditLogs')).toHaveLength(1);
    });

    test('onaylanmamis (pending_approval) silinmis belge: stockMoved=false', async () => {
        const db = makeDb({ 'invoiceDocuments/b': { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'X2' } });
        await syncWith(db, { X2: SILINMIS }).syncDocument('b', { tenantId: 'T' });
        expect(db._store.get('invoiceDocuments/b')).toMatchObject({ deletedInParasut: true, deletedInParasutStockMoved: false, status: 'pending_approval' });
        expect(db.rows('integrationAuditLogs')[0].stockMoved).toBe(false);
    });

    test('bayrakli belge Parasut\'ta yeniden bulunursa bayrak kalkar', async () => {
        const db = makeDb({ 'invoiceDocuments/c': { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'X3', deletedInParasut: true } });
        await syncWith(db, { X3: TASLAK }).syncDocument('c', { tenantId: 'T' });
        expect(db._store.get('invoiceDocuments/c')).toMatchObject({ deletedInParasut: false, deletedInParasutClearedAt: SIMDI });
    });

    test('audit yazilamazsa senkron yine basarili (bayrak belgede)', async () => {
        const db = makeDb({ 'invoiceDocuments/a': { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'X1' } });
        const orig = db.collection.bind(db);
        db.collection = (name) => (name === 'integrationAuditLogs'
            ? { add: async () => { throw new Error('permission'); } }
            : orig(name));
        const r = await syncWith(db, { X1: SILINMIS }).syncDocument('a', { tenantId: 'T' });
        expect(r.newlyDeleted).toBe(true);
        expect(db._store.get('invoiceDocuments/a').deletedInParasut).toBe(true);
    });

    test('syncTenant yeni silinenleri ayri sayar', async () => {
        const db = makeDb({
            'invoiceDocuments/a': { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'X1' },
            'invoiceDocuments/b': { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'X2', deletedInParasut: true },
        });
        const r = await syncWith(db, { X1: SILINMIS, X2: SILINMIS }).syncTenant('T');
        expect(r).toMatchObject({ synced: 2, deleted: 2, newlyDeleted: 1 });
        expect(r.items.find((i) => i.docId === 'a').stockMoved).toBe(true);
    });
});

// ---------- kapatici ----------
function siparis(extra = {}) {
    return { tenantId: 'T1', branchId: 'B1', orderNumber: 'IM-2026-121825', status: 'PENDING', version: 0, parasutShipmentDocumentId: 'D1', ...extra };
}
function irsaliye(extra = {}) {
    return {
        tenantId: 'T1', documentKind: 'shipment', status: 'sent', sourceType: 'productionOrder', sourceId: 'ORD1',
        approvalMeta: { approvedAt: SIMDI - 20 * SAAT, approvedBy: 'panel:u' }, ...extra,
    };
}

describe('ProductionOrderCloser — Parasut\'ta silinmis irsaliye siparisi KAPATMAZ', () => {
    const calistir = (db) => runCloseCycle(db, { now: SIMDI, log: sessiz });

    test('deletedInParasut=true sent belge: siparis PENDING kalir, sayac artar', async () => {
        const db = makeDb({ 'productionOrders/ORD1': siparis(), 'invoiceDocuments/D1': irsaliye({ deletedInParasut: true }) });
        const r = await calistir(db);
        expect(r).toMatchObject({ scanned: 1, closed: 0, skipped: 1, skippedDeletedInParasut: 1 });
        expect(db._store.get('productionOrders/ORD1').status).toBe('PENDING');
        expect(db.rows('productionOrderEvents')).toHaveLength(0);
    });

    test('bayrak yok ama parasutSync.deleted=true (eski senkron) da kapatmaz', async () => {
        const db = makeDb({ 'productionOrders/ORD1': siparis(), 'invoiceDocuments/D1': irsaliye({ parasutSync: { deleted: true, found: false } }) });
        const r = await calistir(db);
        expect(r.closed).toBe(0);
        expect(r.skippedDeletedInParasut).toBe(1);
    });

    test('silinmemis sent belge (parasutSync.deleted=false) normal kapanir', async () => {
        const db = makeDb({ 'productionOrders/ORD1': siparis(), 'invoiceDocuments/D1': irsaliye({ parasutSync: { deleted: false, found: true } }) });
        const r = await calistir(db);
        expect(r).toMatchObject({ closed: 1, skippedDeletedInParasut: 0 });
        expect(db._store.get('productionOrders/ORD1').status).toBe('DELIVERED');
    });

    test('kaynak bagindan arama: silinmis sent yerine CANLI sent belge secilir', async () => {
        const db = makeDb({
            'invoiceDocuments/ESKI': irsaliye({ deletedInParasut: true }),
            'invoiceDocuments/YENI': irsaliye({}),
        });
        const f = await findShipmentDocByOrder(db, { tenantId: 'T1', orderId: 'ORD1' });
        expect(f.id).toBe('YENI');
    });
});

// ---------- ShipmentProcessor: finalize engeli, yeniden kesme, takili belge ----------
function makeIdem(docs) {
    const store = new Map(Object.entries(docs));
    return {
        _store: store,
        async getById(id) { const d = store.get(id); return d ? { id, ...d } : null; },
        async update(id, p) { store.set(id, { ...store.get(id), ...p }); },
        async appendAudit(id, event, by, details) {
            const cur = store.get(id); cur.audit = [...(cur.audit || []), { event, by, details }]; store.set(id, cur);
        },
    };
}
function makeProc(docs, { createCalls = [] } = {}) {
    const idempotency = makeIdem(docs);
    const proc = new ShipmentProcessor({
        db: makeDb({}),
        idempotency,
        tokenManager: { getValidToken: async () => 'AT' },
        providerFactory: async () => ({
            async upsertContact() { return { contactId: 'C1' }; },
            async upsertProduct(_t, p) { return { productId: 'P-' + p.sku }; },
            async createShipmentDocument(_t, payload) { createCalls.push(payload); return { providerShipmentId: 'NEW9', shipmentNumber: null, pdfUrl: null }; },
        }),
        contextLoader: async () => ({ branch: { id: 'B1' }, items: [{ productId: 'p', productName: 'P', quantity: 2, unit: 'kg' }], issueDate: '2026-09-30' }),
    });
    return { proc, idempotency };
}

describe('ShipmentProcessor — silinmis belge', () => {
    test('finalize: Parasut\'ta silinmis belge 409 parasut_document_deleted, stok yazilmaz', async () => {
        const { proc, idempotency } = makeProc({
            D1: { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'X', branchId: 'B1', parasutSync: { deleted: true }, items: [] },
        });
        await expect(proc.finalize('D1', { tenantId: 'T', approvedBy: 'u' })).rejects.toMatchObject({ status: 409, code: 'parasut_document_deleted' });
        expect(idempotency._store.get('D1').status).toBe('pending_approval');
    });

    test('create: onaylanmamis silinmis belge YENIDEN kesilir, bayrak kalkar, eski kimlik saklanir', async () => {
        const createCalls = [];
        const { proc, idempotency } = makeProc({
            D1: { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'OLD1', deletedInParasut: true, parasutSync: { deleted: true } },
        }, { createCalls });
        const r = await proc.create('D1', { tenantId: 'T', requestedBy: 'panel' });
        expect(r.already).toBeUndefined();
        expect(createCalls).toHaveLength(1);
        const d = idempotency._store.get('D1');
        expect(d).toMatchObject({ parasutShipmentId: 'NEW9', deletedInParasut: false, parasutSync: null, previousParasutShipmentId: 'OLD1', status: 'pending_approval' });
        expect(d.audit.map((a) => a.event)).toContain('parasut_shipment_recreated_after_delete');
    });

    test('create: silinmemis belge eskisi gibi idempotent (already)', async () => {
        const createCalls = [];
        const { proc } = makeProc({ D1: { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'OLD1' } }, { createCalls });
        const r = await proc.create('D1', { tenantId: 'T' });
        expect(r.already).toBe(true);
        expect(createCalls).toHaveLength(0);
    });

    test('create: SENT + silinmis belge yeniden kesilmez (stok zaten hareket etti, karar yetkilide)', async () => {
        const createCalls = [];
        const { proc } = makeProc({ D1: { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'OLD1', deletedInParasut: true } }, { createCalls });
        const r = await proc.create('D1', { tenantId: 'T' });
        expect(r.already).toBe(true);
        expect(createCalls).toHaveLength(0);
    });
});

describe('ShipmentProcessor.resetStuckToDraft — queued\'da kilitli irsaliye (F3 bulgu 6)', () => {
    const takili = (extra = {}) => ({
        tenantId: 'T', documentKind: 'shipment', status: 'queued', parasutShipmentId: null, sourceTransferNumber: 'IM-2026-181145',
        lastError: { message: 'Parasut e-document job failed: Scenario E-fatura senaryosu...' }, ...extra,
    });

    test('queued -> draft, lastError temizlenir, audit yazilir', async () => {
        const { proc, idempotency } = makeProc({ D1: takili() });
        const r = await proc.resetStuckToDraft('D1', { tenantId: 'T', requestedBy: 'panel:u' });
        expect(r).toMatchObject({ ok: true, fromStatus: 'queued', toStatus: 'draft' });
        const d = idempotency._store.get('D1');
        expect(d).toMatchObject({ status: 'draft', lastError: null, stuckResetFromStatus: 'queued' });
        expect(d.audit.map((a) => a.event)).toEqual(['shipment_reset_to_draft']);
    });

    test('dryRun hicbir sey yazmaz', async () => {
        const { proc, idempotency } = makeProc({ D1: takili({ status: 'failed' }) });
        const r = await proc.resetStuckToDraft('D1', { tenantId: 'T', dryRun: true });
        expect(r).toMatchObject({ dryRun: true, fromStatus: 'failed', toStatus: 'draft' });
        expect(idempotency._store.get('D1').status).toBe('failed');
        expect(idempotency._store.get('D1').audit).toBeUndefined();
    });

    test.each([
        ['draft durumunda', { status: 'draft' }, 'invalid_status'],
        ['sent durumunda', { status: 'sent' }, 'invalid_status'],
        ['Parasut irsaliyesi varsa', { parasutShipmentId: 'X' }, 'has_parasut_shipment'],
        ['fatura yolundan parasutInvoiceId kalmissa', { parasutInvoiceId: 'INV1' }, 'has_parasut_invoice'],
        ['onaylanmissa', { approvalMeta: { approvedAt: 1 } }, 'already_approved'],
        ['fatura belgesiyse', { documentKind: 'invoice' }, 'not_shipment_kind'],
    ])('%s reddedilir (409)', async (_ad, extra, code) => {
        const { proc, idempotency } = makeProc({ D1: takili(extra) });
        await expect(proc.resetStuckToDraft('D1', { tenantId: 'T' })).rejects.toMatchObject({ status: 409, code });
        expect(idempotency._store.get('D1').audit).toBeUndefined();
    });

    test('baska firma 403', async () => {
        const { proc } = makeProc({ D1: takili() });
        await expect(proc.resetStuckToDraft('D1', { tenantId: 'BASKA' })).rejects.toMatchObject({ status: 403 });
    });
});
