// ==================================================================================
// ProviderRefCache + ParasutProvider onbellek entegrasyonu
// ==================================================================================
// 2026-07-29 canli olayin regresyon testi: her siparis her kalem icin ayri
// `/products?filter[name]=` aramasi atiyordu; 7 sube pes pese siparis verince
// Parasut saatlik limiti doldu, 4 e-irsaliye 429 alip DLQ'ya dustu.
// Bu testler "ayni urun ikinci kez ISTEK ATMADAN cozulur" garantisini korur.
// ==================================================================================

const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');
const ProviderRefCache = require('../lib/ProviderRefCache');

const BASE = 'https://api.parasut.com';
const COMPANY_ID = '999';
const TENANT = 'tenant-A';
const TOKEN = 'AT';

/** Bellek-ici sahte Firestore: collection().doc().collection().doc() zinciri. */
function makeFakeDb(opts = {}) {
    const store = new Map();
    const fail = opts.failMode || null;
    const key = (t, k, d) => `${t}/${k}/${d}`;

    function docRef(tenantId, kind, docId) {
        return {
            async get() {
                if (fail === 'read') throw new Error('firestore down');
                const v = store.get(key(tenantId, kind, docId));
                return { exists: v !== undefined, data: () => v };
            },
            async set(value) {
                if (fail === 'write') throw new Error('firestore down');
                store.set(key(tenantId, kind, docId), value);
            },
            async delete() {
                store.delete(key(tenantId, kind, docId));
            },
        };
    }

    return {
        _store: store,
        collection() {
            return {
                doc(tenantId) {
                    return {
                        collection(kind) {
                            return { doc: (docId) => docRef(tenantId, kind, docId) };
                        },
                    };
                },
            };
        },
    };
}

function makeProvider(refCache) {
    return new ParasutProvider({
        clientId: 'CID',
        clientSecret: 'CSE',
        username: 'u@example.com',
        password: 'pw',
        companyId: COMPANY_ID,
        refCache,
        tenantId: TENANT,
    });
}

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('ProviderRefCache', () => {
    test('set -> get ayni ID donr', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set(TENANT, 'products', 'Kofte Harci', '12345');
        expect(await c.get(TENANT, 'products', 'Kofte Harci')).toBe('12345');
    });

    test('isim normalizasyonu: bosluk ve buyuk-kucuk harf farki ayni kayda duser', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set(TENANT, 'products', 'Kofte Harci', '12345');
        expect(await c.get(TENANT, 'products', '  KOFTE   HARCI ')).toBe('12345');
    });

    test('TR "I" tuzagi: yerel-ayarli kucultme kullanilmamali', async () => {
        // toLocaleLowerCase('tr-TR') ile "PIDE" -> "pıde" olur ve "Pide" ile eslesmezdi.
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set(TENANT, 'products', 'Pide', '42');
        expect(await c.get(TENANT, 'products', 'PIDE')).toBe('42');
    });

    test('farkli urunler ayni anahtara CAKISMAZ', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set(TENANT, 'products', 'Kofte Harci', '1');
        await c.set(TENANT, 'products', 'Kofte Harci Ozel', '2');
        expect(await c.get(TENANT, 'products', 'Kofte Harci')).toBe('1');
        expect(await c.get(TENANT, 'products', 'Kofte Harci Ozel')).toBe('2');
    });

    test('bilinmeyen kayit -> null', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        expect(await c.get(TENANT, 'products', 'Yok Boyle Urun')).toBeNull();
    });

    test('tenant izolasyonu: baska tenant"in kaydi gorunmez', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set('tenant-A', 'products', 'Ayni Isim', '111');
        expect(await c.get('tenant-B', 'products', 'Ayni Isim')).toBeNull();
    });

    test('forget -> kayit dusr', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb() });
        await c.set(TENANT, 'products', 'Eski Urun', '999');
        await c.forget(TENANT, 'products', 'Eski Urun');
        expect(await c.get(TENANT, 'products', 'Eski Urun')).toBeNull();
    });

    test('Firestore okuma hatasi akisi BOZMAZ -> null doner', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb({ failMode: 'read' }) });
        await expect(c.get(TENANT, 'products', 'X')).resolves.toBeNull();
    });

    test('Firestore yazma hatasi akisi BOZMAZ -> throw etmez', async () => {
        const c = new ProviderRefCache({ db: makeFakeDb({ failMode: 'write' }) });
        await expect(c.set(TENANT, 'products', 'X', '1')).resolves.toBeUndefined();
    });
});

