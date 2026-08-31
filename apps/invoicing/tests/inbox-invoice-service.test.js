// InboxInvoiceService birim testleri — fake Firestore (merge destekli) + fake provider.
// Kapsam: sync idempotency, UBL parse + oneri zenginlestirme, onay -> INVOICE_ENTRY +
// branchStocks, cift onay guard'i, red akisi, tenant izolasyonu, TICARIFATURA kurali.

const { InboxInvoiceService } = require('../lib/InboxInvoiceService');

const TENANT = 'tenant-1';
const INV = 'inv-uuid-1';
const DOC_ID = `${TENANT}__${INV}`;

const Timestamp = { fromMillis: (ms) => ({ _ms: ms }) };

function applyMerge(existing, patch) {
    return { ...(existing || {}), ...patch };
}

function makeFakeDb() {
    const store = new Map();
    let auto = 1;
    function refFor(coll, id) {
        if (!id) id = `${coll}-auto-${auto++}`;
        const key = `${coll}/${id}`;
        return {
            id,
            _key: key,
            get: async () => ({ exists: store.has(key), data: () => store.get(key), id }),
            set: async (d, opts) => {
                if (opts && opts.merge && store.has(key)) store.set(key, applyMerge(store.get(key), d));
                else store.set(key, d);
            },
        };
    }
    return {
        _store: store,
        collection(coll) {
            return { doc(id) { return refFor(coll, id); } };
        },
        async runTransaction(fn) {
            let wrote = false;
            const txn = {
                async get(ref) {
                    if (wrote) throw new Error('reads before writes!');
                    return { exists: store.has(ref._key), data: () => store.get(ref._key) };
                },
                set(ref, data, opts) {
                    wrote = true;
                    if (opts && opts.merge && store.has(ref._key)) store.set(ref._key, applyMerge(store.get(ref._key), data));
                    else store.set(ref._key, data);
                },
            };
            return fn(txn);
        },
    };
}

