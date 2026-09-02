// InboxInvoiceService — tedarikci sinifi (stock/service/unclassified), satir bazinda konum,
// onayda birim cevrimi (02.09.2026, Davut karari: tedarikci = filtre, urun = konum).

const { InboxInvoiceService, normalizeLocation, locationBranchId } = require('../lib/InboxInvoiceService');

const T = 'tenantA';
const SASKIN = 'branchSaskin';
const Timestamp = { fromMillis: (ms) => ({ _ms: ms }) };

function makeDb(seed = {}) {
    const docs = new Map(Object.entries(seed));
    let autoId = 0;
    const ref = (path) => ({
        _key: path,
        id: path.split('/').pop(),
        async get() { const d = docs.get(path); return { exists: !!d, data: () => d, id: path.split('/').pop() }; },
        async set(data, opts) { const cur = docs.get(path); docs.set(path, opts && opts.merge && cur ? { ...cur, ...data } : data); },
        collection(sub) { return coll(path + '/' + sub); },
    });
    const query = (prefix, filters, lim) => ({
        where(f, _op, v) { return query(prefix, [...filters, [f, v]], lim); },
        limit(n) { return query(prefix, filters, n); },
        async get() {
            const out = [];
            for (const [k, d] of docs) {
                if (!k.startsWith(prefix + '/') || k.slice(prefix.length + 1).includes('/')) continue;
                if (filters.every(([f, v]) => d[f] === v)) out.push({ id: k.split('/').pop(), data: () => d });
            }
            return { docs: lim ? out.slice(0, lim) : out };
        },
    });
    const coll = (prefix) => ({
        doc(id) { return ref(prefix + '/' + (id || `auto${++autoId}`)); },
        where(f, op, v) { return query(prefix, []).where(f, op, v); },
        limit(n) { return query(prefix, [], n); },
        async get() { return query(prefix, []).get(); },
    });
    return {
        _docs: docs,
        collection(name) { return coll(name); },
        async runTransaction(fn) {
            let wrote = false;
            const txn = {
                async get(r) { if (wrote) throw new Error('reads before writes!'); return r.get(); },
                set(r, data, opts) { wrote = true; r.set(data, opts); },
            };
            return fn(txn);
        },
    };
}

function svc(db) {
    return new InboxInvoiceService({ db, Timestamp, providerFactory: async () => ({ providerName: 'parasut', supportsDocumentResponse: false }), now: () => 1000, logger: { warn() {}, log() {} } });
}

const moves = (db) => [...db._docs.entries()].filter(([k]) => k.startsWith('stockMovements/')).map(([, v]) => v);

describe('normalizeLocation', () => {
    it("'imalat' ve 'imalat_<tenant>' ayni konuma, sube id aynen", () => {
        expect(normalizeLocation('imalat', T)).toBe('imalat');
        expect(normalizeLocation(`imalat_${T}`, T)).toBe('imalat');
        expect(normalizeLocation(SASKIN, T)).toBe(SASKIN);
        expect(normalizeLocation('', T)).toBeNull();
        expect(locationBranchId('imalat', T)).toBe(`imalat_${T}`);
        expect(locationBranchId(SASKIN, T)).toBe(SASKIN);
    });
});

describe('listInvoices — tedarikci sinifi', () => {
    it('profil > eslesme kaydi > unclassified; sayimlar doner', async () => {
        const db = makeDb({
            'incomingInvoices/a': { tenantId: T, supplierVkn: '111', status: 'new', invoiceCreateDateUtc: '2026-09-01' },
            'incomingInvoices/b': { tenantId: T, supplierVkn: '222', status: 'new', invoiceCreateDateUtc: '2026-09-02', parsed: { x: 1 } },
            'incomingInvoices/c': { tenantId: T, supplierVkn: '333', status: 'new', invoiceCreateDateUtc: '2026-08-30' },
            'incomingInvoices/d': { tenantId: T, supplierVkn: '444', status: 'approved', invoiceCreateDateUtc: '2026-08-29' },
            'incomingInvoices/z': { tenantId: 'other', supplierVkn: '111', status: 'new' },
            [`tenants/${T}/supplierProfiles/222`]: { vkn: '222', kind: 'service' },
            [`tenants/${T}/supplierProfiles/444`]: { vkn: '444', kind: 'stock', defaultLocation: SASKIN },
            'supplierProductMappings/m1': { tenantId: T, supplierVkn: '111', inventoryProductId: 'inv1' },
            'supplierProductMappings/m2': { tenantId: T, supplierVkn: '222', inventoryProductId: 'inv2' }, // profil 'service' eslesmeyi ezer
        });
        const r = await svc(db).listInvoices({ tenantId: T });
        expect(r.count).toBe(4);
        const by = Object.fromEntries(r.items.map((i) => [i.supplierVkn, i]));
        expect(by['111']).toMatchObject({ supplierKind: 'stock', supplierKindSource: 'mapping' });
        expect(by['222']).toMatchObject({ supplierKind: 'service', supplierKindSource: 'profile', hasLines: true });
        expect(by['222'].parsed).toBeUndefined();
        expect(by['333']).toMatchObject({ supplierKind: 'unclassified' });
        expect(by['444']).toMatchObject({ supplierKind: 'stock', supplierDefaultLocation: SASKIN });
        expect(r.counts).toEqual({ stock: 2, service: 1, unclassified: 1 });
        expect(r.items[0].supplierVkn).toBe('222'); // en yeni ustte
    });

    it('status filtresi', async () => {
        const db = makeDb({
            'incomingInvoices/a': { tenantId: T, supplierVkn: '1', status: 'new', invoiceCreateDateUtc: '1' },
            'incomingInvoices/b': { tenantId: T, supplierVkn: '1', status: 'approved', invoiceCreateDateUtc: '2' },
        });
        const r = await svc(db).listInvoices({ tenantId: T, status: 'new' });
        expect(r.count).toBe(1);
    });
});

