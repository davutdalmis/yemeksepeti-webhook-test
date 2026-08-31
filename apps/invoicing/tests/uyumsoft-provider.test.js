// UyumsoftProvider birim testleri — nock ile canli sema (singleWsdl 2026-08-03)
// sekilli sahte SOAP yanitlari. Gercek Uyumsoft'a istek ATILMAZ.

const nock = require('nock');
const UyumsoftProvider = require('../providers/UyumsoftProvider');

const HOST = 'https://uyumsoft.example.com';
const PATH = '/Services/Integration';

function makeProvider(overrides = {}) {
    return new UyumsoftProvider({
        username: 'api-user@bafetto.com',
        password: 'p<w&"s',
        baseUrl: HOST + PATH,
        ...overrides,
    });
}

function soap(inner) {
    return '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + inner + '</s:Body></s:Envelope>';
}

const LIST_ITEM = `
  <b:Items xmlns:b="http://tempuri.org/">
    <b:InvoiceId>e6b0a7a2-1111-2222-3333-444455556666</b:InvoiceId>
    <b:DocumentId>CCI2026000012345</b:DocumentId>
    <b:Type>ComercialInvoice</b:Type>
    <b:TypeCode>2</b:TypeCode>
    <b:TargetTcknVkn>2110056338</b:TargetTcknVkn>
    <b:TargetTitle>COCA-COLA SATIS VE DAGITIM A.S.</b:TargetTitle>
    <b:EnvelopeIdentifier>env-1</b:EnvelopeIdentifier>
    <b:Status>Approved</b:Status>
    <b:StatusCode>7</b:StatusCode>
    <b:EnvelopeStatus>CompletedSuccessfully</b:EnvelopeStatus>
    <b:EnvelopeStatusCode>37</b:EnvelopeStatusCode>
    <b:CreateDateUtc>2026-08-01T09:15:00Z</b:CreateDateUtc>
    <b:ExecutionDate>2026-08-01T00:00:00</b:ExecutionDate>
    <b:PayableAmount>1250.40</b:PayableAmount>
    <b:TaxTotal>208.40</b:TaxTotal>
    <b:TaxExclusiveAmount>1042.00</b:TaxExclusiveAmount>
    <b:DocumentCurrencyCode>TRY</b:DocumentCurrencyCode>
    <b:ExchangeRate>0</b:ExchangeRate>
    <b:IsArchived>false</b:IsArchived>
    <b:InvoiceTipType>Sales</b:InvoiceTipType>
    <b:InvoiceTipTypeCode>1</b:InvoiceTipTypeCode>
    <b:IsNew>true</b:IsNew>
    <b:IsSeen>false</b:IsSeen>
  </b:Items>`;

function listResponse({ items = LIST_ITEM, totalCount = 1 } = {}) {
    return soap(
        '<GetInboxInvoiceListResponse xmlns="http://tempuri.org/">'
        + `<GetInboxInvoiceListResult IsSucceded="true"><Value PageIndex="0" PageSize="50" TotalCount="${totalCount}" TotalPages="1">`
        + items
        + '</Value></GetInboxInvoiceListResult></GetInboxInvoiceListResponse>'
    );
}

afterEach(() => {
    nock.cleanAll();
});

describe('UyumsoftProvider — envelope & auth', () => {
    test('istek WS-Security UsernameToken tasir, parola XML-escape edilir', async () => {
        let captured = '';
        nock(HOST)
            .post(PATH, (body) => { captured = typeof body === 'string' ? body : JSON.stringify(body); return true; })
            .reply(200, listResponse(), { 'Content-Type': 'text/xml' });

        await makeProvider().listInboxInvoices();
        expect(captured).toContain('<o:Username>api-user@bafetto.com</o:Username>');
        expect(captured).toContain('p&lt;w&amp;&quot;s'); // p<w&"s escape'lenmis
        expect(captured).toContain('PasswordText');
    });

    test('SOAPAction header dogru operasyonu isaret eder', async () => {
        const scope = nock(HOST, {
            reqheaders: { soapaction: '"http://tempuri.org/IIntegration/GetInboxInvoiceList"' },
        }).post(PATH).reply(200, listResponse(), { 'Content-Type': 'text/xml' });

        await makeProvider().listInboxInvoices();
        expect(scope.isDone()).toBe(true);
    });
});

