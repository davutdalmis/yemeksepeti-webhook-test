// Plan 28 Faz 3.5 — ApprovalProcessor full pipeline tests
// Mocks Paraşüt provider + tokenManager + Firestore admin SDK

const { ApprovalProcessor, ApprovalError } = require('../lib/ApprovalProcessor');
const { IdempotencyService } = require('../lib/IdempotencyService');

// ---------------- Fake Firestore Admin SDK ----------------
// Mimics db.collection().doc() and db.runTransaction() with Map storage.

function isArrayUnionSentinel(v) {
    if (!v || typeof v !== 'object') return false;
    return v.constructor && (v.constructor.name === 'ArrayUnionTransform' || '_elements' in v);
}

function applyMerge(existing, patch) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
        if (isArrayUnionSentinel(v)) {
            out[k] = [...(existing[k] || []), ...(v._elements || [])];
        } else {
            out[k] = v;
        }
    }
    return out;
}

function makeFakeDb() {
    const store = new Map();
    let docCounter = 1;
    function refFor(coll, id) {
        if (!id) id = `${coll}-auto-${docCounter++}`;
        const key = `${coll}/${id}`;
        return {
            id,
            _coll: coll,
            _key: key,
            get: async () => ({ exists: store.has(key), data: () => store.get(key), id }),
            create: async (d) => {
                if (store.has(key)) {
                    const e = new Error('exists');
                    e.code = 6;
                    throw e;
                }
                store.set(key, d);
            },
            set: async (d, opts) => {
                if (opts && opts.merge && store.has(key)) store.set(key, applyMerge(store.get(key), d));
                else store.set(key, d);
            },
            update: async (d) => {
                if (!store.has(key)) throw new Error('not found: ' + key);
                store.set(key, applyMerge(store.get(key), d));
            },
            delete: async () => store.delete(key),
        };
    }

    function txnRef(coll, id) {
        return refFor(coll, id);
    }

    return {
        _store: store,
        collection(coll) {
            return {
                doc(id) { return refFor(coll, id); },
            };
        },
        async runTransaction(fn) {
            // Gerçek Firestore kuralı: tüm okumalar yazmalardan ÖNCE (2026-07-15 regresyon koruması).
            let wrote = false;
            const txn = {
                async get(ref) {
                    if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
                    const exists = store.has(ref._key);
                    return { exists, data: () => store.get(ref._key) };
                },
                set(ref, data) { wrote = true; store.set(ref._key, data); },
                update(ref, data) {
                    wrote = true;
                    if (!store.has(ref._key)) throw new Error('txn update on missing: ' + ref._key);
                    store.set(ref._key, applyMerge(store.get(ref._key), data));
                },
                delete(ref) { wrote = true; store.delete(ref._key); },
            };
            return fn(txn);
        },
        // expose for test asserts
        _refFor: txnRef,
    };
}

// ---------------- Fake provider ----------------

function makeFakeProvider(overrides = {}) {
    let invCounter = 1;
    const defaults = {
        providerName: 'parasut',
        upsertContact: async () => ({ contactId: 'contact-1' }),
        upsertProduct: async (_t, p) => ({ productId: 'p-' + (p.productId || p.sku || 'x') }),
        createInvoice: async () => ({
            providerInvoiceId: `parasut-inv-${invCounter++}`,
            eArchiveId: `e-archive-${invCounter}`,
            invoiceNumber: 'IM2026-0001',
            pdfUrl: 'https://parasut.test/pdf/x',
            contactId: 'contact-1',
        }),
        cancelDocument: async () => ({ ok: true }),
    };
    return { ...defaults, ...overrides };
}

// ---------------- Helpers ----------------

async function seedDraftWithItems(db, idem, overrides = {}) {
    const r = await idem.ensureDraft({
        tenantId: overrides.tenantId || 'bafetto-001',
        sourceType: 'stockTransfer',
        sourceId: overrides.sourceId || 'TR-2026-0042',
        data: {
            branchId: 'b-kadikoy',
            sourceTransferNumber: 'TRF-0042',
            amount: 2500,
            currency: 'TRL',
            items: [
                { itemIndex: 0, productId: 'p1', productName: 'Pizza Hamuru', unit: 'paket', unitPrice: 25, vatRate: 20, originalQuantity: 100 },
                { itemIndex: 1, productId: 'p2', productName: 'Mozzarella', unit: 'paket', unitPrice: 250, vatRate: 10, originalQuantity: 5 },
            ],
            ...overrides.data,
        },
    });
    // Seed stockTransfers source doc
    await db.collection('stockTransfers').doc('TR-2026-0042').set({
        tenantId: 'bafetto-001',
        status: 'shipped',
        items: [
            { productId: 'p1', productName: 'Pizza Hamuru', quantity: 100, unitPrice: 25, vatRate: 20, unit: 'paket' },
            { productId: 'p2', productName: 'Mozzarella', quantity: 5, unitPrice: 250, vatRate: 10, unit: 'paket' },
        ],
    });
    return r.id;
}

