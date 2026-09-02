// CanonicalStockWriter — birim dönüşümü + satır birimini ezmeme (02.09.2026)
// Canlı vaka: Maltepe Zeytin 8.469 g + "1 kg" sipariş → eski yazım 8.470 "kg" yazdı.

jest.mock('firebase-admin/firestore', () => ({
    Timestamp: { fromMillis: (ms) => ({ _ms: ms }) },
}));

const { planCanonicalStock, readCanonicalStock, writeCanonicalStock } = require('../lib/CanonicalStockWriter');
const { convertQuantity, normalizeUnit } = require('../lib/UnitConversion');

function makeDb(seed = {}) {
    const docs = new Map(Object.entries(seed));
    let autoId = 0;
    const ref = (name, id) => ({
        _key: `${name}/${id}`,
        async get() { const d = docs.get(`${name}/${id}`); return { exists: !!d, data: () => d }; },
        set(data, opts) {
            const cur = docs.get(`${name}/${id}`);
            docs.set(`${name}/${id}`, opts && opts.merge && cur ? { ...cur, ...data } : data);
        },
    });
    return {
        _docs: docs,
        collection(name) {
            return { doc(id) { return ref(name, id || `auto${++autoId}`); } };
        },
        txn() {
            return {
                async get(r) { return r.get(); },
                set(r, data, opts) { r.set(data, opts); },
            };
        },
    };
}

const CTX = { tenantId: 'T', branchId: 'B', sourceId: 'doc1', sourceLabel: 'IM-2026-1', recordedBy: 'u', tsMillis: 1000 };

async function run(db, finalItems) {
    const plan = await planCanonicalStock(db, { tenantId: 'T', branchId: 'B', finalItems });
    const txn = db.txn();
    const snaps = await readCanonicalStock(txn, plan);
    const n = writeCanonicalStock(db, txn, plan, snaps, CTX);
    const moves = [...db._docs.entries()].filter(([k]) => k.startsWith('stockMovements/')).map(([, v]) => v);
    return { plan, n, moves, stok: (id) => db._docs.get(`branchStocks/${id}`) };
}

describe('UnitConversion', () => {
    it('kg↔g ve lt↔ml çevirir', () => {
        expect(convertQuantity(1, 'kg', 'g')).toEqual({ qty: 1000, unit: 'g', converted: true, mismatch: false });
        expect(convertQuantity(8469, 'g', 'kg')).toEqual({ qty: 8.469, unit: 'kg', converted: true, mismatch: false });
        expect(convertQuantity(0.5, 'lt', 'ml').qty).toBe(500);
        expect(convertQuantity(250, 'ml', 'lt').qty).toBe(0.25);
    });
    it('aynı birimde dokunmaz, alias normalize eder', () => {
        expect(convertQuantity(3, 'gr', 'g')).toEqual({ qty: 3, unit: 'g', converted: false, mismatch: false });
        expect(normalizeUnit(' KG ')).toBe('kg');
        expect(normalizeUnit(undefined, 'adet')).toBe('adet');
    });
    it('çevrilemeyen çifti tahmin etmez, mismatch işaretler', () => {
        expect(convertQuantity(2, 'adet', 'g')).toEqual({ qty: 2, unit: 'g', converted: false, mismatch: true });
        expect(convertQuantity(1, 'koli', 'adet').mismatch).toBe(true);
    });
});