describe('UyumsoftProvider — listInboxInvoices', () => {
    test('sayfa meta + kalem normalizasyonu', async () => {
        nock(HOST).post(PATH).reply(200, listResponse({ totalCount: 132 }), { 'Content-Type': 'text/xml' });
        const r = await makeProvider().listInboxInvoices({ pageSize: 50 });
        expect(r.totalCount).toBe(132);
        expect(r.items).toHaveLength(1);
        const it = r.items[0];
        expect(it.invoiceId).toBe('e6b0a7a2-1111-2222-3333-444455556666');
        expect(it.documentId).toBe('CCI2026000012345');
        expect(it.counterpartyVkn).toBe('2110056338');
        expect(it.counterpartyTitle).toBe('COCA-COLA SATIS VE DAGITIM A.S.');
        expect(it.payableAmount).toBe(1250.4);
        expect(it.taxTotal).toBe(208.4);
        expect(it.currency).toBe('TRY');
        expect(it.invoiceTipType).toBe('Sales');
        expect(it.isNew).toBe(true);
        expect(it.isSeen).toBe(false);
    });

    test('tek kayit da dizi olarak normalize edilir, bos liste bos dizi doner', async () => {
        nock(HOST).post(PATH).reply(200, listResponse({ items: '', totalCount: 0 }), { 'Content-Type': 'text/xml' });
        const r = await makeProvider().listInboxInvoices();
        expect(r.items).toEqual([]);
        expect(r.totalCount).toBe(0);
    });

    test('query sequence sirasi WSDL ile ayni (tarih filtreleri + nil alanlar)', async () => {
        let captured = '';
        nock(HOST)
            .post(PATH, (body) => { captured = String(body); return true; })
            .reply(200, listResponse(), { 'Content-Type': 'text/xml' });

        await makeProvider().listInboxInvoices({
            createStartDate: '2026-08-01T00:00:00Z',
            createEndDate: '2026-08-02T23:59:59Z',
            pageIndex: 2,
            pageSize: 25,
            onlyNewestInvoices: true,
        });
        expect(captured).toContain('PageIndex="2"');
        expect(captured).toContain('PageSize="25"');
        expect(captured).toContain('OnlyNewestInvoices="true"');
        expect(captured).toContain('<CreateStartDate>2026-08-01T00:00:00Z</CreateStartDate>');
        expect(captured).toContain('<ExecutionStartDate i:nil="true"/>');
        // WCF sira hassasiyeti: ExecutionStartDate, CreateStartDate'ten ONCE gelmeli
        expect(captured.indexOf('ExecutionStartDate')).toBeLessThan(captured.indexOf('CreateStartDate'));
        // IncludeTagList zorunlu alan her zaman yazilir
        expect(captured).toContain('<IncludeTagList>false</IncludeTagList>');
    });

    test('IsSucceded=false -> PROVIDER_REJECTED, retryable=false', async () => {
        nock(HOST).post(PATH).reply(200, soap(
            '<GetInboxInvoiceListResponse xmlns="http://tempuri.org/">'
            + '<GetInboxInvoiceListResult IsSucceded="false" Message="Gecersiz sorgu"/>'
            + '</GetInboxInvoiceListResponse>'
        ), { 'Content-Type': 'text/xml' });
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({
            name: 'InvoiceProviderError', code: 'PROVIDER_REJECTED', retryable: false,
        });
    });

    test('kullanici/parola hatasi mesaji -> AUTH_FAILED', async () => {
        nock(HOST).post(PATH).reply(200, soap(
            '<GetInboxInvoiceListResponse xmlns="http://tempuri.org/">'
            + '<GetInboxInvoiceListResult IsSucceded="false" Message="Kullanici adi veya parola hatali"/>'
            + '</GetInboxInvoiceListResponse>'
        ), { 'Content-Type': 'text/xml' });
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    });

    test('WS-Security fault (FailedAuthentication) -> AUTH_FAILED, retryable=false', async () => {
        nock(HOST).post(PATH).reply(500, soap(
            '<s:Fault xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
            + '<faultcode>wsse:FailedAuthentication</faultcode>'
            + '<faultstring>At least one security token in the message could not be validated.</faultstring>'
            + '</s:Fault>'
        ), { 'Content-Type': 'text/xml' });
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({
            code: 'AUTH_FAILED', retryable: false,
        });
    });

    test('canli ucun Turkce yetki fault mesaji -> AUTH_FAILED (2026-08-03 duman testi sekli)', async () => {
        nock(HOST).post(PATH).reply(500, soap(
            '<s:Fault xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
            + '<faultcode>s:Client</faultcode>'
            + '<faultstring xml:lang="tr-TR">Bu sisteme erişmek için gerekli yetkiniz yok, Kullanıcı: x@y.com, Ip: 1.2.3.4</faultstring>'
            + '</s:Fault>'
        ), { 'Content-Type': 'text/xml' });
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({
            code: 'AUTH_FAILED', retryable: false,
        });
    });

    test('HTTP 503 (fault olmayan) -> retryable', async () => {
        nock(HOST).post(PATH).reply(503, 'Service Unavailable');
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({ retryable: true });
    });

    test('ag hatasi -> NETWORK_ERROR retryable', async () => {
        nock(HOST).post(PATH).replyWithError('ECONNRESET');
        await expect(makeProvider().listInboxInvoices()).rejects.toMatchObject({
            code: 'NETWORK_ERROR', retryable: true,
        });
    });
});