function makeProcessor({ provider, db, idem, contextLoader }) {
    return new ApprovalProcessor({
        db,
        idempotency: idem,
        tokenManager: {
            getValidToken: async () => 'mock-token',
            invalidateToken: async () => {},
        },
        providerFactory: async () => provider,
        contextLoader: contextLoader || (async () => ({
            branch: { name: 'Bafetto Kadikoy', taxNumber: '1234567890' },
            currency: 'TRL',
            issueDate: '2026-05-06',
            shipmentIncluded: false,
            documentType: 'e_archive',
            description: 'Sevkiyat: TRF-0042',
            invoiceSeriesPrefix: 'IM',
            productionLocationId: 'central',
        })),
    });
}

// ---------------- Tests ----------------

describe('ApprovalProcessor — happy path', () => {
    test('100→95 with fire: Paraşüt POST + invoiceDoc=sent + transfer=completed + 4 movements + 1 waste + aggregate', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeFakeProvider();
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider, db, idem });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner-meltem',
            edits: [
                { itemIndex: 0, finalQty: 95, diffReason: 'fire' },
                { itemIndex: 1, finalQty: 5 },
            ],
        });

        expect(result.ok).toBe(true);
        expect(result.parasutInvoiceId).toMatch(/^parasut-inv-/);
        expect(result.fireQuantityTotal).toBe(5);

        // invoiceDocuments → sent
        const finalDoc = await idem.getById(docId);
        expect(finalDoc.status).toBe('sent');
        expect(finalDoc.parasutInvoiceId).toBe(result.parasutInvoiceId);
        expect(finalDoc.parasutEArchiveId).toMatch(/^e-archive-/);

        // stockTransfers → completed
        const transferAfter = await db.collection('stockTransfers').doc('TR-2026-0042').get();
        expect(transferAfter.data().status).toBe('completed');

        // inventoryMovements: 2 items × 2 movements (out+in) = 4 docs
        const movements = [...db._store.entries()].filter(([k]) => k.startsWith('inventoryMovements/'));
        expect(movements.length).toBe(4);
        const types = movements.map(([, v]) => v.type).sort();
        expect(types).toEqual(['shipment_in', 'shipment_in', 'shipment_out', 'shipment_out']);

        // wasteRecords: 1 (only itemIndex=0 had fire diff)
        const wastes = [...db._store.entries()].filter(([k]) => k.startsWith('wasteRecords/'));
        expect(wastes.length).toBe(1);
        expect(wastes[0][1]).toMatchObject({
            tenantId: 'bafetto-001',
            branchId: 'b-kadikoy',
            productId: 'p1',
            quantity: 5,
            sourceType: 'invoice_approval',
            sourceId: docId,
            reason: 'fire',
        });

        // branchInventory aggregate
        const aggSnap = await db.collection('branchInventory').doc('bafetto-001').get();
        expect(aggSnap.exists).toBe(true);
        const agg = aggSnap.data();
        expect(agg.branches['b-kadikoy']['p1'].quantity).toBe(95);
        expect(agg.branches['b-kadikoy']['p2'].quantity).toBe(5);
        expect(agg.production['p1'].quantity).toBe(-95);
        expect(agg.production['p2'].quantity).toBe(-5);
    });

    test('no edits (default finalQty=originalQty): branch +100 + 5, no waste', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeFakeProvider();
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider, db, idem });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        expect(result.ok).toBe(true);
        expect(result.fireQuantityTotal).toBe(0);

        const wastes = [...db._store.entries()].filter(([k]) => k.startsWith('wasteRecords/'));
        expect(wastes.length).toBe(0);

        const agg = (await db.collection('branchInventory').doc('bafetto-001').get()).data();
        expect(agg.branches['b-kadikoy']['p1'].quantity).toBe(100);
        expect(agg.branches['b-kadikoy']['p2'].quantity).toBe(5);
    });
});