describe('CanonicalStockWriter birim davranışı', () => {
    it('Maltepe Zeytin vakası: gram kartına 1 kg sipariş → +1000 g, satır birimi g kalır', async () => {
        const db = makeDb({
            'productionProducts/pZeytin': { inventoryProductId: 'invZeytin' },
            'inventoryProducts/invZeytin': { unit: 'g' },
            'branchStocks/imalat_T_invZeytin': { currentStock: 5000, unit: 'g' },
            'branchStocks/B_invZeytin': { currentStock: 8469, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pZeytin', productName: 'Zeytin', unit: 'kg', finalQuantity: 1 }]);
        expect(r.n).toBe(1);
        expect(r.stok('B_invZeytin')).toMatchObject({ currentStock: 9469, unit: 'g' });
        expect(r.stok('imalat_T_invZeytin')).toMatchObject({ currentStock: 4000, unit: 'g' });
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn).toMatchObject({ quantity: 1000, unit: 'g', sourceQuantity: 1, sourceUnit: 'kg' });
        expect(inn.unitMismatch).toBeUndefined();
        const out = r.moves.find((m) => m.movementType === 'TRANSFER_OUT');
        expect(out).toMatchObject({ quantity: -1000, unit: 'g' });
    });

    it('mevcut satırın birimi ezilmez: satır kg, kart g, sipariş g → satıra kg olarak eklenir', async () => {
        const db = makeDb({
            'inventoryProducts/p1': { unit: 'g' },
            'branchStocks/B_p1': { currentStock: 2, unit: 'kg' }, // eski hatalı etiket
        });
        const r = await run(db, [{ productId: 'p1', productName: 'X', unit: 'g', finalQuantity: 500 }]);
        expect(r.stok('B_p1')).toMatchObject({ currentStock: 2.5, unit: 'kg' });
        // imalat satırı yok → kart birimi (g) ile açılır
        expect(r.stok('imalat_T_p1')).toMatchObject({ currentStock: 0, unit: 'g' });
    });

    it('yeni satır kart birimiyle açılır; kart yoksa sipariş birimiyle', async () => {
        const db = makeDb({ 'inventoryProducts/pk': { unit: 'g' } });
        const r = await run(db, [
            { productId: 'pk', productName: 'Kartlı', unit: 'kg', finalQuantity: 2 },
            { productId: 'pn', productName: 'Kartsız', unit: 'adet', finalQuantity: 3 },
        ]);
        expect(r.stok('B_pk')).toMatchObject({ currentStock: 2000, unit: 'g' });
        expect(r.stok('B_pn')).toMatchObject({ currentStock: 3, unit: 'adet' });
    });

    it('çevrilemeyen çift (adet sipariş, g kart) tahmin edilmez: miktar aynen, unitMismatch işaretli', async () => {
        const db = makeDb({
            'inventoryProducts/pm': { unit: 'g' },
            'branchStocks/B_pm': { currentStock: 100, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pm', productName: 'Misket', unit: 'adet', finalQuantity: 10 }]);
        expect(r.stok('B_pm')).toMatchObject({ currentStock: 110, unit: 'g' });
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn).toMatchObject({ quantity: 10, unit: 'g', unitMismatch: true, sourceQuantity: 10, sourceUnit: 'adet' });
        expect(inn.notes).toContain('birim uyuşmazlığı');
    });

    it('aynı karta düşen iki kalem farklı birimlerle toplanır (0.5 kg + 250 g = 750 g)', async () => {
        const db = makeDb({
            'productionProducts/pA': { inventoryProductId: 'inv' },
            'productionProducts/pB': { inventoryProductId: 'inv' },
            'inventoryProducts/inv': { unit: 'g' },
        });
        const r = await run(db, [
            { productId: 'pA', productName: 'A', unit: 'kg', finalQuantity: 0.5 },
            { productId: 'pB', productName: 'B', unit: 'g', finalQuantity: 250 },
        ]);
        expect(r.plan.entries).toHaveLength(1);
        expect(r.stok('B_inv')).toMatchObject({ currentStock: 750, unit: 'g' });
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn.sourceQuantity).toBeNull(); // karışık kaynak birim — iz tutulmaz, tahmin yok
    });

    it('imalat 0 altına inmez (clamp korunur) ve sıfır/negatif adetler atlanır', async () => {
        const db = makeDb({
            'inventoryProducts/p': { unit: 'kg' },
            'branchStocks/imalat_T_p': { currentStock: 1, unit: 'kg' },
        });
        const r = await run(db, [
            { productId: 'p', productName: 'P', unit: 'kg', finalQuantity: 5 },
            { productId: 'q', productName: 'Q', unit: 'kg', finalQuantity: 0 },
        ]);
        expect(r.n).toBe(1);
        expect(r.stok('imalat_T_p')).toMatchObject({ currentStock: 0, unit: 'kg' });
        expect(r.stok('B_p')).toMatchObject({ currentStock: 5, unit: 'kg' });
    });

    it('flag kapalıyken plan null döner', async () => {
        process.env.INVOICING_CANONICAL_STOCK_DISABLED = 'true';
        try {
            const plan = await planCanonicalStock(makeDb(), { tenantId: 'T', branchId: 'B', finalItems: [{ productId: 'p', unit: 'kg', finalQuantity: 1 }] });
            expect(plan).toBeNull();
        } finally {
            delete process.env.INVOICING_CANONICAL_STOCK_DISABLED;
        }
    });
});
