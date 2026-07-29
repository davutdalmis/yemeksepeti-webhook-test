// ==================================================================================
// TrackableJob (e-belge asenkron olusturma) + istek-basina hiz limiti
// ==================================================================================
// 2026-07-29 dokuman denetiminden cikan iki bulgunun regresyon testleri:
//
//  1) Resmi doku (swagger.yaml:377): e-Fatura/e-Arsiv/e-Smm olusturma SENKRON DEGIL.
//     POST /e_archives yaniti bir "Trackable Job"tur; donen id e-belge id'si DEGIL,
//     islem takip numarasidir (omru 15 dk). Eski kod bunu e-arsiv id'si sanip
//     kaydediyor ve isin "error" ile bitmesini hic fark etmiyordu.
//
//  2) Parasut tavani 10 istek / 10 sn (swagger.yaml:74). Limitleyici IS basina
//     sayiyordu; tek siparis 17 istek uretebildigi icin tavan asiliyordu.
//     Artik her HTTP cagrisi jeton alir.
// ==================================================================================

const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');

const BASE = 'https://api.parasut.com';
const COMPANY_ID = '999';
const TOKEN = 'AT';

function makeProvider(overrides = {}) {
    return new ParasutProvider({
        clientId: 'CID',
        clientSecret: 'CSE',
        username: 'u@example.com',
        password: 'pw',
        companyId: COMPANY_ID,
        ...overrides,
    });
}

