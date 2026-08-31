// ==================================================================================
// UyumsoftProvider — Uyumsoft e-Fatura GELEN KUTUSU (inbox) SOAP istemcisi
// ==================================================================================
// Plan 27 devami (2026-08-03): otomatik tedarikci faturasi -> sube onayi -> stok girisi.
// ParasutProvider GIDEN fatura keser; bu provider GELEN faturayi ceker. Ikisi ayni
// InvoiceProviderError sozlesmesini paylasir ama arayuzleri farklidir:
//
// @typedef {Object} IInboxInvoiceProvider
// @property {(q?: object) => Promise<{pageIndex:number,pageSize:number,totalCount:number,totalPages:number,items:object[]}>} listInboxInvoices
// @property {(invoiceId: string) => Promise<{invoiceId:string, xml:string}>} getInboxInvoiceXml
// @property {(invoiceId: string) => Promise<{invoiceId:string, pdfBase64:string}>} getInboxInvoicePdf
// @property {(responses: Array<{invoiceId:string,status:'Approved'|'Declined'|'Return',reason?:string}>) => Promise<{ok:boolean,message?:string}>} sendDocumentResponse
// @property {(invoiceIds: string[]) => Promise<Array<{invoiceId:string,status:string,statusCode:number,message?:string}>>} queryDocumentResponseStatus
// @property {() => Promise<{ok:true,totalCount:number}|{ok:false,error:string}>} ping
//
// Servis: https://efatura.uyumsoft.com.tr/Services/Integration (BasicHttpBinding, SOAP 1.1)
// Auth  : WS-Security UsernameToken (PasswordText) — HTTPS uzerinden, her istekte header.
//         Token/refresh YOK; TokenManager kullanilmaz.
// Sema  : singleWsdl'den cikarildi (2026-08-03). Tum data-contract tipleri
//         http://tempuri.org/ namespace'inde; InvoiceListQueryModel sequence sirasi
//         onemlidir (WCF DataContractSerializer sira bozulursa alani yok sayar).
// Test  : efatura-test.uyumsoft.com.tr su an erisilemiyor — birim testler nock ile
//         canli sema sekilli sahte yanitlar uzerinden kosuluyor (uyumsoft-provider.test.js).
// ==================================================================================

const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { InvoiceProviderError } = require('./IInvoiceProvider');

const DEFAULT_BASE_URL = 'https://efatura.uyumsoft.com.tr/Services/Integration';
const DEFAULT_TIMEOUT_MS = 60000;
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const PASSWORD_TEXT_TYPE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';
const TEMPURI = 'http://tempuri.org/';

const RESPONSE_STATUSES = new Set(['Approved', 'Declined', 'Return']);

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function toIsoNoMs(d) {
    // WCF xs:dateTime — milisaniyesiz ISO kabul eder; Date veya string alir.
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) throw new Error(`UyumsoftProvider: invalid date "${d}"`);
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function asArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// faultstring gibi elemanlar xml:lang tasiyinca parser {'#text': '...', '@_xml:lang': ...}
// dondurur — metni guvenle cikar.
function textOf(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : '';
    return String(v);
}

