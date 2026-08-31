// ParasutInboxProvider birim testleri (nock ile sahte Parasut API).
// Sahte yanitlar 31.08.2026'da CANLI API'den alinan govde sekilleriyle birebir kuruldu
// (bkz. scripts/_parasut_inbox_sozlesme_probe*.js).

const zlib = require('zlib');
const nock = require('nock');
const ParasutInboxProvider = require('../providers/ParasutInboxProvider');

const BASE = 'https://api.parasut.com';
const COMPANY = '692357';

function makeProvider(extra = {}) {
    return new ParasutInboxProvider({
        clientId: 'cid', clientSecret: 'csec', username: 'u@example.com', password: 'p',
        companyId: COMPANY,
        minRequestIntervalMs: 0, // testte bekleme yok
        logger: { warn() {}, info() {}, error() {} },
        ...extra,
    });
}

function mockAuth(times = 1) {
    return nock(BASE).post('/oauth/token').times(times).reply(200, { access_token: 'tok', expires_in: 7200 });
}

function eInvoice(id, attrs = {}) {
    return {
        id: String(id),
        type: 'e_invoices',
        attributes: {
            direction: 'inbound',
            external_id: `YB1${id}`,
            uuid: `uuid-${id}`,
            from_vkn: '0610028531',
            contact_name: 'YASAR BIRLESIK PAZARLAMA',
            issue_date: '2026-08-26',
            created_at: '2026-08-28T06:15:07.839Z',
            net_total: '19916.4',
            total_vat: '197.19',
            currency: 'TRL',
            item_type: 'invoice',
            invoice_type_code: 'SATIS',
            profile_id: 'TEMELFATURA',
            scenario: 'basic',
            status: 'successful',
            status_code: '1300',
            is_seen: true,
            is_answerable: false,
            response_type: null,
            ...attrs,
        },
    };
}

function listBody(rows, meta = {}) {
    return {
        data: rows,
        meta: { current_page: 1, total_pages: 1, total_count: rows.length, per_page: 25, ...meta },
    };
}

/** Tek dosyali, deflate'li zip uretir (Parasut signed_ubl bicimi). */
function makeZip(name, content) {
    const data = zlib.deflateRawSync(Buffer.from(content, 'utf8'));
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 6);
    head.writeUInt16LE(8, 8);   // deflate
    head.writeUInt32LE(0, 14);  // crc (dogrulanmiyor)
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(Buffer.byteLength(content, 'utf8'), 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    return Buffer.concat([head, nameBuf, data]);
}

const UBL = '<?xml version="1.0"?><Invoice xmlns="urn:oasis"><ID>YB12026000176927</ID></Invoice>';

beforeEach(() => { nock.cleanAll(); });
afterAll(() => { nock.restore(); });

describe('listInboxInvoices', () => {
    test('yalniz gelen faturalari dondurur, gidenleri eler', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true)
            .reply(200, listBody([
                eInvoice(1),
                eInvoice(2, { direction: 'outbound' }),
                eInvoice(3),
            ], { total_count: 6284, total_pages: 252 }));

        const r = await makeProvider().listInboxInvoices({ pageIndex: 0, pageSize: 25 });
        expect(r.items.map((i) => i.invoiceId)).toEqual(['1', '3']);
        expect(r.scannedOnPage).toBe(3);      // API'nin taradigi kayit sayisi
        expect(r.totalCount).toBe(6284);      // API sayaci (iki yon birden)
    });

    test('pageIndex 0-tabanli -> page[number] 1-tabanli; tarih filtresi gteq/lteq', async () => {
        mockAuth();
        let seen = null;
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query((q) => { seen = q; return true; })
            .reply(200, listBody([eInvoice(1)]));

        await makeProvider().listInboxInvoices({
            pageIndex: 2, pageSize: 50,
            createStartDate: '2026-08-01', createEndDate: new Date('2026-08-31T00:00:00Z'),
        });
        expect(seen['page[number]']).toBe('3');
        expect(seen['page[size]']).toBe('50');
        expect(seen['filter[issue_date][gteq]']).toBe('2026-08-01');
        expect(seen['filter[issue_date][lteq]']).toBe('2026-08-31');
        expect(seen.sort).toBe('-issue_date');
    });

    test('sayfa tamamen GIDEN faturadan olussa bile hasMore true kalir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true)
            .reply(200, listBody(
                [eInvoice(9, { direction: 'outbound' }), eInvoice(10, { direction: 'outbound' })],
                { current_page: 2, total_pages: 5, total_count: 120 },
            ));

        const r = await makeProvider().listInboxInvoices({ pageIndex: 1, pageSize: 25 });
        expect(r.items).toHaveLength(0);
        expect(r.hasMore).toBe(true);   // KRITIK: bos sayfa "bitti" demek degil
    });

    test('son sayfada hasMore false', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true)
            .reply(200, listBody([eInvoice(1)], { current_page: 5, total_pages: 5 }));
        const r = await makeProvider().listInboxInvoices({ pageIndex: 4 });
        expect(r.hasMore).toBe(false);
    });

    test('tutar ve para birimi normalize edilir (net_total KDV DAHIL)', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(200, listBody([eInvoice(1)]));
        const [it] = (await makeProvider().listInboxInvoices({})).items;
        expect(it.payableAmount).toBe(19916.4);
        expect(it.taxTotal).toBe(197.19);
        expect(it.taxExclusiveAmount).toBe(19719.21);
        expect(it.currency).toBe('TRY');            // Parasut TRL yazar
        expect(it.documentId).toBe('YB11');         // external_id = resmi fatura no
        expect(it.counterpartyVkn).toBe('0610028531');
        expect(it.invoiceTipType).toBe('SATIS');
        expect(it.executionDate).toBe('2026-08-26');
    });

    test('pageSize 100 ile sinirlanir', async () => {
        mockAuth();
        let seen = null;
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query((q) => { seen = q; return true; })
            .reply(200, listBody([]));
        await makeProvider().listInboxInvoices({ pageSize: 500 });
        expect(seen['page[size]']).toBe('100');
    });
});