/** tryAcquire cagrilarini sayan sahte limitleyici. */
function makeCountingLimiter({ allowAfter = 0 } = {}) {
    const state = { calls: 0 };
    return {
        state,
        async tryAcquire() {
            state.calls += 1;
            return { allowed: state.calls > allowAfter, remaining: 9, retryAfterMs: 100 };
        },
    };
}

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('waitForTrackableJob', () => {
    test('done -> basariyla doner', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/trackable_jobs/job-1`)
            .reply(200, { data: { id: 'job-1', type: 'trackable_jobs', attributes: { status: 'done' } } });

        const p = makeProvider();
        await expect(p.waitForTrackableJob(TOKEN, 'job-1')).resolves.toMatchObject({ status: 'done' });
    });

    test('pending -> running -> done zinciri beklenir', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/trackable_jobs/job-2`).reply(200, { data: { attributes: { status: 'pending' } } });
        nock(BASE).get(`/v4/${COMPANY_ID}/trackable_jobs/job-2`).reply(200, { data: { attributes: { status: 'running' } } });
        nock(BASE).get(`/v4/${COMPANY_ID}/trackable_jobs/job-2`).reply(200, { data: { attributes: { status: 'done' } } });

        const p = makeProvider();
        await expect(
            p.waitForTrackableJob(TOKEN, 'job-2', { timeoutMs: 5000, intervalMs: 10 })
        ).resolves.toMatchObject({ status: 'done' });
        expect(nock.pendingMocks()).toHaveLength(0);
    });

    test('error -> KALICI hata firlatir (retry edilmez)', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/trackable_jobs/job-3`).reply(200, {
            data: { attributes: { status: 'error', errors: ['VKN gecersiz', 'Tarih aktivasyondan once'] } },
        });

        const p = makeProvider();
        await expect(p.waitForTrackableJob(TOKEN, 'job-3')).rejects.toMatchObject({
            name: 'InvoiceProviderError',
            code: 'EDOC_JOB_FAILED',
            retryable: false,
        });
    });

    test('error mesaji Parasut"in hata metnini icerir', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/trackable_jobs/job-4`).reply(200, {
            data: { attributes: { status: 'error', errors: ['VKN gecersiz'] } },
        });
        const p = makeProvider();
        await expect(p.waitForTrackableJob(TOKEN, 'job-4')).rejects.toThrow(/VKN gecersiz/);
    });

    test('surekli running -> timeout, RETRYABLE', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/trackable_jobs/job-5`)
            .times(10)
            .reply(200, { data: { attributes: { status: 'running' } } });

        const p = makeProvider();
        await expect(
            p.waitForTrackableJob(TOKEN, 'job-5', { timeoutMs: 60, intervalMs: 10 })
        ).rejects.toMatchObject({ code: 'EDOC_JOB_TIMEOUT', retryable: true });
    });

    test('jobId yoksa hata', async () => {
        const p = makeProvider();
        await expect(p.waitForTrackableJob(TOKEN, null)).rejects.toMatchObject({ code: 'TRACKABLE_JOB_NO_ID' });
    });
});

describe('createInvoice — e-arsiv asenkron akisi', () => {
    test('trackable_jobs yaniti -> is beklenir, GERCEK e-belge id cozulur', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .query({ include: 'active_e_document' })
            .reply(201, { data: { id: 'inv-1', type: 'sales_invoices', attributes: { invoice_no: 'A-1' } }, included: [] });

        // Gercek API burada TRACKABLE JOB doner
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/e_archives`)
            .reply(201, { data: { id: 'job-77', type: 'trackable_jobs' } });

        nock(BASE)
            .get(`/v4/${COMPANY_ID}/trackable_jobs/job-77`)
            .reply(200, { data: { attributes: { status: 'done' } } });

        // Resmi doku 3. adim: gercek id buradan alinir
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/sales_invoices/inv-1`)
            .query({ include: 'active_e_document' })
            .reply(200, {
                data: { id: 'inv-1', type: 'sales_invoices', attributes: {} },
                included: [{ id: 'EARC-REAL-123', type: 'e_archives', attributes: { printable_html_url: 'https://x/pdf' } }],
            });

        const p = makeProvider();
        const r = await p.createInvoice(TOKEN, {
            contactId: '42',
            items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100 }],
            issueDate: '2026-07-29',
            documentType: 'e_archive',
        });

        // job id ARTIK e-arsiv id'si olarak kaydedilmiyor
        expect(r.eArchiveId).toBe('EARC-REAL-123');
        expect(r.eArchiveJobId).toBe('job-77');
        expect(r.eDocType).toBe('e_archive');
        expect(r.pdfUrl).toBe('https://x/pdf');
    });

    test('is "error" ile biterse createInvoice PATLAR (sessiz basarisizlik yok)', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .query({ include: 'active_e_document' })
            .reply(201, { data: { id: 'inv-2', type: 'sales_invoices', attributes: {} }, included: [] });

        nock(BASE)
            .post(`/v4/${COMPANY_ID}/e_archives`)
            .reply(201, { data: { id: 'job-88', type: 'trackable_jobs' } });

        nock(BASE)
            .get(`/v4/${COMPANY_ID}/trackable_jobs/job-88`)
            .reply(200, { data: { attributes: { status: 'error', errors: ['Musteri e-fatura mukellefi'] } } });

        const p = makeProvider();
        await expect(
            p.createInvoice(TOKEN, {
                contactId: '42',
                items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100 }],
                issueDate: '2026-07-29',
                documentType: 'e_archive',
            })
        ).rejects.toMatchObject({ code: 'EDOC_JOB_FAILED' });
    });

    test('e_archives tipi dogrudan donerse (savunma dali) eski davranis korunur', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .query({ include: 'active_e_document' })
            .reply(201, { data: { id: 'inv-3', type: 'sales_invoices', attributes: {} }, included: [] });

        nock(BASE)
            .post(`/v4/${COMPANY_ID}/e_archives`)
            .reply(201, { data: { id: 'earc-legacy', type: 'e_archives' } });

        const p = makeProvider();
        const r = await p.createInvoice(TOKEN, {
            contactId: '42',
            items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100 }],
            issueDate: '2026-07-29',
            documentType: 'e_archive',
        });
        expect(r.eArchiveId).toBe('earc-legacy');
    });
});

describe('istek-basina hiz limiti', () => {
    test('HER HTTP cagrisi jeton alir (is basina degil)', async () => {
        const limiter = makeCountingLimiter();
        const p = makeProvider({ rateLimiter: limiter, tenantId: 'T1' });

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '1' }] });
        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '2' }] });
        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '3' }] });

        await p.upsertProduct(TOKEN, { name: 'A' });
        await p.upsertProduct(TOKEN, { name: 'B' });
        await p.upsertProduct(TOKEN, { name: 'C' });

        // 3 istek -> 3 jeton. Eski davranista is basina 1 jeton aliniyordu.
        expect(limiter.state.calls).toBe(3);
    });

    test('POST da jeton alir', async () => {
        const limiter = makeCountingLimiter();
        const p = makeProvider({ rateLimiter: limiter, tenantId: 'T1' });

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [] });
        nock(BASE).post(`/v4/${COMPANY_ID}/products`).reply(201, { data: { id: 'new-1' } });

        await p.upsertProduct(TOKEN, { name: 'Yeni' });
        expect(limiter.state.calls).toBe(2); // 1 GET + 1 POST
    });

    test('jeton yoksa BEKLER, sonra devam eder (siparis ortasinda patlamaz)', async () => {
        const limiter = makeCountingLimiter({ allowAfter: 2 }); // ilk 2 cagri reddedilir
        const p = makeProvider({ rateLimiter: limiter, tenantId: 'T1' });

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '9' }] });

        const r = await p.upsertProduct(TOKEN, { name: 'Bekleyen' });
        expect(r.productId).toBe('9');
        expect(limiter.state.calls).toBe(3); // 2 red + 1 kabul
    });

    test('bekleme ust siniri asilirsa retryable 429', async () => {
        const limiter = { async tryAcquire() { return { allowed: false, retryAfterMs: 100 }; } };
        const p = makeProvider({ rateLimiter: limiter, tenantId: 'T1', rateLimitMaxWaitMs: 120 });

        await expect(p.upsertProduct(TOKEN, { name: 'X' })).rejects.toMatchObject({
            code: 'RATE_LIMIT_WAIT_TIMEOUT',
            status: 429,
            retryable: true,
        });
    });

    test('limitleyici bozuksa akis DURMAZ', async () => {
        const limiter = { async tryAcquire() { throw new Error('redis down'); } };
        const p = makeProvider({ rateLimiter: limiter, tenantId: 'T1' });

        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '5' }] });
        await expect(p.upsertProduct(TOKEN, { name: 'Y' })).resolves.toMatchObject({ productId: '5' });
    });

    test('limitleyici enjekte edilmezse davranis degismez', async () => {
        const p = makeProvider(); // rateLimiter yok
        nock(BASE).get(`/v4/${COMPANY_ID}/products`).query(true).reply(200, { data: [{ id: '7' }] });
        await expect(p.upsertProduct(TOKEN, { name: 'Z' })).resolves.toMatchObject({ productId: '7' });
    });
});