describe('approveInvoice — satir bazinda konum + birim', () => {
    const base = () => ({
        'incomingInvoices/tenantA__inv1': { tenantId: T, invoiceId: 'inv1', documentId: 'HKG1', supplierVkn: '460', supplierTitle: 'Hayri Kaptan', status: 'new', invoiceExecutionDate: '2026-09-01' },
        [`branchStocks/imalat_${T}_un`]: { currentStock: 333, unit: 'kg' },
        [`branchStocks/${SASKIN}_tavuk`]: { currentStock: 500, unit: 'g' },
    });

    it("un imalata, tavuk Saskinbakkal'a: ayni faturada iki konum; kg->g cevrimi; eslesme konumu ogrenir", async () => {
        const db = makeDb(base());
        const r = await svc(db).approveInvoice({
            tenantId: T, invoiceId: 'inv1', branchId: `imalat_${T}`, approvedBy: 'panel:u1',
            items: [
                { inventoryProductId: 'un', productName: 'Pizza Unu', quantity: 1250, unit: 'kg', unitMultiplier: 25, mappingSource: { sellerCode: 'A-001', name: 'Ova 25kg' } },
                { inventoryProductId: 'tavuk', productName: 'Tavuk', quantity: 9.035, unit: 'kg', targetLocation: SASKIN, mappingSource: { sellerCode: 'GGS035', name: 'Gogus' } },
            ],
        });
        expect(r.ok).toBe(true); expect(r.stockEntries).toBe(2);
        expect(db._docs.get(`branchStocks/imalat_${T}_un`)).toMatchObject({ currentStock: 1583, unit: 'kg' });
        // tavuk: sube satiri gram tutuyor -> 9.035 kg = 9035 g, satir birimi g kalir
        expect(db._docs.get(`branchStocks/${SASKIN}_tavuk`)).toMatchObject({ currentStock: 9535, unit: 'g', branchId: SASKIN });
        expect(db._docs.get(`branchStocks/imalat_${T}_tavuk`)).toBeUndefined();
        const mv = moves(db);
        expect(mv).toHaveLength(2);
        const tv = mv.find((m) => m.productId === 'tavuk');
        expect(tv).toMatchObject({ movementType: 'INVOICE_ENTRY', branchId: SASKIN, quantity: 9035, unit: 'g', sourceQuantity: 9.035, sourceUnit: 'kg', targetLocation: SASKIN });
        expect(tv.unitMismatch).toBeUndefined();
        const doc = db._docs.get('incomingInvoices/tenantA__inv1');
        expect(doc.status).toBe('approved');
        expect(doc.approval.locations).toEqual(['imalat', SASKIN]);
        expect(doc.approval.items[1].targetLocation).toBe(SASKIN);
        // eslesme kaydi konumu ogrendi
        const maps = [...db._docs.entries()].filter(([k]) => k.startsWith('supplierProductMappings/')).map(([, v]) => v);
        expect(maps.find((m) => m.inventoryProductId === 'tavuk').targetLocation).toBe(SASKIN);
        expect(maps.find((m) => m.inventoryProductId === 'un').targetLocation).toBe('imalat');
    });

    it("govde branchId 'imalat_<tenant>' eski panel icin calisir; konum secilmemis kalem reddedilir", async () => {
        const db = makeDb(base());
        await expect(svc(db).approveInvoice({ tenantId: T, invoiceId: 'inv1', items: [{ inventoryProductId: 'un', productName: 'Un', quantity: 1, unit: 'kg' }] }))
            .rejects.toMatchObject({ code: 'NO_LOCATION' });
        const r = await svc(db).approveInvoice({ tenantId: T, invoiceId: 'inv1', branchId: `imalat_${T}`, items: [{ inventoryProductId: 'un', productName: 'Un', quantity: 1, unit: 'kg' }] });
        expect(r.stockEntries).toBe(1);
        expect(db._docs.get(`branchStocks/imalat_${T}_un`).currentStock).toBe(334);
    });

    it('cevrilemeyen birim (adet -> g satiri) tahmin edilmez, unitMismatch isaretlenir', async () => {
        const db = makeDb(base());
        await svc(db).approveInvoice({ tenantId: T, invoiceId: 'inv1', branchId: SASKIN, items: [{ inventoryProductId: 'tavuk', productName: 'Tavuk', quantity: 3, unit: 'adet' }] });
        const tv = moves(db)[0];
        expect(tv).toMatchObject({ quantity: 3, unit: 'g', unitMismatch: true });
        expect(db._docs.get(`branchStocks/${SASKIN}_tavuk`)).toMatchObject({ currentStock: 503, unit: 'g' });
    });

    it('loadInvoiceLines: konum onerisi eslesme > profil', async () => {
        const db = makeDb({
            'incomingInvoices/tenantA__inv2': { tenantId: T, invoiceId: 'inv2', supplierVkn: '904', status: 'new', parsed: { supplier: { vkn: '904' }, lines: [{ lineNumber: '1', sellerCode: 'GGS035.03', name: 'Gogus' }, { lineNumber: '2', sellerCode: 'YENI', name: 'Yeni Urun' }] } },
            [`tenants/${T}/supplierProfiles/904`]: { vkn: '904', kind: 'stock', defaultLocation: SASKIN },
            'supplierProductMappings/tenantA__904__ggs035.03': { tenantId: T, supplierVkn: '904', inventoryProductId: 'tavuk', inventoryProductName: 'Tavuk', unitMultiplier: 1000, targetLocation: 'imalat' },
        });
        const r = await svc(db).loadInvoiceLines({ tenantId: T, invoiceId: 'inv2' });
        expect(r.lines[0]).toMatchObject({ suggestedInventoryProductId: 'tavuk', suggestedTargetLocation: 'imalat' });
        expect(r.lines[1]).toMatchObject({ suggestedInventoryProductId: null, suggestedTargetLocation: SASKIN });
        expect(r.supplierKind).toBe('stock');
    });
});