describe('getInboxInvoiceXml', () => {
    test('signed_ubl zip acilir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices/123/signed_ubl`)
            .reply(200, makeZip('YB1.xml', UBL), { 'content-type': 'application/zip' });
        const r = await makeProvider().getInboxInvoiceXml('123');
        expect(r.invoiceId).toBe('123');
        expect(r.xml).toBe(UBL);
    });

    test('zip degil duz XML gelirse oldugu gibi kullanilir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices/124/signed_ubl`)
            .reply(200, Buffer.from(UBL, 'utf8'), { 'content-type': 'application/xml' });
        expect((await makeProvider().getInboxInvoiceXml('124')).xml).toBe(UBL);
    });

    test('beklenmeyen govde hata firlatir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices/125/signed_ubl`)
            .reply(200, Buffer.from('{"errors":[]}', 'utf8'));
        await expect(makeProvider().getInboxInvoiceXml('125')).rejects.toThrow(/beklenmeyen govde/);
    });
});

describe('getInboxInvoicePdf', () => {
    test('imzali S3 linki uzerinden indirir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices/123/pdf`).reply(200, {
            data: { id: 'e-invoice-123', type: 'e_document_pdfs', attributes: { url: 'https://s3.example.com/fatura.pdf?sig=x' } },
        });
        nock('https://s3.example.com').get('/fatura.pdf').query(true).reply(200, Buffer.from('%PDF-1.4 govde'));
        const r = await makeProvider().getInboxInvoicePdf('123');
        expect(Buffer.from(r.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 govde');
    });
});

describe('dayaniklilik', () => {
    test('429 sonrasi yeniden dener', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true)
            .reply(429, { errors: [{ title: 'Too many requests', detail: 'Try again in 0 seconds.' }] });
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(200, listBody([eInvoice(1)]));
        const r = await makeProvider().listInboxInvoices({});
        expect(r.items).toHaveLength(1);
    });

    test('401 sonrasi bir kez yeniden kimlik dogrular', async () => {
        mockAuth(2);
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(401, { errors: [{ detail: 'expired' }] });
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(200, listBody([eInvoice(1)]));
        const r = await makeProvider().listInboxInvoices({});
        expect(r.items).toHaveLength(1);
    });

    test('token ornek icinde onbelleklenir (tek oauth cagrisi)', async () => {
        const auth = mockAuth(1);
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).times(2).reply(200, listBody([eInvoice(1)]));
        const p = makeProvider();
        await p.listInboxInvoices({});
        await p.listInboxInvoices({ pageIndex: 1 });
        expect(auth.isDone()).toBe(true);   // ikinci istekte yeniden token alinmadi
    });

    test('500 hatasi retryable isaretlenir', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(500, { errors: [] });
        await expect(makeProvider().listInboxInvoices({})).rejects.toMatchObject({ retryable: true, status: 500 });
    });
});

describe('resmi kabul/red cevabi', () => {
    test('desteklenmedigi acikca bildirilir ve FIRLATMAZ', async () => {
        const p = makeProvider();
        expect(p.supportsDocumentResponse).toBe(false);
        const r = await p.sendDocumentResponse([{ invoiceId: '1', status: 'Approved' }]);
        expect(r.ok).toBe(false);
        expect(r.unsupported).toBe(true);
    });
});

describe('ping', () => {
    test('basarili', async () => {
        mockAuth();
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true)
            .reply(200, listBody([eInvoice(1)], { total_count: 6284 }));
        expect(await makeProvider().ping()).toEqual({ ok: true, totalCount: 6284 });
    });

    test('kimlik hatasinda firlatmaz, ok:false doner', async () => {
        nock(BASE).post('/oauth/token').reply(401, { error: 'invalid_grant' });
        const r = await makeProvider().ping();
        expect(r.ok).toBe(false);
    });
});

describe('providerName', () => {
    test("incomingInvoices.provider alanina 'parasut' yazilir", () => {
        expect(makeProvider().providerName).toBe('parasut');
    });
});