describe('ApprovalProcessor — Paraşüt failure', () => {
    test('createInvoice fails -> status reverts to pending_approval, NO Firestore writes', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeFakeProvider({
            createInvoice: async () => {
                const e = new Error('parasut down');
                e.status = 503;
                e.code = 'NETWORK_TIMEOUT';
                throw e;
            },
        });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider, db, idem });

        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [{ itemIndex: 0, finalQty: 95, diffReason: 'fire' }],
        })).rejects.toMatchObject({
            status: 503,
            code: 'NETWORK_TIMEOUT',
        });

        const finalDoc = await idem.getById(docId);
        expect(finalDoc.status).toBe('pending_approval');
        expect(finalDoc.lastError.message).toContain('parasut down');

        // No inventoryMovements / wasteRecords / branchInventory writes
        const movements = [...db._store.entries()].filter(([k]) => k.startsWith('inventoryMovements/'));
        expect(movements.length).toBe(0);
        const wastes = [...db._store.entries()].filter(([k]) => k.startsWith('wasteRecords/'));
        expect(wastes.length).toBe(0);
        const aggSnap = await db.collection('branchInventory').doc('bafetto-001').get();
        expect(aggSnap.exists).toBe(false);
    });
});

describe('ApprovalProcessor — idempotency / double-approve', () => {
    test('second approve on already-sent doc returns 409', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeFakeProvider();
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider, db, idem });

        await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [{ itemIndex: 0, finalQty: 95, diffReason: 'fire' }],
        });
        // Second attempt
        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [{ itemIndex: 0, finalQty: 95, diffReason: 'fire' }],
        })).rejects.toMatchObject({ status: 409, code: 'already_sent' });
    });

    test('approve on cancelled doc returns 409', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        await idem.update(docId, { status: 'cancelled' });
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
        })).rejects.toMatchObject({ status: 409, code: 'cancelled' });
    });

    test('approve on non-existent doc returns 404', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve('nope', {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
        })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    });
});

describe('ApprovalProcessor — input validation', () => {
    test('missing tenantId -> 400', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, { approvedBy: 'x' })).rejects.toMatchObject({
            status: 400,
            code: 'missing_tenantId',
        });
    });

    test('cross-tenant approve -> 403', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, {
            tenantId: 't-other',
            approvedBy: 'attacker',
        })).rejects.toMatchObject({ status: 403, code: 'tenant_mismatch' });
    });

    test('missing approvedBy -> 400', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, { tenantId: 'bafetto-001' })).rejects.toMatchObject({
            status: 400,
            code: 'missing_approvedBy',
        });
    });

    test('finalQty out of range (>originalQty) -> 400', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [{ itemIndex: 0, finalQty: 105 }],
        })).rejects.toMatchObject({ status: 400, code: 'finalQty_out_of_range' });
    });

    test('diff > 0 without diffReason -> 400', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [{ itemIndex: 0, finalQty: 90 }],  // diff=10 but no reason
        })).rejects.toMatchObject({ status: 400, code: 'missing_diffReason' });
    });
});

describe('ApprovalProcessor — Firestore txn failure → compensating delete', () => {
    test('txn failure triggers Paraşüt cancelDocument', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const deleteSpy = jest.fn(async () => ({ ok: true }));
        const provider = makeFakeProvider({ cancelDocument: deleteSpy });

        // Inject txn failure: swap runTransaction to throw
        const origTxn = db.runTransaction.bind(db);
        db.runTransaction = async () => { throw new Error('synthetic txn failure'); };

        const docId = await seedDraftWithItems(db, idem);
        const proc = makeProcessor({ provider, db, idem });

        await expect(proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
        })).rejects.toMatchObject({ status: 500, code: 'firestore_txn_failed' });

        // Compensating delete called with provider invoice id
        expect(deleteSpy).toHaveBeenCalledWith('mock-token', expect.stringMatching(/^parasut-inv-/), 'firestore_txn_failed_compensation');

        // Doc back to pending_approval
        const finalDoc = await idem.getById(docId);
        expect(finalDoc.status).toBe('pending_approval');
        expect(finalDoc.lastError.code).toBe('firestore_txn_failed');

        // Restore (cleanliness)
        db.runTransaction = origTxn;
    });
});

