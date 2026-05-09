// Plan 28++ — ParasutProvider e-irsaliye (shipment_document) testleri
// Sales_invoice draft akisindan AYRI: GIB sevk irsaliyesi (QR kodlu PDF)
// Paraşüt'a JSON:API formatında POST/PUT, mali değer içermez.

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

describe('Plan 28++ ParasutProvider shipment_document akisi', () => {
    test('createShipmentDocument -> POST /shipment_documents JSON:API formatı', async () => {
        let postBody = null;
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/shipment_documents`, (body) => {
                postBody = body;
                return true;
            })
            .query({ include: 'stock_movements' })
            .reply(201, {
                data: {
                    id: '777',
                    type: 'shipment_documents',
                    attributes: {
                        procurement_number: 'IRS-2026-001',
                        issue_date: '2026-05-08',
                        shipment_date: '2026-05-08T14:30:00Z',
                        printable_html_url: 'https://parasut.com/print/shipment/777.pdf',
                    },
                },
            });

        const p = makeProvider();
        const r = await p.createShipmentDocument('AT', {
            contactId: 'C1',
            items: [
                { productId: 'P1', name: 'Pizza Hamuru', quantity: 100, unitPrice: 5, vatRate: 1 },
                { productId: 'P2', name: 'Domates Sos', quantity: 50, unitPrice: 8, vatRate: 1 },
            ],
            issueDate: '2026-05-08',
            shipmentDate: '2026-05-08T14:30:00Z',
            description: 'Bafetto Maltepe sevkiyat',
            address: 'Atatürk Cad. No:5',
            city: 'İstanbul',
            district: 'Maltepe',
            inflow: false,
        });

        expect(r.providerShipmentId).toBe('777');
        expect(r.shipmentNumber).toBe('IRS-2026-001');
        // Plan 28++: pdfUrl artik Parasut PANEL URL'i (browser'da acilabilsin)
        expect(r.pdfUrl).toBe(`https://uygulama.parasut.com/${COMPANY_ID}/sales/shipment_documents/777`);
        // API endpoint URL (Bearer token gerektirir) ayri alanda
        expect(r.apiPrintUrl).toBe('https://parasut.com/print/shipment/777.pdf');

        // JSON:API format dogrulamasi
        expect(postBody.data.type).toBe('shipment_documents');
        expect(postBody.data.attributes.issue_date).toBe('2026-05-08');
        expect(postBody.data.attributes.inflow).toBe(false);
        expect(postBody.data.attributes.description).toBe('Bafetto Maltepe sevkiyat');
        expect(postBody.data.attributes.address).toBe('Atatürk Cad. No:5');
        expect(postBody.data.attributes.city).toBe('İstanbul');
        expect(postBody.data.attributes.district).toBe('Maltepe');
        expect(postBody.data.attributes.shipment_date).toBe('2026-05-08T14:30:00Z');

        // contact relationship
        expect(postBody.data.relationships.contact.data.id).toBe('C1');

        // stock_movements inline (sales_invoice_details ile ayni pattern: id YOK, included YOK)
        expect(postBody.included).toBeUndefined();
        expect(postBody.data.relationships.stock_movements.data).toHaveLength(2);
        expect(postBody.data.relationships.stock_movements.data[0].type).toBe('stock_movements');
        expect(postBody.data.relationships.stock_movements.data[0].id).toBeUndefined();
        expect(postBody.data.relationships.stock_movements.data[0].attributes.quantity).toBe(100);
        expect(postBody.data.relationships.stock_movements.data[0].attributes.unit_price).toBe(5);
        expect(postBody.data.relationships.stock_movements.data[0].relationships.product.data.id).toBe('P1');
        expect(postBody.data.relationships.stock_movements.data[1].relationships.product.data.id).toBe('P2');
    });

    test('createShipmentDocument -> 422 -> InvoiceProviderError POST_FAILED', async () => {
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/shipment_documents`)
            .query(true)
            .reply(422, { errors: [{ title: 'invalid' }] });

        const p = makeProvider();
        await expect(
            p.createShipmentDocument('AT', {
                contactId: 'C1',
                items: [{ productId: 'P1', name: 'X', quantity: 1, unitPrice: 1, vatRate: 0 }],
            }),
        ).rejects.toMatchObject({ name: 'InvoiceProviderError', code: 'POST_FAILED', status: 422 });
    });

    test('createShipmentDocument -> contactId yoksa hata', async () => {
        const p = makeProvider();
        await expect(
            p.createShipmentDocument('AT', {
                items: [{ productId: 'P1', name: 'X', quantity: 1, unitPrice: 1, vatRate: 0 }],
            }),
        ).rejects.toMatchObject({ code: 'SHIPMENT_NO_CONTACT' });
    });

    test('createShipmentDocument -> items boşsa hata', async () => {
        const p = makeProvider();
        await expect(
            p.createShipmentDocument('AT', { contactId: 'C1', items: [] }),
        ).rejects.toMatchObject({ code: 'SHIPMENT_NO_ITEMS' });
    });

    test('updateShipmentDocument -> PUT /shipment_documents/{id} kalemler degistirilir', async () => {
        let putBody = null;
        nock(BASE)
            .put(`/v4/${COMPANY_ID}/shipment_documents/777`, (body) => {
                putBody = body;
                return true;
            })
            .reply(200, {
                data: {
                    id: '777',
                    type: 'shipment_documents',
                    attributes: { procurement_number: 'IRS-2026-001' },
                },
            });

        const p = makeProvider();
        const r = await p.updateShipmentDocument('AT', '777', {
            items: [
                { productId: 'P1', name: 'Pizza Hamuru', quantity: 95, unitPrice: 5, vatRate: 1 },
            ],
            description: 'Eksilen 5 paket fire — duzeltildi',
            shipmentDate: '2026-05-08T15:00:00Z',
        });
        expect(r.providerShipmentId).toBe('777');
        expect(putBody.data.id).toBe('777');
        expect(putBody.data.type).toBe('shipment_documents');
        expect(putBody.data.attributes.description).toBe('Eksilen 5 paket fire — duzeltildi');
        expect(putBody.data.attributes.shipment_date).toBe('2026-05-08T15:00:00Z');
        expect(putBody.included).toBeUndefined();
        expect(putBody.data.relationships.stock_movements.data[0].attributes.quantity).toBe(95);
    });

    test('getShipmentDocument -> GET /shipment_documents/{id} include stock_movements,contact', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/shipment_documents/777`)
            .query({ include: 'stock_movements,contact' })
            .reply(200, {
                data: {
                    id: '777',
                    type: 'shipment_documents',
                    attributes: {
                        procurement_number: 'IRS-2026-001',
                        issue_date: '2026-05-08',
                        shipment_date: '2026-05-08T14:30:00Z',
                        printable_html_url: 'https://parasut.com/print/shipment/777.pdf',
                        archived: false,
                    },
                },
            });

        const p = makeProvider();
        const r = await p.getShipmentDocument('AT', '777');
        expect(r.providerShipmentId).toBe('777');
        expect(r.shipmentNumber).toBe('IRS-2026-001');
        expect(r.pdfUrl).toBe('https://parasut.com/print/shipment/777.pdf');
        expect(r.archived).toBe(false);
    });

    test('getShipmentDocument -> 404 -> InvoiceProviderError', async () => {
        nock(BASE)
            .get(`/v4/${COMPANY_ID}/shipment_documents/999`)
            .query(true)
            .reply(404, { errors: [{ title: 'not found' }] });

        const p = makeProvider();
        await expect(p.getShipmentDocument('AT', '999')).rejects.toMatchObject({
            name: 'InvoiceProviderError',
            code: 'GET_FAILED',
            status: 404,
        });
    });

    test('deleteShipmentDocument -> DELETE /shipment_documents/{id}', async () => {
        nock(BASE)
            .delete(`/v4/${COMPANY_ID}/shipment_documents/777`)
            .reply(204, '');

        const p = makeProvider();
        const r = await p.deleteShipmentDocument('AT', '777');
        expect(r.ok).toBe(true);
    });

    test('deleteShipmentDocument -> 404 -> InvoiceProviderError SHIPMENT_DELETE_FAILED', async () => {
        nock(BASE)
            .delete(`/v4/${COMPANY_ID}/shipment_documents/999`)
            .reply(404, { errors: [{ title: 'not found' }] });

        const p = makeProvider();
        await expect(p.deleteShipmentDocument('AT', '999')).rejects.toMatchObject({
            name: 'InvoiceProviderError',
            code: 'SHIPMENT_DELETE_FAILED',
            status: 404,
        });
    });

    test('createShipmentDocument -> default issueDate=today, inflow=false', async () => {
        let postBody = null;
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/shipment_documents`)
            .query(true)
            .reply(201, {
                data: { id: '888', type: 'shipment_documents', attributes: {} },
            })
            .on('replied', (req, _interceptor) => {
                postBody = JSON.parse(req.requestBodyBuffers ? req.requestBodyBuffers.toString() : '{}');
            });

        // nock'un request match icin separate hook gerekir; basit yol: body callback
        nock.cleanAll();
        nock(BASE)
            .post(`/v4/${COMPANY_ID}/shipment_documents`, (body) => {
                postBody = body;
                return true;
            })
            .query(true)
            .reply(201, {
                data: { id: '888', type: 'shipment_documents', attributes: {} },
            });

        const p = makeProvider();
        await p.createShipmentDocument('AT', {
            contactId: 'C1',
            items: [{ productId: 'P1', name: 'X', quantity: 1, unitPrice: 1, vatRate: 0 }],
        });

        const today = new Date().toISOString().slice(0, 10);
        expect(postBody.data.attributes.issue_date).toBe(today);
        expect(postBody.data.attributes.inflow).toBe(false);
    });
});
