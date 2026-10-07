// ==================================================================================
// 07.10.2026 Bafetto — urun karti eslesmesi
// ==================================================================================
// Parasut filter[name] aramasi harf duyarli. "Füme kaburga" mevcut "Füme Kaburga"
// kartini bulamadi; motor Firestore id kodlu, "g" birimli kopya kart acti ve irsaliyede
// yanlis kod/birim gorundu. Artik kart acmadan once katalog harf duyarsiz + kodla taranir,
// yeni kartin birimi Parasut yazimina cevrilir.
// ==================================================================================

const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');

const BASE = 'https://api.parasut.com';
const C = '999';
const TOKEN = 'AT';

const makeProvider = () => new ParasutProvider({
    clientId: 'CID', clientSecret: 'CSE', username: 'u@x.com', password: 'pw', companyId: C,
});

const card = (id, name, code, archived = false) => ({ id, type: 'products', attributes: { name, code, archived } });

function mockNameSearchEmpty() {
    nock(BASE).get(`/v4/${C}/products`).query((q) => q['filter[name]'] !== undefined).reply(200, { data: [] });
}
function mockCatalog(rows) {
    nock(BASE).get(`/v4/${C}/products`).query((q) => q['page[number]'] === '1').reply(200, { data: rows });
}

beforeEach(() => { nock.cleanAll(); ParasutProvider._resetCatalogCache(); });
afterAll(() => nock.restore());

describe('upsertProduct katalog eslesmesi', () => {
    test('harf farki: "Füme kaburga" mevcut "Füme Kaburga" kartina baglanir, kart acilmaz', async () => {
        mockNameSearchEmpty();
        mockCatalog([card('10', 'Sucuk Standart', '2001001'), card('20', 'Füme Kaburga', '2002002')]);
        const post = nock(BASE).post(`/v4/${C}/products`).reply(201, { data: { id: 'X' } });

        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Füme kaburga', sku: 'pDnn', unit: 'g' });
        expect(r).toMatchObject({ productId: '20', created: false });
        expect(post.isDone()).toBe(false);
    });

    test('Turkce I/İ: "PİLİÇ SOSİS" "Piliç sosis" ile eslesir', async () => {
        mockNameSearchEmpty();
        mockCatalog([card('30', 'PİLİÇ SOSİS', '2001004')]);
        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Piliç sosis', unit: 'kg' });
        expect(r.productId).toBe('30');
    });

    test('ad farkli ama kod ayni ise o kart kullanilir', async () => {
        mockNameSearchEmpty();
        mockCatalog([card('40', 'Eski Ad', 'abc123')]);
        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Yeni Ad', sku: 'abc123' });
        expect(r.productId).toBe('40');
    });

    test('arsivli olmayan kart onceliklidir', async () => {
        mockNameSearchEmpty();
        mockCatalog([card('50', 'Sosis', '', true), card('51', 'sosis', '')]);
        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Sosis' });
        expect(r.productId).toBe('51');
    });

    test('eslesme yoksa kart acilir, birim Parasut yazimina cevrilir', async () => {
        mockNameSearchEmpty();
        mockCatalog([card('60', 'Baska', '1')]);
        let body;
        nock(BASE).post(`/v4/${C}/products`, (b) => { body = b; return true; }).reply(201, { data: { id: 'NEW' } });

        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Pepperoni', sku: 'R1nG', unit: 'kg' });
        expect(r).toMatchObject({ productId: 'NEW', created: true });
        expect(body.data.attributes.unit).toBe('Kilogram');
    });

    test('katalog taranamazsa irsaliye durmaz, kart acilir (eski davranis)', async () => {
        mockNameSearchEmpty();
        nock(BASE).get(`/v4/${C}/products`).query((q) => q['page[number]'] === '1').reply(500, {});
        nock(BASE).post(`/v4/${C}/products`).reply(201, { data: { id: 'NEW2' } });
        const r = await makeProvider().upsertProduct(TOKEN, { name: 'Bilinmez' });
        expect(r.productId).toBe('NEW2');
    });

    test('katalog sayfalanir ve ayni is icinde tekrar cekilmez', async () => {
        const first = Array.from({ length: 25 }, (_, i) => card(String(100 + i), `Urun ${i}`, ''));
        nock(BASE).get(`/v4/${C}/products`).query((q) => q['filter[name]'] !== undefined).times(2).reply(200, { data: [] });
        nock(BASE).get(`/v4/${C}/products`).query((q) => q['page[number]'] === '1').once().reply(200, { data: first });
        nock(BASE).get(`/v4/${C}/products`).query((q) => q['page[number]'] === '2').once().reply(200, { data: [card('200', 'Son Urun', '')] });

        const p = makeProvider();
        expect((await p.upsertProduct(TOKEN, { name: 'SON URUN' })).productId).toBe('200');
        expect((await p.upsertProduct(TOKEN, { name: 'URUN 3' })).productId).toBe('103');
        expect(nock.pendingMocks()).toHaveLength(0);
    });
});

describe('toParasutUnit', () => {
    test.each([
        ['kg', 'Kilogram'], ['KG', 'Kilogram'], ['g', 'Gram'], ['adet', 'Adet'], ['lt', 'Litre'],
        ['koli', 'Koli'], [undefined, 'Adet'], ['', 'Adet'], ['şişe', 'Şişe'],
    ])('%s -> %s', (inp, out) => expect(ParasutProvider.toParasutUnit(inp)).toBe(out));
});