describe('ParasutProvider — urun onbellegi (429 regresyonu)', () => {
    test('ilk cagri arar, IKINCI cagri HIC istek atmaz', async () => {
        const cache = new ProviderRefCache({ db: makeFakeDb() });
        const p = makeProvider(cache);

        const scope = nock(BASE)
            .get(`/v4/${COMPANY_ID}/products`)
            .query(true)
            .reply(200, { data: [{ id: '777', attributes: { name: 'Kofte Harci' } }] });

        const first = await p.upsertProduct(TOKEN, { name: 'Kofte Harci' });
        expect(first.productId).toBe('777');
        expect(scope.isDone()).toBe(true);

        // Ikinci cagri: hicbir nock interceptor tanimli DEGIL.
        // HTTP'ye cikarsa nock "Disallowed net connect" ile patlar.
        const second = await p.upsertProduct(TOKEN, { name: 'Kofte Harci' });
        expect(second.productId).toBe('777');
        expect(second.fromCache).toBe(true);
    });

    test('yeni yaratilan urun de onbellege yazilir', async () => {
        const cache = new ProviderRefCache({ db: makeFakeDb() });
        const p = makeProvider(cache);

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [] });
        nock(BASE).post(`/v4/${COMPANY_ID}/products`).reply(201, { data: { id: '888' } });

        const created = await p.upsertProduct(TOKEN, { name: 'Yeni Urun' });
        expect(created.productId).toBe('888');
        expect(created.created).toBe(true);

        const again = await p.upsertProduct(TOKEN, { name: 'Yeni Urun' });
        expect(again.productId).toBe('888');
        expect(again.fromCache).toBe(true);
    });

    test('onbellek YOKKEN davranis eskisiyle ayni (her cagri arar)', async () => {
        const p = makeProvider(undefined); // refCache enjekte edilmedi

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '777' }] });
        const a = await p.upsertProduct(TOKEN, { name: 'X' });
        expect(a.productId).toBe('777');
        expect(a.fromCache).toBeUndefined();

        // ikinci cagri yine arama yapmali -> yeni interceptor gerekiyor
        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '777' }] });
        const b = await p.upsertProduct(TOKEN, { name: 'X' });
        expect(b.productId).toBe('777');
    });

    test('N kalemlik siparis: ikinci siparis sifir arama istegi atar', async () => {
        const cache = new ProviderRefCache({ db: makeFakeDb() });
        const p = makeProvider(cache);
        const items = ['Un', 'Yag', 'Tuz', 'Seker', 'Maya'];

        // 1. siparis: her kalem icin bir arama
        items.forEach((name, i) => {
            nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: String(100 + i) }] });
        });
        for (const name of items) {
            await p.upsertProduct(TOKEN, { name });
        }
        expect(nock.pendingMocks()).toHaveLength(0);

        // 2. siparis: ayni kalemler, HICBIR interceptor tanimli degil -> istek atilmamali
        const ids = [];
        for (const name of items) {
            const r = await p.upsertProduct(TOKEN, { name });
            ids.push(r.productId);
            expect(r.fromCache).toBe(true);
        }
        expect(ids).toEqual(['100', '101', '102', '103', '104']);
    });
});

describe('ParasutProvider — cari (contact) onbellegi', () => {
    test('vergi no ile bulunan cari onbellege yazilir, ikinci cagri istek atmaz', async () => {
        const cache = new ProviderRefCache({ db: makeFakeDb() });
        const p = makeProvider(cache);

        nock(BASE).get(`/v4/${COMPANY_ID}/contacts`).query(true).reply(200, { data: [{ id: '555' }] });

        const first = await p.upsertContact(TOKEN, { name: 'Bafetto Umraniye', taxNumber: '1234567890' });
        expect(first.contactId).toBe('555');

        const second = await p.upsertContact(TOKEN, { name: 'Bafetto Umraniye', taxNumber: '1234567890' });
        expect(second.contactId).toBe('555');
        expect(second.fromCache).toBe(true);
    });

    test('vergi no YOKKEN mukerrer cari yaratilmaz (onbellek ikinci yaratimi engeller)', async () => {
        const cache = new ProviderRefCache({ db: makeFakeDb() });
        const p = makeProvider(cache);

        // Vergi no yok -> arama yapilmaz, dogrudan yaratim
        nock(BASE).post(`/v4/${COMPANY_ID}/contacts`).reply(201, { data: { id: '666' } });
        const first = await p.upsertContact(TOKEN, { name: 'Sube X' });
        expect(first.contactId).toBe('666');
        expect(first.created).toBe(true);

        // Ikinci cagri: POST interceptor YOK. Eski kod burada yeni cari yaratirdi.
        const second = await p.upsertContact(TOKEN, { name: 'Sube X' });
        expect(second.contactId).toBe('666');
        expect(second.fromCache).toBe(true);
    });
});
