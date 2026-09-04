// ParasutProvider.getShipmentDocumentStatus / getShipmentDocumentPdf birim testleri (nock).
// Sahte yanıtlar 04.09.2026'da CANLI API'den alınan gövde şekilleriyle kuruldu
// (bkz. scripts/_parasut_irsaliye_pdf_probe3.js, _parasut_irsaliye_durum_probe.js).

const nock = require('nock');
const ParasutProvider = require('../providers/ParasutProvider');
const { ShipmentStatusSync } = require('../lib/ShipmentStatusSync');

const BASE = 'https://api.parasut.com';
const COMPANY_ID = '999';

function makeProvider(overrides = {}) {
    return new ParasutProvider({
        clientId: 'CID', clientSecret: 'CSE', username: 'u@example.com', password: 'pw',
        companyId: COMPANY_ID, ...overrides,
    });
}

function legalizedDoc(id) {
    return {
        data: {
            id: String(id), type: 'shipment_documents',
            attributes: {
                issue_date: '2026-09-01', shipment_date: '2026-09-01', inflow: false,
                despatch_no: 'BR02026000000559', uuid: 'e1f3-ettn', status: 'legalized',
                status_message: 'BAŞARIYLA TAMAMLANDI', legalized_at: '2026-09-01T16:14:02.671Z',
                carrier_license_plate: '34HRY129', drivers_info: [{ tckn: '11111111111', full_name: 'MUHAMMET KANGÖZ' }],
                printed_at: null, archived: false, procurement_number: null, invoice_no: null,
            },
        },
    };
}

function draftDoc(id) {
    return {
        data: {
            id: String(id), type: 'shipment_documents',
            attributes: {
                issue_date: '2026-09-02', shipment_date: null, inflow: false,
                despatch_no: null, uuid: null, status: null, status_message: null, legalized_at: null,
                carrier_license_plate: null, drivers_info: null, printed_at: null, archived: false,
            },
        },
    };
}

afterEach(() => nock.cleanAll());

describe('getShipmentDocumentStatus', () => {
    test('resmileşmiş belge -> legalized=true, despatchNo, uuid, plaka, şoför', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1003497509`).reply(200, legalizedDoc(1003497509));
        const s = await makeProvider().getShipmentDocumentStatus('tok', '1003497509');
        expect(s).toMatchObject({
            found: true, deleted: false, legalized: true,
            despatchNo: 'BR02026000000559', uuid: 'e1f3-ettn', eStatus: 'legalized',
            vehiclePlate: '34HRY129', driverName: 'MUHAMMET KANGÖZ', driverTckn: '11111111111',
        });
    });

    test('taslak belge -> legalized=false, numara yok', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1003498883`).reply(200, draftDoc(1003498883));
        const s = await makeProvider().getShipmentDocumentStatus('tok', '1003498883');
        expect(s).toMatchObject({ found: true, deleted: false, legalized: false, despatchNo: null, uuid: null, driverName: null });
    });

    test('Paraşüt panelinden silinmiş belge (404) -> deleted=true, hata fırlatmaz', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1003456808`).reply(404, { errors: [{ title: 'Record was not found', detail: 'ShipmentDocument-1003456808' }] });
        const s = await makeProvider().getShipmentDocumentStatus('tok', '1003456808');
        expect(s).toMatchObject({ found: false, deleted: true, legalized: false });
    });

    test('500 -> InvoiceProviderError (retryable) yukarı çıkar', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1`).reply(500, { error: 'boom' });
        await expect(makeProvider().getShipmentDocumentStatus('tok', '1')).rejects.toMatchObject({ name: 'InvoiceProviderError', retryable: true });
    });
});

describe('getShipmentDocumentPdf', () => {
    test('resmileşmiş belge -> imzalı linkten PDF indirilir, base64 döner', async () => {
        const fileUrl = 'https://parasut-e-documents.s3.amazonaws.com/production/x.pdf?sig=1';
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1002239759/pdf`).reply(200, {
            data: { id: 'shipment-document-1002239759', type: 'e_document_pdfs', attributes: { url: fileUrl, expires_at: '2026-09-04T16:54:36+03:00' } },
        });
        nock('https://parasut-e-documents.s3.amazonaws.com').get('/production/x.pdf').query(true).reply(200, Buffer.from('%PDF-1.4 test'), { 'Content-Type': 'application/pdf' });
        const r = await makeProvider().getShipmentDocumentPdf('tok', '1002239759');
        expect(r.providerShipmentId).toBe('1002239759');
        expect(Buffer.from(r.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 test');
        expect(r.expiresAt).toBe('2026-09-04T16:54:36+03:00');
    });

    test('taslak belge -> Paraşüt 204 döner -> SHIPMENT_NOT_LEGALIZED (409)', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/1003498883/pdf`).reply(204, '');
        await expect(makeProvider().getShipmentDocumentPdf('tok', '1003498883')).rejects.toMatchObject({ code: 'SHIPMENT_NOT_LEGALIZED', status: 409 });
    });

    test('silinmiş belge -> SHIPMENT_NOT_FOUND (404)', async () => {
        nock(BASE).get(`/v4/${COMPANY_ID}/shipment_documents/9/pdf`).reply(404, { errors: [{ title: 'Record was not found' }] });
        await expect(makeProvider().getShipmentDocumentPdf('tok', '9')).rejects.toMatchObject({ code: 'SHIPMENT_NOT_FOUND', status: 404 });
    });
});