describe('logAccess — kim ne zaman bakti (02.09.2026)', () => {
    it('inboxAccessLog yazar; lines/pdf faturaya lastViewedAt/By yazar; hata yutulur', async () => {
        const db = makeDb({ 'incomingInvoices/tenantA__inv9': { tenantId: T, invoiceId: 'inv9', status: 'new' } });
        const s = svc(db);
        await s.logAccess({ tenantId: T, action: 'list', actor: { uid: 'u1', role: 'owner' }, meta: { status: 'new' } });
        await s.logAccess({ tenantId: T, action: 'lines', invoiceId: 'inv9', actor: { uid: 'u2', role: 'manager' } });
        const logs = [...db._docs.entries()].filter(([k]) => k.startsWith('inboxAccessLog/')).map(([, v]) => v);
        expect(logs).toHaveLength(2);
        expect(logs[0]).toMatchObject({ tenantId: T, action: 'list', actorUid: 'u1', actorRole: 'owner', invoiceId: null });
        expect(logs[1]).toMatchObject({ action: 'lines', invoiceId: 'inv9', actorUid: 'u2', actorRole: 'manager' });
        expect(db._docs.get('incomingInvoices/tenantA__inv9')).toMatchObject({ lastViewedBy: 'u2', lastViewedRole: 'manager', status: 'new' });
        // aktor yoksa 'unknown'; db patlasa bile fırlatmaz
        await s.logAccess({ tenantId: T, action: 'pdf', invoiceId: 'inv9' });
        expect([...db._docs.entries()].filter(([k]) => k.startsWith('inboxAccessLog/')).pop()[1]).toMatchObject({ actorUid: 'unknown', actorRole: 'unknown' });
        const broken = svc({ collection() { throw new Error('down'); } });
        await expect(broken.logAccess({ tenantId: T, action: 'list' })).resolves.toBeUndefined();
    });
});