const UBL = `<?xml version="1.0"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>CCI2026000012345</cbc:ID>
  <cbc:UUID>${INV}</cbc:UUID>
  <cbc:IssueDate>2026-08-01</cbc:IssueDate>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="VKN">2110056338</cbc:ID></cac:PartyIdentification>
    <cac:PartyName><cbc:Name>COCA-COLA A.S.</cbc:Name></cac:PartyName>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="TRY">720.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="CT">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">600.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Coca-Cola 1 L Pet</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>CC-1L-12</cbc:ID></cac:SellersItemIdentification></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">60.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

function makeProvider(overrides = {}) {
    return {
        providerName: 'uyumsoft',
        listInboxInvoices: jest.fn(),
        getInboxInvoiceXml: jest.fn(async () => ({ invoiceId: INV, xml: UBL })),
        sendDocumentResponse: jest.fn(async () => ({ ok: true })),
        ...overrides,
    };
}

function makeService(db, provider) {
    return new InboxInvoiceService({
        db,
        Timestamp,
        providerFactory: async () => provider,
        now: () => 1754200000000,
        logger: { warn: () => {}, error: () => {} },
    });
}

const LIST_ITEM = {
    invoiceId: INV,
    documentId: 'CCI2026000012345',
    invoiceTipType: 'Sales',
    counterpartyVkn: '2110056338',
    counterpartyTitle: 'COCA-COLA A.S.',
    payableAmount: 720,
    taxTotal: 120,
    taxExclusiveAmount: 600,
    currency: 'TRY',
    createDateUtc: '2026-08-01T09:15:00Z',
    executionDate: '2026-08-01T00:00:00',
    isNew: true,
    isSeen: false,
};

describe('syncInbox', () => {
    test('yeni fatura incomingInvoices dokumanina yazilir (status=new)', async () => {
        const db = makeFakeDb();
        const provider = makeProvider({
            listInboxInvoices: jest.fn(async () => ({ pageIndex: 0, pageSize: 50, totalCount: 1, totalPages: 1, items: [LIST_ITEM] })),
        });
        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT });
        expect(r).toMatchObject({ ok: true, created: 1, skipped: 0, totalCount: 1 });
        const doc = db._store.get(`incomingInvoices/${DOC_ID}`);
        expect(doc.status).toBe('new');
        expect(doc.tenantId).toBe(TENANT);
        expect(doc.supplierVkn).toBe('2110056338');
        expect(doc.documentId).toBe('CCI2026000012345');
    });

    test('mevcut dokuman EZILMEZ — onaylanmis fatura senkronla new olmaz', async () => {
        const db = makeFakeDb();
        db._store.set(`incomingInvoices/${DOC_ID}`, { tenantId: TENANT, status: 'approved', approval: { branchId: 'b1' } });
        const provider = makeProvider({
            listInboxInvoices: jest.fn(async () => ({ pageIndex: 0, pageSize: 50, totalCount: 1, totalPages: 1, items: [LIST_ITEM] })),
        });
        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT });
        expect(r).toMatchObject({ created: 0, skipped: 1 });
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).status).toBe('approved');
    });

    test('sayfalama: totalCount bitince durur', async () => {
        const db = makeFakeDb();
        const items2 = [{ ...LIST_ITEM, invoiceId: 'inv-2' }];
        const listFn = jest.fn()
            .mockResolvedValueOnce({ pageIndex: 0, pageSize: 1, totalCount: 2, totalPages: 2, items: [LIST_ITEM] })
            .mockResolvedValueOnce({ pageIndex: 1, pageSize: 1, totalCount: 2, totalPages: 2, items: items2 });
        const provider = makeProvider({ listInboxInvoices: listFn });
        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT, pageSize: 1 });
        expect(listFn).toHaveBeenCalledTimes(2);
        expect(r.created).toBe(2);
    });
});

describe('loadInvoiceLines', () => {
    function seed(db, extra = {}) {
        db._store.set(`incomingInvoices/${DOC_ID}`, {
            tenantId: TENANT, invoiceId: INV, status: 'new',
            documentId: 'CCI2026000012345', supplierVkn: '2110056338', ...extra,
        });
    }

    test('UBL ceker, parse eder, dokumana yazar', async () => {
        const db = makeFakeDb();
        seed(db);
        const provider = makeProvider();
        const r = await makeService(db, provider).loadInvoiceLines({ tenantId: TENANT, invoiceId: INV });
        expect(provider.getInboxInvoiceXml).toHaveBeenCalledWith(INV);
        expect(r.invoiceNumber).toBe('CCI2026000012345');
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0].unitLabel).toBe('koli');
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).parsed.profileId).toBe('TICARIFATURA');
    });

    test('parse edilmisse tekrar CEKMEZ (cache)', async () => {
        const db = makeFakeDb();
        seed(db, { parsed: { supplier: { vkn: '2110056338', title: 'X' }, lines: [], totals: {}, profileId: 'TICARIFATURA' } });
        const provider = makeProvider();
        await makeService(db, provider).loadInvoiceLines({ tenantId: TENANT, invoiceId: INV });
        expect(provider.getInboxInvoiceXml).not.toHaveBeenCalled();
    });

    test('ogrenilmis eslesme onerisi kalemlere eklenir', async () => {
        const db = makeFakeDb();
        seed(db);
        db._store.set(`supplierProductMappings/${TENANT}__2110056338__cc-1l-12`, {
            inventoryProductId: 'inv-prod-cola', inventoryProductName: 'Kola 1L', unitMultiplier: 12,
        });
        const r = await makeService(db, makeProvider()).loadInvoiceLines({ tenantId: TENANT, invoiceId: INV });
        expect(r.lines[0].suggestedInventoryProductId).toBe('inv-prod-cola');
        expect(r.lines[0].suggestedUnitMultiplier).toBe(12);
    });

    test('cross-tenant erisim reddedilir', async () => {
        const db = makeFakeDb();
        db._store.set(`incomingInvoices/${DOC_ID}`, { tenantId: 'BASKA-TENANT', status: 'new' });
        await expect(makeService(db, makeProvider()).loadInvoiceLines({ tenantId: TENANT, invoiceId: INV }))
            .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });
});

describe('approveInvoice', () => {
    function seed(db, extra = {}) {
        db._store.set(`incomingInvoices/${DOC_ID}`, {
            tenantId: TENANT, invoiceId: INV, status: 'new',
            documentId: 'CCI2026000012345', supplierTitle: 'COCA-COLA A.S.', supplierVkn: '2110056338',
            invoiceExecutionDate: '2026-08-01T00:00:00',
            parsed: { profileId: 'TICARIFATURA', supplier: { vkn: '2110056338', title: 'COCA-COLA A.S.' }, invoiceNumber: 'CCI2026000012345' },
            ...extra,
        });
    }
    const ITEMS = [
        { inventoryProductId: 'inv-prod-cola', productName: 'Kola 1L', quantity: 120, unit: 'adet', lineNumber: '1', unitMultiplier: 12, mappingSource: { sellerCode: 'CC-1L-12', name: 'Coca-Cola 1 L Pet' } },
    ];

    test('INVOICE_ENTRY hareketi + branchStocks artisi + status=approved', async () => {
        const db = makeFakeDb();
        seed(db);
        db._store.set('branchStocks/branch-1_inv-prod-cola', { currentStock: 30, productName: 'Kola 1L' });
        const provider = makeProvider();
        const r = await makeService(db, provider).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'panel:u1',
        });
        expect(r).toMatchObject({ ok: true, alreadyApproved: false, stockEntries: 1 });

        const stock = db._store.get('branchStocks/branch-1_inv-prod-cola');
        expect(stock.currentStock).toBe(150); // 30 + 120
        expect(stock.tenantId).toBe(TENANT); // panel yazimlarinda eksikti — burada zorunlu

        const moves = [...db._store.entries()].filter(([k]) => k.startsWith('stockMovements/'));
        expect(moves).toHaveLength(1);
        const mv = moves[0][1];
        expect(mv.movementType).toBe('INVOICE_ENTRY');
        expect(mv.quantity).toBe(120);
        expect(mv.sourceType).toBe('incoming_invoice');
        expect(mv.invoiceInfo).toMatchObject({ invoiceNo: 'CCI2026000012345', supplierName: 'COCA-COLA A.S.' });

        expect(db._store.get(`incomingInvoices/${DOC_ID}`).status).toBe('approved');
        // TICARIFATURA -> Uyumsoft'a Approve gitti
        expect(provider.sendDocumentResponse).toHaveBeenCalledWith([
            expect.objectContaining({ invoiceId: INV, status: 'Approved' }),
        ]);
    });

    test('IKINCI onay stok YAZMAZ (idempotent)', async () => {
        const db = makeFakeDb();
        seed(db);
        const svc = makeService(db, makeProvider());
        await svc.approveInvoice({ tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u' });
        const r2 = await svc.approveInvoice({ tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u' });
        expect(r2.alreadyApproved).toBe(true);
        const moves = [...db._store.keys()].filter((k) => k.startsWith('stockMovements/'));
        expect(moves).toHaveLength(1); // ikinci cagride yeni hareket yok
    });

    test('eslesme ogrenilir: supplierProductMappings yazilir', async () => {
        const db = makeFakeDb();
        seed(db);
        await makeService(db, makeProvider()).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u',
        });
        const m = db._store.get(`supplierProductMappings/${TENANT}__2110056338__cc-1l-12`);
        expect(m).toMatchObject({ inventoryProductId: 'inv-prod-cola', unitMultiplier: 12 });
    });

    test('TEMELFATURA -> Uyumsoft cevabi DENENMEZ (GIB kabul etmez)', async () => {
        const db = makeFakeDb();
        seed(db, { parsed: { profileId: 'TEMELFATURA', supplier: { vkn: '2110056338', title: 'X' }, invoiceNumber: 'N' } });
        const provider = makeProvider();
        const r = await makeService(db, provider).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u',
        });
        expect(provider.sendDocumentResponse).not.toHaveBeenCalled();
        expect(r.providerResponse.attempted).toBe(false);
    });

    test('SendDocumentResponse hatasi onayi BOZMAZ (best-effort)', async () => {
        const db = makeFakeDb();
        seed(db);
        const provider = makeProvider({
            sendDocumentResponse: jest.fn(async () => { throw new Error('uyumsoft down'); }),
        });
        const r = await makeService(db, provider).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u',
        });
        expect(r.ok).toBe(true);
        expect(r.providerResponse).toMatchObject({ attempted: true, ok: false });
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).status).toBe('approved');
    });

    test('reddedilmis fatura onaylanamaz (409)', async () => {
        const db = makeFakeDb();
        seed(db, { status: 'declined' });
        await expect(makeService(db, makeProvider()).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: ITEMS, approvedBy: 'u',
        })).rejects.toMatchObject({ code: 'ALREADY_DECLINED', status: 409 });
    });

    test('eslesmis kalem yoksa 400', async () => {
        const db = makeFakeDb();
        seed(db);
        await expect(makeService(db, makeProvider()).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'branch-1', items: [{ quantity: 0 }], approvedBy: 'u',
        })).rejects.toMatchObject({ code: 'NO_ITEMS', status: 400 });
    });
});

describe('declineInvoice', () => {
    test('status=declined + TICARIFATURA Decline cevabi', async () => {
        const db = makeFakeDb();
        db._store.set(`incomingInvoices/${DOC_ID}`, {
            tenantId: TENANT, status: 'new',
            parsed: { profileId: 'TICARIFATURA', supplier: {} },
        });
        const provider = makeProvider();
        const r = await makeService(db, provider).declineInvoice({
            tenantId: TENANT, invoiceId: INV, reason: 'Eksik mal', declinedBy: 'u',
        });
        expect(r.ok).toBe(true);
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).status).toBe('declined');
        expect(provider.sendDocumentResponse).toHaveBeenCalledWith([
            expect.objectContaining({ status: 'Declined', reason: 'Eksik mal' }),
        ]);
    });

    test('onaylanmis fatura reddedilemez (409)', async () => {
        const db = makeFakeDb();
        db._store.set(`incomingInvoices/${DOC_ID}`, { tenantId: TENANT, status: 'approved' });
        await expect(makeService(db, makeProvider()).declineInvoice({
            tenantId: TENANT, invoiceId: INV, reason: 'x', declinedBy: 'u',
        })).rejects.toMatchObject({ code: 'ALREADY_APPROVED', status: 409 });
    });
});

// --------------------------------------------------------------------------------
// 2026-08-31 — saglayici bazli sayfalama + resmi cevabi desteklemeyen saglayici.
// Parasut'te API yon filtresi olmadigi icin bir sayfa tamamen GIDEN faturadan
// olusabilir; eski "items bos -> bitti" mantigi kalan gelen faturalari kaybediyordu.
// --------------------------------------------------------------------------------
describe('syncInbox — saglayici bildirimli sayfalama (hasMore)', () => {
    test('BOS sayfada bile hasMore true ise devam eder', async () => {
        const db = makeFakeDb();
        const listFn = jest.fn()
            // 1. sayfa: hepsi giden fatura -> items bos, ama daha var
            .mockResolvedValueOnce({ pageIndex: 0, pageSize: 25, totalCount: 100, totalPages: 4, hasMore: true, scannedOnPage: 25, items: [] })
            // 2. sayfa: gelen fatura burada
            .mockResolvedValueOnce({ pageIndex: 1, pageSize: 25, totalCount: 100, totalPages: 4, hasMore: false, scannedOnPage: 25, items: [LIST_ITEM] });
        const provider = makeProvider({ providerName: 'parasut', listInboxInvoices: listFn });

        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT, pageSize: 25 });
        expect(listFn).toHaveBeenCalledTimes(2);
        expect(r.created).toBe(1);
        expect(r.scanned).toBe(50);       // taranan API kaydi (iki yon birden)
        expect(r.fetched).toBe(1);        // bunlarin gelen olani
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).provider).toBe('parasut');
    });

    test('hasMore false ise totalCount daha buyuk olsa bile durur', async () => {
        const db = makeFakeDb();
        const listFn = jest.fn().mockResolvedValue({
            pageIndex: 0, pageSize: 25, totalCount: 6284, totalPages: 1, hasMore: false, scannedOnPage: 3, items: [LIST_ITEM],
        });
        const provider = makeProvider({ providerName: 'parasut', listInboxInvoices: listFn });
        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT, pageSize: 25 });
        expect(listFn).toHaveBeenCalledTimes(1);
        expect(r.truncated).toBe(false);
    });

    test('maxPages tavanina carpilirsa truncated bildirilir', async () => {
        const db = makeFakeDb();
        const listFn = jest.fn(async ({ pageIndex }) => ({
            pageIndex, pageSize: 25, totalCount: 6284, totalPages: 252, hasMore: true, scannedOnPage: 25,
            items: [{ ...LIST_ITEM, invoiceId: `inv-${pageIndex}` }],
        }));
        const provider = makeProvider({ providerName: 'parasut', listInboxInvoices: listFn });
        const r = await makeService(db, provider).syncInbox({ tenantId: TENANT, pageSize: 25, maxPages: 3 });
        expect(listFn).toHaveBeenCalledTimes(3);
        expect(r.truncated).toBe(true);
    });

    test('hasMore bildirmeyen saglayicida (Uyumsoft) eski davranis korunur', async () => {
        const db = makeFakeDb();
        // hasMore YOK + bos sayfa -> eski mantik gibi durmali
        const listFn = jest.fn().mockResolvedValue({ pageIndex: 0, pageSize: 25, totalCount: 999, totalPages: 40, items: [] });
        const provider = makeProvider({ listInboxInvoices: listFn });
        await makeService(db, provider).syncInbox({ tenantId: TENANT, pageSize: 25 });
        expect(listFn).toHaveBeenCalledTimes(1);
    });
});

describe('approveInvoice — resmi cevabi desteklemeyen saglayici', () => {
    test('Parasut: sendDocumentResponse CAGRILMAZ, dokumana unsupported yazilir', async () => {
        const db = makeFakeDb();
        db._store.set(`incomingInvoices/${DOC_ID}`, {
            tenantId: TENANT, invoiceId: INV, status: 'new',
            documentId: 'YB12026000176927', supplierTitle: 'YASAR', supplierVkn: '0610028531',
            parsed: { profileId: 'TICARIFATURA', supplier: { vkn: '0610028531', title: 'YASAR' } },
        });
        const provider = makeProvider({
            providerName: 'parasut',
            supportsDocumentResponse: false,
            sendDocumentResponse: jest.fn(async () => ({ ok: true })),
        });
        const r = await makeService(db, provider).approveInvoice({
            tenantId: TENANT, invoiceId: INV, branchId: 'imalat_tenant-1',
            items: [{ inventoryProductId: 'p1', productName: 'Mozzarella', quantity: 10, unit: 'kg' }],
            approvedBy: 'panel:u1',
        });
        expect(r.ok).toBe(true);
        expect(provider.sendDocumentResponse).not.toHaveBeenCalled();
        expect(db._store.get(`incomingInvoices/${DOC_ID}`).providerResponse)
            .toMatchObject({ attempted: false, unsupported: true, provider: 'parasut' });
        // stok girisi yine de yapilmis olmali (imalat deposuna)
        expect(db._store.get('branchStocks/imalat_tenant-1_p1').currentStock).toBe(10);
    });
});