describe('ApprovalProcessor — items-less legacy doc', () => {
    test('doc with empty items[] still approves with single fallback item from amount', async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const r = await idem.ensureDraft({
            tenantId: 'bafetto-001',
            sourceType: 'stockTransfer',
            sourceId: 'TR-LEGACY',
            data: { branchId: 'b1', amount: 500, currency: 'TRL', items: [] },
        });
        await db.collection('stockTransfers').doc('TR-LEGACY').set({ tenantId: 'bafetto-001', status: 'shipped' });
        const proc = makeProcessor({ provider: makeFakeProvider(), db, idem });

        const result = await proc.approve(r.id, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
        });
        expect(result.ok).toBe(true);

        // No inventoryMovements (no items)
        const movements = [...db._store.entries()].filter(([k]) => k.startsWith('inventoryMovements/'));
        expect(movements.length).toBe(0);
    });
});

// ============================================================================
// Plan 28++++ — YOL A (useExistingDraft) + 'auto' documentType + checkVknInbox
// ============================================================================
// Bu suite Plan 28+ taslak akisini test eder: seed doc'a parasutInvoiceId set edilir,
// boylece ApprovalProcessor useExistingDraft=true ile YOL A (updateDraft + finalizeInvoice)
// yoluna girer. checkVknInbox sonucuna gore documentType dinamik secilir.

function makeYolAProvider(overrides = {}) {
    let invCounter = 1;
    const defaults = {
        providerName: 'parasut',
        upsertContact: jest.fn(async () => ({ contactId: 'contact-1' })),
        upsertProduct: jest.fn(async (_t, p) => ({ productId: 'p-' + (p.productId || p.sku || 'x') })),
        updateDraftInvoice: jest.fn(async () => ({
            providerInvoiceId: 'draft-1',
            invoiceNumber: null,
            pdfUrl: 'https://parasut.test/draft/1',
        })),
        finalizeInvoice: jest.fn(async (_t, providerInvoiceId, _opts) => ({
            providerInvoiceId,
            eDocId: `e-doc-${invCounter++}`,
            eDocType: 'e_archive', // default; specific tests override
            pdfUrl: 'https://parasut.test/pdf/x',
            invoiceNumber: 'IM2026-AUTO-0001',
        })),
        checkVknInbox: jest.fn(async () => ({ registered: false })),
        cancelDocument: jest.fn(async () => ({ ok: true })),
    };
    return { ...defaults, ...overrides };
}

async function seedDraftYolA(db, idem, overrides = {}) {
    const r = await idem.ensureDraft({
        tenantId: 'bafetto-001',
        sourceType: 'stockTransfer',
        sourceId: 'TR-YOL-A-0001',
        data: {
            branchId: 'b-kadikoy',
            sourceTransferNumber: 'TRF-YOL-A',
            amount: 1000,
            currency: 'TRL',
            items: [
                { itemIndex: 0, productId: 'p1', productName: 'Pizza Hamuru', unit: 'paket', unitPrice: 25, vatRate: 20, originalQuantity: 40 },
            ],
            ...overrides.data,
        },
    });
    // Plan 28+ listener mock: parasutInvoiceId zaten yazilmis (taslak mevcut)
    await idem.update(r.id, { parasutInvoiceId: 'draft-1', parasutContactId: 'contact-1' });
    await db.collection('stockTransfers').doc('TR-YOL-A-0001').set({
        tenantId: 'bafetto-001',
        status: 'shipped',
        items: [
            { productId: 'p1', productName: 'Pizza Hamuru', quantity: 40, unitPrice: 25, vatRate: 20, unit: 'paket' },
        ],
    });
    return r.id;
}