class UyumsoftProvider {
    /**
     * @param {object} opts
     * @param {string} opts.username   Mukellef firmanin Uyumsoft API kullanicisi
     * @param {string} opts.password
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.timeoutMs]
     */
    constructor(opts) {
        for (const k of ['username', 'password']) {
            if (!opts || !opts[k]) throw new Error(`UyumsoftProvider: missing required option "${k}"`);
        }
        this.username = opts.username;
        this.password = opts.password;
        this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
        this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.providerName = 'uyumsoft';
        this._parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '@_',
            removeNSPrefix: true,
            parseTagValue: false,
            parseAttributeValue: false,
            trimValues: true,
        });
    }

    // -------------------- SOAP core --------------------

    _envelope(bodyXml) {
        return '<?xml version="1.0" encoding="utf-8"?>'
            + `<s:Envelope xmlns:s="${SOAP_NS}">`
            + '<s:Header>'
            + `<o:Security s:mustUnderstand="1" xmlns:o="${WSSE_NS}">`
            + '<o:UsernameToken>'
            + `<o:Username>${xmlEscape(this.username)}</o:Username>`
            + `<o:Password Type="${PASSWORD_TEXT_TYPE}">${xmlEscape(this.password)}</o:Password>`
            + '</o:UsernameToken>'
            + '</o:Security>'
            + '</s:Header>'
            + `<s:Body>${bodyXml}</s:Body>`
            + '</s:Envelope>';
    }

    async _call(operation, bodyXml) {
        let res;
        try {
            res = await axios.post(this.baseUrl, this._envelope(bodyXml), {
                timeout: this.timeoutMs,
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    SOAPAction: `"${TEMPURI}IIntegration/${operation}"`,
                },
                // SOAP Fault'lar HTTP 500 doner — govdesini biz yorumlayacagiz.
                validateStatus: () => true,
            });
        } catch (err) {
            throw new InvoiceProviderError(`Uyumsoft ${operation}: ${err.message}`, {
                code: 'NETWORK_ERROR',
                retryable: true,
                reqUrl: this.baseUrl,
                reqMethod: 'POST',
            });
        }

        let doc;
        try {
            doc = this._parser.parse(String(res.data || ''));
        } catch (e) {
            throw new InvoiceProviderError(`Uyumsoft ${operation}: gecersiz XML yanit`, {
                code: 'BAD_RESPONSE',
                status: res.status,
                retryable: res.status >= 500,
                reqUrl: this.baseUrl,
                reqMethod: 'POST',
            });
        }

        const body = doc && doc.Envelope && doc.Envelope.Body;
        const fault = body && body.Fault;
        if (fault) {
            const faultCode = textOf(fault.faultcode !== undefined ? fault.faultcode : (fault.Code && fault.Code.Value));
            const faultString = textOf(fault.faultstring !== undefined ? fault.faultstring : (fault.Reason && fault.Reason.Text)) || 'SOAP Fault';
            // "Bu sisteme erişmek için gerekli yetkiniz yok, Kullanıcı: ..." — canli
            // ucun sahte kimlik yaniti (2026-08-03 duman testi) auth hatasi sayilir.
            const isAuth = /FailedAuthentication|InvalidSecurity|Unauthorized|MessageSecurity|yetkiniz yok|yetkisiz|kullanici adi|parola/i
                .test((faultCode + ' ' + faultString).normalize('NFC').replace(/ı/g, 'i').replace(/İ/g, 'I'));
            throw new InvoiceProviderError(`Uyumsoft ${operation}: ${faultString}`, {
                code: isAuth ? 'AUTH_FAILED' : 'SOAP_FAULT',
                status: res.status,
                retryable: !isAuth && res.status >= 500 && !/Sender|Client/i.test(faultCode),
                providerPayload: { faultCode, faultString },
                reqUrl: this.baseUrl,
                reqMethod: 'POST',
            });
        }
        if (res.status >= 400) {
            throw new InvoiceProviderError(`Uyumsoft ${operation}: HTTP ${res.status}`, {
                code: 'HTTP_ERROR',
                status: res.status,
                retryable: res.status >= 500 || res.status === 429,
                reqUrl: this.baseUrl,
                reqMethod: 'POST',
            });
        }
        if (!body) {
            throw new InvoiceProviderError(`Uyumsoft ${operation}: SOAP Body yok`, {
                code: 'BAD_RESPONSE',
                status: res.status,
                retryable: false,
            });
        }
        return body;
    }

    /** Result sarmalayicisi (Response base: @IsSucceded/@Message) kontrolu. */
    _unwrap(operation, body, responseElement, resultElement) {
        const resp = body[responseElement];
        const result = resp && resp[resultElement];
        if (!result) {
            throw new InvoiceProviderError(`Uyumsoft ${operation}: beklenen ${resultElement} yok`, {
                code: 'BAD_RESPONSE',
                retryable: false,
                providerPayload: resp || null,
            });
        }
        const ok = String(result['@_IsSucceded']) === 'true';
        if (!ok) {
            const message = result['@_Message'] || 'IsSucceded=false';
            const isAuth = /kullanici|parola|password|user|yetki|unauthorized|login/i.test(String(message));
            throw new InvoiceProviderError(`Uyumsoft ${operation}: ${message}`, {
                code: isAuth ? 'AUTH_FAILED' : 'PROVIDER_REJECTED',
                retryable: false,
                providerPayload: { message },
            });
        }
        return result;
    }

    // -------------------- OPERATIONS --------------------

    /**
     * Gelen fatura listesi (sayfali).
     * @param {object} [q]
     * @param {Date|string} [q.createStartDate]   Faturanin sisteme dusme araligi
     * @param {Date|string} [q.createEndDate]
     * @param {Date|string} [q.executionStartDate] Fatura tarihi araligi
     * @param {Date|string} [q.executionEndDate]
     * @param {number} [q.pageIndex=0]
     * @param {number} [q.pageSize=50]
     * @param {boolean} [q.onlyNewestInvoices=false]  true: yalniz IsNew olanlar
     * @param {string[]} [q.invoiceIds]
     * @param {string} [q.targetTcknVkn]           Karsi taraf (tedarikci) VKN filtresi
     */
    async listInboxInvoices(q = {}) {
        const pageIndex = Number.isInteger(q.pageIndex) ? q.pageIndex : 0;
        const pageSize = Number.isInteger(q.pageSize) ? q.pageSize : 50;

        // DIKKAT: sequence sirasi WSDL'deki InvoiceListQueryModel ile birebir ayni olmali.
        const nil = (name) => `<${name} i:nil="true"/>`;
        const dateEl = (name, v) => (v ? `<${name}>${toIsoNoMs(v)}</${name}>` : nil(name));
        const parts = [
            dateEl('ExecutionStartDate', q.executionStartDate),
            dateEl('ExecutionEndDate', q.executionEndDate),
            dateEl('CreateStartDate', q.createStartDate),
            dateEl('CreateEndDate', q.createEndDate),
            nil('Status'),
            ...asArray(q.invoiceIds).map((id) => `<InvoiceIds>${xmlEscape(id)}</InvoiceIds>`),
            '<SortColumn>CreateDate</SortColumn>',
            '<SortMode>Descending</SortMode>',
            nil('IsArchived'),
            q.targetTcknVkn ? `<TargetTcknVkn>${xmlEscape(q.targetTcknVkn)}</TargetTcknVkn>` : '',
            '<IncludeTagList>false</IncludeTagList>',
        ].join('');

        const bodyXml = `<GetInboxInvoiceList xmlns="${TEMPURI}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">`
            + `<query PageIndex="${pageIndex}" PageSize="${pageSize}" OnlyNewestInvoices="${q.onlyNewestInvoices === true}">`
            + parts
            + '</query>'
            + '</GetInboxInvoiceList>';

        const body = await this._call('GetInboxInvoiceList', bodyXml);
        const result = this._unwrap('GetInboxInvoiceList', body, 'GetInboxInvoiceListResponse', 'GetInboxInvoiceListResult');
        const value = result.Value || {};
        const items = asArray(value.Items).map((it) => this._normalizeListItem(it));
        return {
            pageIndex: num(value['@_PageIndex'], pageIndex),
            pageSize: num(value['@_PageSize'], pageSize),
            totalCount: num(value['@_TotalCount'], items.length),
            totalPages: num(value['@_TotalPages'], 1),
            items,
        };
    }

    _normalizeListItem(it) {
        return {
            invoiceId: it.InvoiceId || '',
            // DocumentId = resmi fatura numarasi (or. ABC2026000000123)
            documentId: it.DocumentId || '',
            type: it.Type || '',
            invoiceTipType: it.InvoiceTipType || '', // Sales | Return | ...
            status: it.Status || '',
            statusCode: num(it.StatusCode, 0),
            envelopeStatus: it.EnvelopeStatus || '',
            // Gelen kutusunda "Target" = karsi taraf = tedarikci
            counterpartyVkn: it.TargetTcknVkn || '',
            counterpartyTitle: it.TargetTitle || '',
            createDateUtc: it.CreateDateUtc || '',
            executionDate: it.ExecutionDate && it.ExecutionDate['@_nil'] !== 'true' ? String(it.ExecutionDate) : '',
            payableAmount: num(it.PayableAmount),
            taxTotal: num(it.TaxTotal),
            taxExclusiveAmount: num(it.TaxExclusiveAmount),
            currency: it.DocumentCurrencyCode || 'TRY',
            isNew: String(it.IsNew) === 'true',
            isSeen: String(it.IsSeen) === 'true',
        };
    }

    /** UBL-TR fatura XML'i (base64 cozulmus, utf-8 string). */
    async getInboxInvoiceXml(invoiceId) {
        if (!invoiceId) throw new Error('UyumsoftProvider.getInboxInvoiceXml: invoiceId required');
        const bodyXml = `<GetInboxInvoiceData xmlns="${TEMPURI}"><invoiceId>${xmlEscape(invoiceId)}</invoiceId></GetInboxInvoiceData>`;
        const body = await this._call('GetInboxInvoiceData', bodyXml);
        const result = this._unwrap('GetInboxInvoiceData', body, 'GetInboxInvoiceDataResponse', 'GetInboxInvoiceDataResult');
        const value = result.Value || {};
        const b64 = typeof value.Data === 'string' ? value.Data : '';
        if (!b64) {
            throw new InvoiceProviderError('Uyumsoft GetInboxInvoiceData: bos Data', {
                code: 'BAD_RESPONSE',
                retryable: false,
            });
        }
        return {
            invoiceId: value['@_InvoiceId'] || invoiceId,
            xml: Buffer.from(b64, 'base64').toString('utf8'),
        };
    }

    /** Fatura PDF gorunumu (base64). Panel onizleme icin. */
    async getInboxInvoicePdf(invoiceId) {
        if (!invoiceId) throw new Error('UyumsoftProvider.getInboxInvoicePdf: invoiceId required');
        const bodyXml = `<GetInboxInvoicePdf xmlns="${TEMPURI}"><invoiceId>${xmlEscape(invoiceId)}</invoiceId></GetInboxInvoicePdf>`;
        const body = await this._call('GetInboxInvoicePdf', bodyXml);
        const result = this._unwrap('GetInboxInvoicePdf', body, 'GetInboxInvoicePdfResponse', 'GetInboxInvoicePdfResult');
        const value = result.Value || {};
        return {
            invoiceId: value['@_InvoiceId'] || invoiceId,
            pdfBase64: typeof value.Data === 'string' ? value.Data : '',
        };
    }

    /**
     * Ticari faturaya kabul/red cevabi (sube onayinin resmi karsiligi).
     * DIKKAT: yalniz TICARIFATURA senaryosunda anlamli; TEMELFATURA'da GIB cevap kabul etmez —
     * cagiran katman senaryoyu UBL ProfileID'den kontrol etmeli.
     * @param {Array<{invoiceId:string,status:'Approved'|'Declined'|'Return',reason?:string}>} responses
     */
    async sendDocumentResponse(responses) {
        const list = asArray(responses);
        if (list.length === 0) throw new Error('UyumsoftProvider.sendDocumentResponse: responses required');
        for (const r of list) {
            if (!r || !r.invoiceId) throw new Error('UyumsoftProvider.sendDocumentResponse: invoiceId required');
            if (!RESPONSE_STATUSES.has(r.status)) {
                throw new Error(`UyumsoftProvider.sendDocumentResponse: invalid status "${r && r.status}"`);
            }
        }
        const items = list.map((r) =>
            '<DocumentResponseInfo>'
            + `<InvoiceId>${xmlEscape(r.invoiceId)}</InvoiceId>`
            + `<ResponseStatus>${r.status}</ResponseStatus>`
            + (r.reason ? `<Reason>${xmlEscape(r.reason)}</Reason>` : '')
            + '</DocumentResponseInfo>'
        ).join('');
        const bodyXml = `<SendDocumentResponse xmlns="${TEMPURI}"><responses>${items}</responses></SendDocumentResponse>`;
        const body = await this._call('SendDocumentResponse', bodyXml);
        const result = this._unwrap('SendDocumentResponse', body, 'SendDocumentResponseResponse', 'SendDocumentResponseResult');
        return { ok: String(result['@_Value']) === 'true', message: result['@_Message'] || '' };
    }

    /** Gonderilmis kabul/red cevaplarinin GIB durumunu sorgular. */
    async queryDocumentResponseStatus(invoiceIds) {
        const ids = asArray(invoiceIds);
        if (ids.length === 0) throw new Error('UyumsoftProvider.queryDocumentResponseStatus: invoiceIds required');
        const ARR_NS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';
        const bodyXml = `<QueryDocumentResponseStatus xmlns="${TEMPURI}">`
            + `<invoiceIds xmlns:a="${ARR_NS}">`
            + ids.map((id) => `<a:string>${xmlEscape(id)}</a:string>`).join('')
            + '</invoiceIds>'
            + '</QueryDocumentResponseStatus>';
        const body = await this._call('QueryDocumentResponseStatus', bodyXml);
        const result = this._unwrap('QueryDocumentResponseStatus', body, 'QueryDocumentResponseStatusResponse', 'QueryDocumentResponseStatusResult');
        return asArray(result.Value).map((v) => ({
            invoiceId: v['@_InvoiceId'] || '',
            status: v['@_Status'] || '',
            statusCode: num(v['@_StatusCode'], 0),
            message: v['@_Message'] || '',
        }));
    }

    /** Saglik testi: 1 kayitlik liste sorgusu (ayri bir ping metodu yok). */
    async ping() {
        try {
            const r = await this.listInboxInvoices({ pageIndex: 0, pageSize: 1 });
            return { ok: true, totalCount: r.totalCount };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }
}

module.exports = UyumsoftProvider;
