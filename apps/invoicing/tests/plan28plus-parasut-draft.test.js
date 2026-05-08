// Plan 28+ — ParasutProvider draft / update / finalize / checkVkn testleri
// Mevcut createInvoice tek atisin geriye uyumlu kalmasi icin onunla DOKUNULMAZ;
// yeni metodlar ayri test edilir.
const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');

const BASE = 'https://api.parasut.com';
const COMPANY_ID = '999';

function makeProvider() {
    return new ParasutProvider({
        clientId: 'CID',
        clientSecret: 'CSE',
        username: 'u@example.com',
        password: 'pw',
        companyId: COMPANY_ID,
    });
}

afterEach(() => {
    nock.cleanAll();
});

describe('Plan 28+ ParasutProvider draft akisi', () => {
    test('createDraftInvoice -> POST /sales_invoices, e_archive POST etmez', async () => {
        let salesPostBody = null;
        let earchivePostCount = 0;
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`, (body) => {
                salesPostBody = body;
                return true;
            })
            .reply(201, {
                data: {
                    id: '111',
                    type: 'sales_invoices',
                    attributes: {
                        invoice_no: 'INV-0001',
                        printable_html_url: 'https://parasut.com/print/111.pdf',
                    },
                },
            });
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/e_archives`)
            .reply(() => {
                earchivePostCount++;
                return [201, {}];
            });

        const p = makeProvider();
        const r = await p.createDraftInvoice('AT', {
            contactId: 'C1',
            items: [
                { productId: 'P1', name: 'Pizza Hamuru', quantity: 100, unitPrice: 5, vatRate: 1 },
            ],
            currency: 'TRL',
            issueDate: '2026-05-08',
            invoiceSeries: 'A',
            description: 'Test sevkiyat',
            shipmentIncluded: true,
            orderNo: 'ST-1',
            orderDate: '2026-05-08',
        });

        expect(r.providerInvoiceId).toBe('111');
        expect(r.invoiceNumber).toBe('INV-0001');
        expect(r.pdfUrl).toBe('https://parasut.com/print/111.pdf');
        // Kritik: e_archive POST'u ASLA yapilmamali
        expect(earchivePostCount).toBe(0);
        // sales_invoice payload kontrolu
        expect(salesPostBody.data.type).toBe('sales_invoices');
        expect(salesPostBody.data.attributes.shipment_included).toBe(true);
        expect(salesPostBody.data.attributes.order_no).toBe('ST-1');
        expect(salesPostBody.data.relationships.contact.data.id).toBe('C1');
        expect(salesPostBody.included).toHaveLength(1);
    });

    test('createDraftInvoice -> 422 -> InvoiceProviderError POST_FAILED', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices`)
            .reply(422, { errors: [{ title: 'invalid' }] });

        const p = makeProvider();
        await expect(
            p.createDraftInvoice('AT', {
                contactId: 'C1',
                items: [{ productId: 'P1', quantity: 1, unitPrice: 1, vatRate: 0, name: 'x' }],
            }),
        ).rejects.toMatchObject({ name: 'InvoiceProviderError', code: 'POST_FAILED', status: 422 });
    });

    test('updateDraftInvoice -> PUT /sales_invoices/{id} ile kalemler degistirilir', async () => {
        let putBody = null;
        nock(BASE)
            .put(`/v4/${COMPANY_ID}/sales_invoices/111`, (body) => {
                putBody = body;
                return true;
            })
            .reply(200, {
                data: { id: '111', type: 'sales_invoices', attributes: { invoice_no: 'INV-0001' } },
            });

        const p = makeProvider();
        const r = await p.updateDraftInvoice('AT', '111', {
            items: [
                { productId: 'P1', quantity: 95, unitPrice: 5, vatRate: 1, name: 'Pizza Hamuru' },
            ],
            description: 'Eksilen 5 paket fire',
        });
        expect(r.providerInvoiceId).toBe('111');
        expect(putBody.data.id).toBe('111');
        expect(putBody.data.attributes.description).toBe('Eksilen 5 paket fire');
        expect(putBody.included[0].attributes.quantity).toBe(95);
    });

    test('finalizeInvoice -> POST /convert_to_invoice + GET ile e_doc cek', async () => {
        let convertPostBody = null;
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices/111/convert_to_invoice`, (body) => {
                convertPostBody = body;
                return true;
            })
            .reply(200, {
                data: { id: '111', type: 'sales_invoices', attributes: { invoice_no: 'INV-0001' } },
            });
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/sales_invoices/111`)
            .query({ include: 'active_e_document' })
            .reply(200, {
                data: { id: '111', type: 'sales_invoices', attributes: { invoice_no: 'INV-0001' } },
                included: [
                    {
                        id: '888',
                        type: 'e_invoices',
                        attributes: { printable_html_url: 'https://parasut.com/e/888.pdf' },
                    },
                ],
            });

        const p = makeProvider();
        const r = await p.finalizeInvoice('AT', '111', { documentType: 'e_invoice' });
        expect(r.providerInvoiceId).toBe('111');
        expect(r.eDocId).toBe('888');
        expect(r.eDocType).toBe('e_invoice');
        expect(r.pdfUrl).toBe('https://parasut.com/e/888.pdf');
        expect(convertPostBody.data.attributes.scenario).toBe('temel_fatura');
    });

    test('finalizeInvoice -> e_archive variant payload internet_sale taşır', async () => {
        let convertBody = null;
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/sales_invoices/222/convert_to_invoice`, (body) => {
                convertBody = body;
                return true;
            })
            .reply(200, { data: { id: '222', type: 'sales_invoices', attributes: {} } });
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/sales_invoices/222`)
            .query({ include: 'active_e_document' })
            .reply(200, {
                data: { id: '222', type: 'sales_invoices', attributes: {} },
                included: [{ id: '999', type: 'e_archives', attributes: {} }],
            });

        const p = makeProvider();
        const r = await p.finalizeInvoice('AT', '222', { documentType: 'e_archive' });
        expect(r.eDocType).toBe('e_archive');
        expect(r.eDocId).toBe('999');
        expect(convertBody.data.attributes.internet_sale.payment_type).toBe('KREDIKARTI/BANKAKARTI');
    });

    test('checkVknInbox -> kayitli VKN registered=true', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/e_invoice_inboxes`)
            .query({ 'filter[vkn]': '1234567890' })
            .reply(200, {
                data: [
                    {
                        id: '1',
                        attributes: { email_address: 'urn:mail:b2b', address_type: 'efatura' },
                    },
                ],
            });

        const p = makeProvider();
        const r = await p.checkVknInbox('AT', '1234567890');
        expect(r.registered).toBe(true);
        expect(r.alias).toBe('urn:mail:b2b');
    });

    test('checkVknInbox -> kayitsiz VKN registered=false', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/e_invoice_inboxes`)
            .query({ 'filter[vkn]': '0000000000' })
            .reply(200, { data: [] });

        const p = makeProvider();
        const r = await p.checkVknInbox('AT', '0000000000');
        expect(r.registered).toBe(false);
    });

    test('checkVknInbox -> hata durumunda registered=false (sessiz)', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/e_invoice_inboxes`)
            .query({ 'filter[vkn]': 'X' })
            .reply(500, { error: 'boom' });

        const p = makeProvider();
        const r = await p.checkVknInbox('AT', 'X');
        expect(r.registered).toBe(false);
    });
});