// ---- ShipmentStatusSync: sahte Firestore + sahte provider ----
function fakeDb(docs) {
    const store = new Map(Object.entries(docs));
    const updates = [];
    const col = {
        doc: (id) => ({
            get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
            update: async (u) => { updates.push({ id, u }); store.set(id, { ...store.get(id), ...u }); },
        }),
        where() { return this; },
        limit() { return this; },
        get: async () => {
            const docsArr = [...store.entries()].map(([id, data]) => ({ id, data: () => data }));
            return { size: docsArr.length, docs: docsArr };
        },
    };
    return { db: { collection: () => col }, updates, store };
}

describe('ShipmentStatusSync', () => {
    const tokenManager = { getValidToken: async () => 'tok' };
    const providerFactory = async () => ({
        getShipmentDocumentStatus: async (_t, id) => {
            if (id === 'L1') return { found: true, deleted: false, legalized: true, despatchNo: 'BR1', uuid: 'u', legalizedAt: 'x', eStatus: 'legalized', eStatusMessage: 'ok', issueDate: null, shipmentDate: null, vehiclePlate: '34', driverName: 'A', driverTckn: '1', printedAt: null, archived: false };
            if (id === 'D1') return { found: false, deleted: true, legalized: false, despatchNo: null, uuid: null, legalizedAt: null, eStatus: null, eStatusMessage: null, issueDate: null, shipmentDate: null, vehiclePlate: null, driverName: null, driverTckn: null, printedAt: null, archived: false };
            return { found: true, deleted: false, legalized: false, despatchNo: null, uuid: null, legalizedAt: null, eStatus: null, eStatusMessage: null, issueDate: null, shipmentDate: null, vehiclePlate: null, driverName: null, driverTckn: null, printedAt: null, archived: false };
        },
    });

    test('syncDocument: parasutSync yazar, resmi numarayı parasutShipmentNumber alanına taşır', async () => {
        const { db, store } = fakeDb({ a: { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'L1' } });
        const s = new ShipmentStatusSync({ db, tokenManager, providerFactory, log: { warn() {} }, now: () => 123 });
        const r = await s.syncDocument('a', { tenantId: 'T' });
        expect(r.sync).toMatchObject({ legalized: true, despatchNo: 'BR1', checkedAt: 123 });
        expect(store.get('a').parasutShipmentNumber).toBe('BR1');
        expect(store.get('a').status).toBe('sent'); // Yemigo durumuna dokunmaz
    });

    test('syncDocument: başka kiracının belgesi -> document_not_found', async () => {
        const { db } = fakeDb({ a: { tenantId: 'OTHER', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'L1' } });
        const s = new ShipmentStatusSync({ db, tokenManager, providerFactory, log: { warn() {} } });
        await expect(s.syncDocument('a', { tenantId: 'T' })).rejects.toMatchObject({ code: 'document_not_found', status: 404 });
    });

    test('syncDocument: Paraşüt belgesi olmayan taslak -> skipped', async () => {
        const { db, updates } = fakeDb({ a: { tenantId: 'T', documentKind: 'shipment', status: 'draft' } });
        const s = new ShipmentStatusSync({ db, tokenManager, providerFactory, log: { warn() {} } });
        const r = await s.syncDocument('a', { tenantId: 'T' });
        expect(r.skipped).toBe('no_parasut_document');
        expect(updates).toHaveLength(0);
    });

    test('syncTenant: legalized / deleted / draft sayar, hata tek belgeyi düşürür', async () => {
        const { db } = fakeDb({
            a: { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'L1', sourceTransferNumber: 'IM-1' },
            b: { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'D1', sourceTransferNumber: 'IM-2' },
            c: { tenantId: 'T', documentKind: 'shipment', status: 'pending_approval', parasutShipmentId: 'X1', sourceTransferNumber: 'IM-3' },
            d: { tenantId: 'T', documentKind: 'shipment', status: 'draft' },
        });
        const s = new ShipmentStatusSync({ db, tokenManager, providerFactory, log: { warn() {} } });
        const r = await s.syncTenant('T');
        expect(r).toMatchObject({ scanned: 4, synced: 3, skipped: 1, errors: 0, legalized: 1, deleted: 1, draft: 1 });
        expect(r.items.find((i) => i.docId === 'b')).toMatchObject({ deleted: true, sourceTransferNumber: 'IM-2' });
    });
});