describe('UyumsoftProvider — getInboxInvoiceXml', () => {
    test('base64 Data cozulup UTF-8 XML string doner', async () => {
        const ubl = '<?xml version="1.0"?><Invoice><ID>CCI2026000012345</ID><Sirket>Çağrı Gıda</Sirket></Invoice>';
        const b64 = Buffer.from(ubl, 'utf8').toString('base64');
        nock(HOST).post(PATH).reply(200, soap(
            '<GetInboxInvoiceDataResponse xmlns="http://tempuri.org/">'
            + '<GetInboxInvoiceDataResult IsSucceded="true">'
            + `<Value InvoiceId="inv-1"><Data>${b64}</Data></Value>`
            + '</GetInboxInvoiceDataResult></GetInboxInvoiceDataResponse>'
        ), { 'Content-Type': 'text/xml' });

        const r = await makeProvider().getInboxInvoiceXml('inv-1');
        expect(r.invoiceId).toBe('inv-1');
        expect(r.xml).toContain('Çağrı Gıda'); // UTF-8 turkce korunur
        expect(r.xml).toContain('CCI2026000012345');
    });

    test('bos Data -> BAD_RESPONSE', async () => {
        nock(HOST).post(PATH).reply(200, soap(
            '<GetInboxInvoiceDataResponse xmlns="http://tempuri.org/">'
            + '<GetInboxInvoiceDataResult IsSucceded="true"><Value InvoiceId="inv-1"/></GetInboxInvoiceDataResult>'
            + '</GetInboxInvoiceDataResponse>'
        ), { 'Content-Type': 'text/xml' });
        await expect(makeProvider().getInboxInvoiceXml('inv-1')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    });

    test('invoiceId zorunlu', async () => {
        await expect(makeProvider().getInboxInvoiceXml('')).rejects.toThrow('invoiceId required');
    });
});

describe('UyumsoftProvider — sendDocumentResponse', () => {
    test('Approved cevabi dogru zarfla gider, ok=true doner', async () => {
        let captured = '';
        nock(HOST)
            .post(PATH, (body) => { captured = String(body); return true; })
            .reply(200, soap(
                '<SendDocumentResponseResponse xmlns="http://tempuri.org/">'
                + '<SendDocumentResponseResult IsSucceded="true" Value="true"/>'
                + '</SendDocumentResponseResponse>'
            ), { 'Content-Type': 'text/xml' });

        const r = await makeProvider().sendDocumentResponse([
            { invoiceId: 'inv-1', status: 'Approved', reason: 'Mal sayimi tamam' },
        ]);
        expect(r.ok).toBe(true);
        expect(captured).toContain('<InvoiceId>inv-1</InvoiceId>');
        expect(captured).toContain('<ResponseStatus>Approved</ResponseStatus>');
        expect(captured).toContain('<Reason>Mal sayimi tamam</Reason>');
    });

    test('gecersiz status -> throw (istek atilmaz)', async () => {
        await expect(makeProvider().sendDocumentResponse([
            { invoiceId: 'inv-1', status: 'Onaylandi' },
        ])).rejects.toThrow('invalid status');
    });

    test('bos liste -> throw', async () => {
        await expect(makeProvider().sendDocumentResponse([])).rejects.toThrow('responses required');
    });
});

describe('UyumsoftProvider — queryDocumentResponseStatus', () => {
    test('durum listesi normalize edilir', async () => {
        nock(HOST).post(PATH).reply(200, soap(
            '<QueryDocumentResponseStatusResponse xmlns="http://tempuri.org/">'
            + '<QueryDocumentResponseStatusResult IsSucceded="true">'
            + '<Value InvoiceId="inv-1" Status="Approved" StatusCode="7" Message="ok"/>'
            + '<Value InvoiceId="inv-2" Status="Processing" StatusCode="5"/>'
            + '</QueryDocumentResponseStatusResult></QueryDocumentResponseStatusResponse>'
        ), { 'Content-Type': 'text/xml' });

        const r = await makeProvider().queryDocumentResponseStatus(['inv-1', 'inv-2']);
        expect(r).toHaveLength(2);
        expect(r[0]).toEqual({ invoiceId: 'inv-1', status: 'Approved', statusCode: 7, message: 'ok' });
        expect(r[1].status).toBe('Processing');
    });
});

describe('UyumsoftProvider — ping', () => {
    test('liste basarili -> ok:true + totalCount', async () => {
        nock(HOST).post(PATH).reply(200, listResponse({ totalCount: 42 }), { 'Content-Type': 'text/xml' });
        const r = await makeProvider().ping();
        expect(r).toEqual({ ok: true, totalCount: 42 });
    });

    test('hata -> ok:false + error mesaji (throw ETMEZ)', async () => {
        nock(HOST).post(PATH).reply(503, 'down');
        const r = await makeProvider().ping();
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
    });
});

describe('UyumsoftProvider — constructor', () => {
    test('username/password zorunlu', () => {
        expect(() => new UyumsoftProvider({ password: 'x' })).toThrow('username');
        expect(() => new UyumsoftProvider({ username: 'x' })).toThrow('password');
    });
});
