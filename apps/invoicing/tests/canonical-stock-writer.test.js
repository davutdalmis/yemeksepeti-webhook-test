// CanonicalStockWriter — birim dönüşümü + satır birimini ezmeme (02.09.2026)
// + üretilen ürün (supplyType=produced): imalattan stok değil reçete düşer (02.09.2026, Davut kararı)
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
    const query = (name, filters) => ({
        where(f, _op, v) { return query(name, [...filters, [f, v]]); },
        async get() {
            const out = [];
            for (const [k, d] of docs) {
                if (!k.startsWith(name + '/')) continue;
                if (filters.every(([f, v]) => d[f] === v)) out.push({ id: k.split('/')[1], data: () => d });
            }
            return { docs: out };
        },
    });
    return {
        _docs: docs,
        collection(name) {
            return { doc(id) { return ref(name, id || `auto${++autoId}`); }, where(f, op, v) { return query(name, []).where(f, op, v); } };
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

async function run(db, finalItems, extra = {}) {
    const plan = await planCanonicalStock(db, { tenantId: 'T', branchId: 'B', finalItems, ...extra });
    const txn = db.txn();
    const snaps = await readCanonicalStock(txn, plan);
    const n = writeCanonicalStock(db, txn, plan, snaps, CTX);
    const moves = [...db._docs.entries()].filter(([k]) => k.startsWith('stockMovements/')).map(([, v]) => v);
    return { plan, n, moves, stok: (id) => db._docs.get(`branchStocks/${id}`), doc: (k) => db._docs.get(k) };
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
        expect(r.stok('imalat_T_p1')).toMatchObject({ currentStock: -500, unit: 'g' });
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

    // Canlı şekil (27.09.2026): Pizza Hamuru ve Pesto kartı "adet", şube satırları "g", imalat Pesto satırı "adet".
    it('karşılık: hamur kartı adet, şube satırı g, 1 adet = 250 g → 10 adet şubeye +2500 g', async () => {
        const db = makeDb({
            'productionProducts/pHamur': { inventoryProductId: 'invHamur', supplyType: 'produced', stockUnitFactor: 250, stockUnitFactorUnit: 'g' },
            'inventoryProducts/invHamur': { unit: 'adet' },
            'branchStocks/B_invHamur': { currentStock: -1000, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pHamur', productName: 'Pizza Hamuru', unit: 'adet', finalQuantity: 10 }]);
        expect(r.stok('B_invHamur')).toMatchObject({ currentStock: 1500, unit: 'g' });
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn).toMatchObject({ quantity: 2500, unit: 'g', sourceQuantity: 10, sourceUnit: 'adet', unitFactor: 250, unitFactorUnit: 'g' });
        expect(inn.unitMismatch).toBeUndefined();
        expect(inn.notes).not.toContain('birim uyuşmazlığı');
        expect(r.moves.find((m) => m.movementType === 'TRANSFER_OUT')).toBeUndefined(); // üretilen ürün
    });

    it('karşılık: pesto (ticari) imalat satırı adet → çıkış adet, şube satırı g → giriş gram', async () => {
        const db = makeDb({
            'productionProducts/pPesto': { inventoryProductId: 'invPesto', supplyType: 'trade', stockUnitFactor: 500, stockUnitFactorUnit: 'g' },
            'inventoryProducts/invPesto': { unit: 'adet' },
            'branchStocks/imalat_T_invPesto': { currentStock: 77, unit: 'adet' },
            'branchStocks/B_invPesto': { currentStock: -994.5, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pPesto', productName: 'Pesto Sos', unit: 'adet', finalQuantity: 3 }]);
        expect(r.stok('imalat_T_invPesto')).toMatchObject({ currentStock: 74, unit: 'adet' });
        expect(r.stok('B_invPesto')).toMatchObject({ currentStock: 505.5, unit: 'g' });
        const out = r.moves.find((m) => m.movementType === 'TRANSFER_OUT');
        expect(out).toMatchObject({ quantity: -3, unit: 'adet' });
        expect(out.unitFactor).toBeUndefined();
    });

    it('karşılık birimi satırdan farklı ağırlıksa çevrilir: 1 adet = 0.25 kg, satır g → 4 adet = 1000 g', async () => {
        const db = makeDb({
            'productionProducts/pH': { inventoryProductId: 'invH', supplyType: 'produced', stockUnitFactor: 0.25, stockUnitFactorUnit: 'kg' },
            'inventoryProducts/invH': { unit: 'adet' },
            'branchStocks/B_invH': { currentStock: 0, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pH', productName: 'H', unit: 'adet', finalQuantity: 4 }]);
        expect(r.stok('B_invH')).toMatchObject({ currentStock: 1000, unit: 'g' });
    });

    it('şubede satır yoksa karşılık varken yeni satır karşılık biriminde (g) açılır', async () => {
        const db = makeDb({
            'productionProducts/pN': { inventoryProductId: 'invN', supplyType: 'produced', stockUnitFactor: 250, stockUnitFactorUnit: 'g' },
            'inventoryProducts/invN': { unit: 'adet' },
        });
        const r = await run(db, [{ productId: 'pN', productName: 'N', unit: 'adet', finalQuantity: 2 }]);
        expect(r.stok('B_invN')).toMatchObject({ currentStock: 500, unit: 'g' });
    });

    it('karşılık girilmemiş (veya birimi yok) ise eski davranış: miktar aynen, unitMismatch', async () => {
        const db = makeDb({
            'productionProducts/pY': { inventoryProductId: 'invY', stockUnitFactor: 250 }, // birim yok → kullanılmaz
            'inventoryProducts/invY': { unit: 'adet' },
            'branchStocks/B_invY': { currentStock: 0, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pY', productName: 'Y', unit: 'adet', finalQuantity: 4 }]);
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn).toMatchObject({ quantity: 4, unit: 'g', unitMismatch: true });
    });

    it('karşılık gerçek dönüşümü bozmaz: kg sipariş, g satır → 1 kg = 1000 g', async () => {
        const db = makeDb({
            'productionProducts/pX': { inventoryProductId: 'invX', stockUnitFactor: 250, stockUnitFactorUnit: 'g' },
            'inventoryProducts/invX': { unit: 'g' },
            'branchStocks/B_invX': { currentStock: 0, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'pX', productName: 'X', unit: 'kg', finalQuantity: 1 }]);
        const inn = r.moves.find((m) => m.movementType === 'TRANSFER_IN');
        expect(inn).toMatchObject({ quantity: 1000, unit: 'g' });
        expect(inn.unitFactor).toBeUndefined();
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
        expect(r.moves.find((m) => m.movementType === 'TRANSFER_IN').sourceQuantity).toBeNull();
    });

    it('imalat EKSİYE İNER (kelepçe yok, bakiye = defter; 30.09 Davut) ve sıfır/negatif adetler atlanır', async () => {
        const db = makeDb({
            'inventoryProducts/p': { unit: 'kg' },
            'branchStocks/imalat_T_p': { currentStock: 1, unit: 'kg' },
        });
        const r = await run(db, [
            { productId: 'p', productName: 'P', unit: 'kg', finalQuantity: 5 },
            { productId: 'q', productName: 'Q', unit: 'kg', finalQuantity: 0 },
        ]);
        expect(r.n).toBe(1);
        expect(r.stok('imalat_T_p')).toMatchObject({ currentStock: -4, unit: 'kg' });
        expect(r.stok('B_p')).toMatchObject({ currentStock: 5, unit: 'kg' });
        // bakiye = önceki + hareketler toplamı (defter ile birebir)
        const out = r.moves.find((m) => m.movementType === 'TRANSFER_OUT');
        expect(1 + out.quantity).toBe(r.stok('imalat_T_p').currentStock);
    });

    it('zaten eksi olan imalat satırı sıfıra çekilmez, hareket kadar daha eksiye iner', async () => {
        const db = makeDb({
            'inventoryProducts/p': { unit: 'g' },
            'branchStocks/imalat_T_p': { currentStock: -250, unit: 'g' },
        });
        const r = await run(db, [{ productId: 'p', productName: 'P', unit: 'kg', finalQuantity: 1.5 }]);
        expect(r.stok('imalat_T_p')).toMatchObject({ currentStock: -1750, unit: 'g' });
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

describe('Üretilen ürün (supplyType=produced): imalattan stok değil reçete düşer', () => {
    // Pizza Hamuru: 25 kg Pizza Unu + 0.33 lt Zeytinyağı → 150 top (Davut 02.09.2026)
    const seed = () => ({
        'productionProducts/pHamur': { supplyType: 'produced', inventoryProductId: 'invHamur' },
        'productionProducts/pSucuk': { supplyType: 'trade', inventoryProductId: 'invSucuk' },
        'inventoryProducts/invHamur': { unit: 'adet' },
        'inventoryProducts/invUn': { unit: 'kg' },
        'inventoryProducts/invZy': { unit: 'lt' },
        'productionRecipes/r1': {
            tenantId: 'T', productionProductId: 'pHamur', isActive: true, version: 2, outputQuantity: 150, outputUnit: 'adet',
            ingredients: [
                { inventoryProductId: 'invUn', inventoryProductName: 'Pizza Unu', quantity: 25, unit: 'kg' },
                { inventoryProductId: 'invZy', inventoryProductName: 'Zeytinyağı', quantity: 0.33, unit: 'lt' },
            ],
        },
        'productionRecipes/r0': { tenantId: 'T', productionProductId: 'pHamur', isActive: false, version: 1, outputQuantity: 50, ingredients: [{ inventoryProductId: 'invMaya', quantity: 0.5, unit: 'kg' }] },
        'branchStocks/imalat_T_invUn': { currentStock: 100, unit: 'kg' },
        'branchStocks/imalat_T_invZy': { currentStock: 10, unit: 'lt' },
        'branchStocks/imalat_T_invSucuk': { currentStock: 50, unit: 'kg' },
    });

    it('300 top hamur: imalatta hamur satırı AÇILMAZ, TRANSFER_OUT yok; un −50 kg, zeytinyağı −0.66 lt; şubeye +300', async () => {
        const db = makeDb(seed());
        const r = await run(db, [
            { productId: 'pHamur', productName: 'Pizza Hamuru', unit: 'adet', finalQuantity: 300 },
            { productId: 'pSucuk', productName: 'Sucuk', unit: 'kg', finalQuantity: 4 },
        ], { orderId: 'ord1', orderNumber: 'IM-2026-1' });
        expect(r.n).toBe(2);
        expect(r.stok('imalat_T_invHamur')).toBeUndefined();
        expect(r.stok('B_invHamur')).toMatchObject({ currentStock: 300, unit: 'adet' });
        expect(r.stok('imalat_T_invUn')).toMatchObject({ currentStock: 50, unit: 'kg' });
        expect(r.stok('imalat_T_invZy')).toMatchObject({ currentStock: 9.34, unit: 'lt' });
        expect(r.stok('imalat_T_invSucuk')).toMatchObject({ currentStock: 46, unit: 'kg' }); // ticari aynen
        const outs = r.moves.filter((m) => m.movementType === 'TRANSFER_OUT');
        expect(outs).toHaveLength(1); expect(outs[0].productId).toBe('invSucuk');
        const cons = r.moves.filter((m) => m.movementType === 'PRODUCTION_CONSUME');
        expect(cons).toHaveLength(2);
        expect(cons.find((m) => m.productId === 'invUn')).toMatchObject({ quantity: -50, unit: 'kg', sourceOrderId: 'ord1' });
        expect(cons[0].notes).toContain('Üretim siparişi: IM-2026-1');
        // pasif eski reçete (maya) KULLANILMAZ
        expect(r.moves.find((m) => m.productId === 'invMaya')).toBeUndefined();
        // marker RecipeStockEngine ile aynı anahtarda
        expect(r.doc('productionStockLog/ord1_consume')).toMatchObject({ orderId: 'ord1', phase: 'consume', count: 2, source: 'invoice_approval' });
    });

    it('imalat-web "Üretime Al" zaten düşmüşse (marker var) reçete İKİNCİ KEZ düşmez, şube girişi yine yapılır', async () => {
        const db = makeDb({ ...seed(), 'productionStockLog/ord1_consume': { orderId: 'ord1', phase: 'consume' } });
        const r = await run(db, [{ productId: 'pHamur', productName: 'Pizza Hamuru', unit: 'adet', finalQuantity: 300 }], { orderId: 'ord1', orderNumber: 'IM-2026-1' });
        expect(r.stok('imalat_T_invUn')).toMatchObject({ currentStock: 100 });
        expect(r.moves.filter((m) => m.movementType === 'PRODUCTION_CONSUME')).toHaveLength(0);
        expect(r.stok('B_invHamur')).toMatchObject({ currentStock: 300 });
    });

    it('hammadde satırı gram tutuyorsa reçete kg miktarı grama çevrilir', async () => {
        const s = seed(); s['branchStocks/imalat_T_invUn'] = { currentStock: 100000, unit: 'g' };
        const r = await run(makeDb(s), [{ productId: 'pHamur', productName: 'Pizza Hamuru', unit: 'adet', finalQuantity: 150 }], { orderId: 'o2', orderNumber: 'IM-2' });
        expect(r.stok('imalat_T_invUn')).toMatchObject({ currentStock: 75000, unit: 'g' });
        expect(r.moves.find((m) => m.movementType === 'PRODUCTION_CONSUME' && m.productId === 'invUn')).toMatchObject({ quantity: -25000, unit: 'g', sourceQuantity: 25, sourceUnit: 'kg' });
    });

    it('reçetesi olmayan üretilen ürün (Browni gibi): imalatta hiçbir şey düşmez, şubeye girer', async () => {
        const db = makeDb({ 'productionProducts/pBr': { supplyType: 'produced', inventoryProductId: 'invBr' } });
        const r = await run(db, [{ productId: 'pBr', productName: 'Browni', unit: 'adet', finalQuantity: 3 }], { orderId: 'o3' });
        expect(r.stok('imalat_T_invBr')).toBeUndefined();
        expect(r.stok('B_invBr')).toMatchObject({ currentStock: 3 });
        expect(r.moves).toHaveLength(1);
        expect(r.plan.entries[0].noRecipe).toBe(true);
    });

    it('hammadde imalatta eksiye iner (kelepçe yok), sipariş kimliği yoksa marker yazılmaz ama düşüm yapılır', async () => {
        const s = seed(); s['branchStocks/imalat_T_invUn'] = { currentStock: 10, unit: 'kg' };
        const r = await run(makeDb(s), [{ productId: 'pHamur', productName: 'Pizza Hamuru', unit: 'adet', finalQuantity: 300 }]);
        expect(r.stok('imalat_T_invUn')).toMatchObject({ currentStock: -40, unit: 'kg' });
        const unMove = r.moves.find((m) => m.movementType === 'PRODUCTION_CONSUME' && m.productId === 'invUn');
        expect(10 + unMove.quantity).toBe(-40);
        expect(r.moves.filter((m) => m.movementType === 'PRODUCTION_CONSUME')).toHaveLength(2);
        expect(r.plan.consumeEntries).toHaveLength(2);
        expect(r.plan.markerRef).toBeNull();
    });
});