describe('ApprovalProcessor — Plan 28++++ B2B/B2C dinamik secim (auto)', () => {
    test("documentType='auto' + VKN registered=true → finalizeInvoice e_invoice ile cagrilir", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider({
            checkVknInbox: jest.fn(async () => ({ registered: true, alias: 'urn:mail:b2b@firma.com' })),
            finalizeInvoice: jest.fn(async (_t, id) => ({
                providerInvoiceId: id,
                eDocId: 'e-inv-100',
                eDocType: 'e_invoice',
                pdfUrl: 'https://parasut.test/pdf/inv-100',
                invoiceNumber: 'EFT2026-001',
            })),
        });
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'Bafetto Kadikoy', taxNumber: '1234567890' },
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                documentType: 'auto', // ← opt-in
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
            }),
        });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        expect(result.ok).toBe(true);
        expect(provider.checkVknInbox).toHaveBeenCalledWith('mock-token', '1234567890');
        expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1);
        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2]).toMatchObject({ documentType: 'e_invoice' });
        expect(finalizeArgs[2].eArchiveAttrs).toBeUndefined();
        expect(result.eDocType).toBe('e_invoice');
        expect(result.eInvoiceId).toBe('e-inv-100');
        expect(result.eArchiveId).toBeNull();
        expect(result.documentTypeResolved).toBe('e_invoice');
        expect(result.vknRegistered).toBe(true);
    });

    test("documentType='auto' + VKN registered=false → finalizeInvoice e_archive ile cagrilir", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider({
            checkVknInbox: jest.fn(async () => ({ registered: false })),
            finalizeInvoice: jest.fn(async (_t, id) => ({
                providerInvoiceId: id,
                eDocId: 'e-arc-200',
                eDocType: 'e_archive',
                pdfUrl: 'https://parasut.test/pdf/arc-200',
                invoiceNumber: 'A2026-200',
            })),
        });
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'Bafetto Maltepe', taxNumber: '9876543210' },
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                documentType: 'auto',
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
            }),
        });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        expect(result.ok).toBe(true);
        expect(provider.checkVknInbox).toHaveBeenCalledWith('mock-token', '9876543210');
        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2]).toMatchObject({
            documentType: 'e_archive',
            eArchiveAttrs: { internet_sale: {} },
        });
        expect(result.eDocType).toBe('e_archive');
        expect(result.eArchiveId).toBe('e-arc-200');
        expect(result.eInvoiceId).toBeNull();
        expect(result.documentTypeResolved).toBe('e_archive');
        expect(result.vknRegistered).toBe(false);
    });

    test("documentType='auto' + VKN bos → checkVknInbox cagrilmaz, e_archive fallback", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider();
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'VKN siz sube', taxNumber: '' },
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                documentType: 'auto',
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
            }),
        });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        expect(result.ok).toBe(true);
        expect(provider.checkVknInbox).not.toHaveBeenCalled();
        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2].documentType).toBe('e_archive');
        expect(result.documentTypeResolved).toBe('e_archive');
        expect(result.vknRegistered).toBeNull();
    });

    test("ctx.internetSale override → finalizeInvoice eArchiveAttrs.internet_sale'e gecer", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider();
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'Sube', taxNumber: '' }, // VKN yok → e_archive yolu
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                documentType: 'auto',
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
                internetSale: {
                    payment_type: 'EFT/HAVALE',
                    payment_platform: 'BANKA',
                },
            }),
        });

        await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2].eArchiveAttrs.internet_sale).toEqual({
            payment_type: 'EFT/HAVALE',
            payment_platform: 'BANKA',
        });
    });

    test("documentType=undefined (eski davranis) → finalizeInvoice bos options ile cagrilir", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider();
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'Sube', taxNumber: '1234567890' },
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                // documentType yok (eski tenant)
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
            }),
        });

        await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        // Geriye uyumluluk: checkVknInbox cagrilmamali (sadece 'auto' opt-in tetikler)
        expect(provider.checkVknInbox).not.toHaveBeenCalled();
        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2]).toEqual({}); // bos options → Parasut otomatik
    });

    test("checkVknInbox throw → e_archive fallback, akis bozulmaz", async () => {
        const db = makeFakeDb();
        const idem = new IdempotencyService({ db });
        const provider = makeYolAProvider({
            checkVknInbox: jest.fn(async () => { throw new Error('parasut e_invoice_inboxes timeout'); }),
        });
        const docId = await seedDraftYolA(db, idem);
        const proc = makeProcessor({
            provider,
            db,
            idem,
            contextLoader: async () => ({
                branch: { name: 'Sube', taxNumber: '1234567890' },
                currency: 'TRL',
                issueDate: '2026-05-23',
                shipmentIncluded: false,
                documentType: 'auto',
                description: 'Sevkiyat: TRF-YOL-A',
                invoiceSeriesPrefix: 'IM',
                productionLocationId: 'central',
            }),
        });

        const result = await proc.approve(docId, {
            tenantId: 'bafetto-001',
            approvedBy: 'owner',
            edits: [],
        });

        expect(result.ok).toBe(true);
        const finalizeArgs = provider.finalizeInvoice.mock.calls[0];
        expect(finalizeArgs[2].documentType).toBe('e_archive');
        expect(result.documentTypeResolved).toBe('e_archive');
    });
});
