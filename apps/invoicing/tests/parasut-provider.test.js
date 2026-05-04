const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');

const BASE = 'https://api.parasut.com';
const COMPANY_ID = '999';

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

afterEach(() => {
    nock.cleanAll();
});

describe('ParasutProvider', () => {
    test('authenticate -> returns access/refresh tokens', async () => {
        nock(BASE).post('/oauth/token').reply(200, {
            access_token: 'AT', refresh_token: 'RT', expires_in: 7200, token_type: 'Bearer',
        });
        const p = makeProvider();
        const r = await p.authenticate();
        expect(r.accessToken).toBe('AT');
        expect(r.refreshToken).toBe('RT');
        expect(r.expiresIn).toBe(7200);
    });

    test('authenticate -> wraps 401 as InvoiceProviderError', async () => {
        nock(BASE).post('/oauth/token').reply(401, { error: 'invalid_grant' });
        const p = makeProvider();
        await expect(p.authenticate()).rejects.toMatchObject({ name: 'InvoiceProviderError', code: 'AUTH_FAILED', status: 401, retryable: false });
    });

    test('refresh -> uses grant_type=refresh_token', async () => {
        nock(BASE)
            .post('/oauth/token', (body) => body.grant_type === 'refresh_token' && body.refresh_token === 'RT')
            .reply(200, { access_token: 'AT2', expires_in: 7200 });
        const p = makeProvider();
        const r = await p.refresh('RT');
        expect(r.accessToken).toBe('AT2');
    });

    test('ping -> ok=true on 200', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/me`).reply(200, { data: { attributes: { name: 'Test Co' } } });
        const p = makeProvider();
        const r = await p.ping('AT');
        expect(r).toEqual({ ok: true, company: { name: 'Test Co' } });
    });

    test('ping -> ok=false on 401', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/me`).reply(401, { message: 'unauthorized' });
        const p = makeProvider();
        const r = await p.ping('bad-token');
        expect(r.ok).toBe(false);
    });

    test('upsertContact -> returns existing when tax_number found', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/contacts`)
            .query({ 'filter[tax_number]': '1234567890', 'page[size]': '1' })
            .reply(200, { data: [{ id: '42', type: 'contacts' }] });
        const p = makeProvider();
        const r = await p.upsertContact('AT', { name: 'Sube X', taxNumber: '1234567890' });
        expect(r).toEqual({ contactId: '42', created: false });
    });

    test('upsertContact -> creates when not found', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/contacts`)
            .query({ 'filter[tax_number]': '5556667778', 'page[size]': '1' })
            .reply(200, { data: [] });
        nock(BASE).post(`/v4/${COMPANY_ID}/contacts`).reply(201, { data: { id: '77', type: 'contacts' } });
        const p = makeProvider();
        const r = await p.upsertContact('AT', { name: 'Yeni', taxNumber: '5556667778' });
        expect(r).toEqual({ contactId: '77', created: true });
    });

    test('createInvoice -> returns provider id + pdf', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .query({ include: 'active_e_document' })
            .reply(201, {
                data: { id: 'inv-1', type: 'sales_invoices', attributes: { invoice_no: 'A-001' } },
                included: [{ type: 'e_archives', attributes: { printable_html_url: 'https://x/pdf' } }],
            });
        const p = makeProvider();
        const r = await p.createInvoice('AT', {
            contactId: '42',
            items: [{ productId: 'prod-1', quantity: 1, unitPrice: 100 }],
            issueDate: '2026-05-04',
        });
        expect(r.providerInvoiceId).toBe('inv-1');
        expect(r.invoiceNumber).toBe('A-001');
        expect(r.pdfUrl).toBe('https://x/pdf');
    });

    test('createInvoice -> 5xx is retryable', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .query(true)
            .reply(503, { message: 'service unavailable' });
        const p = makeProvider();
        await expect(
            p.createInvoice('AT', { contactId: '1', items: [{ productId: 'p', quantity: 1, unitPrice: 1 }] })
        ).rejects.toMatchObject({ name: 'InvoiceProviderError', status: 503, retryable: true });
    });

    test('constructor rejects missing options', () => {
        expect(() => new ParasutProvider({ clientId: 'a' })).toThrow(/missing required option/);
    });
});
