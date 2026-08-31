// ==================================================================================
// ParasutInboxProvider — Parasut GELEN e-fatura (inbox) istemcisi
// ==================================================================================
// UyumsoftProvider ile AYNI inbox arayuzunu uygular; InboxInvoiceService ikisini de
// ayirt etmeden kullanir:
//
//   listInboxInvoices(q)     -> { pageIndex, pageSize, totalCount, totalPages, hasMore, items[] }
//   getInboxInvoiceXml(id)   -> { invoiceId, xml }        (UBL-TR 1.2)
//   getInboxInvoicePdf(id)   -> { invoiceId, pdfBase64 }
//   sendDocumentResponse(..) -> DESTEKLENMIYOR (asagiya bak)
//   ping()                   -> { ok, totalCount }
//
// ----------------------------------------------------------------------------------
// API sozlesmesi — 31.08.2026'da CANLI Parasut hesabinda dogrulandi
// (scripts/_parasut_inbox_sozlesme_probe*.js ciktilari). Tahmin YOK:
//
//   1) YON FILTRESI YOK. /e_invoices yalniz su filtreleri kabul eder:
//      issue_date, scenario, net_total. filter[direction] -> HTTP 400.
//      => gelen/giden ayrimi ISTEMCI TARAFINDA yapilir (attributes.direction === 'inbound').
//      => Bir API sayfasi tamamen GIDEN faturadan olusabilir (gorulmustur). Bu yuzden
//         "sayfa bos geldi, bitti" varsayimi YANLIS olur; sayfalamayi meta belirler.
//         Servise `hasMore` doner (meta.current_page < meta.total_pages).
//
//   2) TARIH FILTRESI: filter[issue_date][gteq] / [lteq]. Gecerli operatorler:
//      eq, lt, gt, gteq, lteq, not_eq. ([gte]/[lte] HTTP 400 verir.)
//      DIKKAT: Uyumsoft'ta createStartDate = faturanin GELEN KUTUSUNA DUSME tarihi;
//      Parasut'te suzme alani issue_date = faturanin KESIM tarihidir. Gec ulasan bir
//      fatura dar bir pencerede kacabilir -> senkron penceresi genis tutulmali
//      (varsayilan geri bakis server.js tarafinda 30 gun).
//
//   3) SAYFALAMA: page[number] 1-TABANLI (0 gonderilirse sunucu 1. sayfayi doner),
//      page[size] 100'e kadar calisir. meta: current_page, total_pages, total_count, per_page.
//      Servis 0-tabanli pageIndex kullanir -> burada +1 cevrilir.
//      totalCount/totalPages API'nin HER IKI YONU kapsayan sayilaridir; items ise
//      yalniz gelen faturalardir. Bu bilincli bir tercihtir: sayfa yurumesi API
//      sayfalarina gore ilerler, sayac paneldeki "kac kayit tarandi" bilgisidir.
//
//   4) UBL: GET /e_invoices/{id}/signed_ubl -> application/zip (tek dosyali).
//      PDF: GET /e_invoices/{id}/pdf -> JSON { data.attributes.url } = imzali S3 linki
//           (2 saat gecerli, indirmesi kimliksizdir).
//
//   5) TUTARLAR: attributes.net_total ODENECEK (KDV DAHIL) tutardir — fatura notundaki
//      yaziyla-tutar ile dogrulandi (19.916,40 TL / total_vat 197,19).
//      => payableAmount = net_total, taxTotal = total_vat,
//         taxExclusiveAmount = net_total - total_vat.
//      Bunlar YALNIZ liste ekrani icindir; stok girisinin dayanagi UBL'dir.
//
//   6) KABUL/RED CEVABI YOK. Parasut v4'te gelen faturaya DocumentResponse gonderen
//      bir uc bulunamadi; faturanin `is_answerable` alani TEMELFATURA'da zaten false.
//      supportsDocumentResponse = false -> InboxInvoiceService resmi cevap ADIMINI
//      ATLAR. TICARIFATURA'ya kabul/red gerekiyorsa Parasut arayuzunden verilmelidir.
//      (Cevapsiz TICARIFATURA 8 gun sonra GIB tarafinda kabul edilmis sayilir.)
//
//   7) HIZ LIMITI: 10 istek / 10 sn. 429 govdesi "Try again in N seconds." verir;
//      istekler arasi minimum aralik + Retry-After'a uyan yeniden deneme uygulanir.
// ==================================================================================

const zlib = require('zlib');
const axios = require('axios');
const ParasutProvider = require('./ParasutProvider');
const { InvoiceProviderError } = require('./IInvoiceProvider');

const DEFAULT_BASE_URL = 'https://api.parasut.com';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MIN_INTERVAL_MS = 1200; // 10 istek/10 sn tavaninin altinda kalir
const MAX_PAGE_SIZE = 100;
const TOKEN_SKEW_MS = 60000;
const MAX_429_RETRY = 3;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/** Date | 'YYYY-MM-DD' | ISO string -> 'YYYY-MM-DD'. Bos/gecersiz -> ''. */
function toDateOnly(v) {
    if (!v) return '';
    if (typeof v === 'string') {
        const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
    }
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

/**
 * Tek dosyali zip'ten ilk girdiyi cikarir (stored veya deflate).
 * compSize 0 ise (data descriptor) merkezi dizinden okunur.
 */
function unzipFirstEntry(buf) {
    if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('zip yerel basligi bulunamadi');
    const method = buf.readUInt16LE(8);
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    let compSize = buf.readUInt32LE(18);
    if (compSize === 0) {
        const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        if (eocd < 0) throw new Error('zip merkezi dizini bulunamadi');
        const cdOff = buf.readUInt32LE(eocd + 16);
        compSize = buf.readUInt32LE(cdOff + 20);
    }
    const start = 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    return method === 8 ? zlib.inflateRawSync(data) : data;
}

class ParasutInboxProvider {
    /**
     * @param {object} opts
     * @param {string} opts.clientId
     * @param {string} opts.clientSecret
     * @param {string} opts.username
     * @param {string} opts.password
     * @param {string} opts.companyId
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.timeoutMs]
     * @param {number} [opts.minRequestIntervalMs]
     * @param {object} [opts.logger]
     */
    constructor(opts = {}) {
        for (const k of ['clientId', 'clientSecret', 'username', 'password', 'companyId']) {
            if (!opts[k]) throw new Error(`ParasutInboxProvider: missing required option "${k}"`);
        }
        this.companyId = String(opts.companyId);
        this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
        this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.minRequestIntervalMs = opts.minRequestIntervalMs === undefined
            ? DEFAULT_MIN_INTERVAL_MS
            : opts.minRequestIntervalMs;
        this.logger = opts.logger || console;

        this.providerName = 'parasut';
        // InboxInvoiceService bunu gorunce resmi kabul/red adimini atlar (bkz. baslik 6).
        this.supportsDocumentResponse = false;

        // OAuth'u tekrar yazmamak icin mevcut ParasutProvider'in authenticate/refresh'i kullanilir.
        this.auth = opts.authClient || new ParasutProvider({
            clientId: opts.clientId,
            clientSecret: opts.clientSecret,
            username: opts.username,
            password: opts.password,
            companyId: this.companyId,
            baseUrl: this.baseUrl,
            timeoutMs: opts.timeoutMs,
        });

        this._token = null;
        this._tokenExpiresAt = 0;
        this._tokenPromise = null;
        this._lastRequestAt = 0;
    }

    // -------------------- AUTH --------------------

    /** Token'i ornek icinde onbellekler; es zamanli cagrilar tek istek uretir. */
    async _getToken(force = false) {
        if (!force && this._token && Date.now() < this._tokenExpiresAt) return this._token;
        if (!this._tokenPromise) {
            this._tokenPromise = (async () => {
                const r = await this.auth.authenticate();
                this._token = r.accessToken;
                this._tokenExpiresAt = Date.now() + (num(r.expiresIn, 7200) * 1000) - TOKEN_SKEW_MS;
                return this._token;
            })().finally(() => { this._tokenPromise = null; });
        }
        return this._tokenPromise;
    }

    // -------------------- HTTP --------------------

    async _throttle() {
        if (!this.minRequestIntervalMs) return;
        const wait = this._lastRequestAt + this.minRequestIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        this._lastRequestAt = Date.now();
    }

    /** 429 govdesindeki "Try again in N seconds." -> ms. Bulunamazsa varsayilan. */
    _retryAfterMs(res) {
        const header = res && res.headers && res.headers['retry-after'];
        if (header && Number.isFinite(Number(header))) return (Number(header) * 1000) + 500;
        let detail = '';
        try {
            const body = Buffer.isBuffer(res.data) ? JSON.parse(res.data.toString('utf8')) : res.data;
            detail = (((body || {}).errors || [])[0] || {}).detail || '';
        } catch (e) { /* govde JSON degilse varsayilana dus */ }
        const m = String(detail).match(/(\d+)\s*second/i);
        return m ? (Number(m[1]) * 1000) + 500 : 2500;
    }

    /**
     * GET /v4/{company}{suffix}. Hiz limiti aralik + 429 yeniden deneme + 401'de tek re-auth.
     * @param {string} suffix
     * @param {'json'|'arraybuffer'} [responseType]
     */
    async _get(suffix, responseType = 'json') {
        const url = `${this.baseUrl}/v4/${this.companyId}${suffix}`;
        let reauthed = false;
        for (let attempt = 0; ; attempt++) {
            await this._throttle();
            const token = await this._getToken();
            let res;
            try {
                res = await axios.get(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: responseType === 'json' ? 'application/json' : '*/*',
                    },
                    timeout: this.timeoutMs,
                    responseType: responseType === 'json' ? 'json' : 'arraybuffer',
                    validateStatus: () => true,
                });
            } catch (err) {
                // Ag/timeout — yeniden denenebilir
                throw new InvoiceProviderError(`Parasut inbox GET ${suffix}: ${err.message}`, {
                    code: 'NETWORK_ERROR', retryable: true, reqUrl: url, reqMethod: 'GET',
                });
            }

            if (res.status === 429 && attempt < MAX_429_RETRY) {
                const waitMs = this._retryAfterMs(res);
                this.logger.warn(`[parasut-inbox] 429, ${waitMs} ms bekleniyor (${suffix})`);
                await sleep(waitMs);
                continue;
            }
            if (res.status === 401 && !reauthed) {
                reauthed = true;
                await this._getToken(true);
                continue;
            }
            if (res.status >= 400) {
                const body = Buffer.isBuffer(res.data) ? res.data.toString('utf8').slice(0, 300) : JSON.stringify(res.data).slice(0, 300);
                throw new InvoiceProviderError(`Parasut inbox GET ${suffix} -> HTTP ${res.status} ${body}`, {
                    code: res.status === 401 ? 'AUTH_FAILED' : (res.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_REJECTED'),
                    status: res.status,
                    retryable: res.status === 429 || res.status >= 500,
                    reqUrl: url,
                    reqMethod: 'GET',
                });
            }
            return res;
        }
    }

    // -------------------- OPERATIONS --------------------

    /**
     * Gelen fatura listesi (sayfali). Yon filtresi API'de olmadigi icin gelen/giden
     * ayrimi burada yapilir; sayfalama meta'ya gore ilerler (bkz. baslik 1).
     *
     * @param {object} [q]
     * @param {Date|string} [q.createStartDate]  -> filter[issue_date][gteq]
     * @param {Date|string} [q.createEndDate]    -> filter[issue_date][lteq]
     * @param {number} [q.pageIndex=0]           0-tabanli (API 1-tabanliya cevrilir)
     * @param {number} [q.pageSize=50]           en fazla 100
     */
    async listInboxInvoices(q = {}) {
        const pageIndex = Number.isInteger(q.pageIndex) && q.pageIndex >= 0 ? q.pageIndex : 0;
        const pageSize = Math.min(Math.max(Number.isInteger(q.pageSize) ? q.pageSize : 50, 1), MAX_PAGE_SIZE);

        const params = [
            'sort=-issue_date',
            `page[number]=${pageIndex + 1}`,
            `page[size]=${pageSize}`,
        ];
        const gteq = toDateOnly(q.createStartDate);
        const lteq = toDateOnly(q.createEndDate);
        if (gteq) params.push(`filter[issue_date][gteq]=${gteq}`);
        if (lteq) params.push(`filter[issue_date][lteq]=${lteq}`);

        const res = await this._get(`/e_invoices?${params.join('&')}`);
        const body = res.data || {};
        const rows = Array.isArray(body.data) ? body.data : [];
        const meta = body.meta || {};

        const items = rows
            .filter((e) => e && e.attributes && e.attributes.direction === 'inbound')
            .map((e) => this._normalizeListItem(e));

        const currentPage = num(meta.current_page, pageIndex + 1);
        const totalPages = num(meta.total_pages, currentPage);
        return {
            pageIndex,
            pageSize,
            totalCount: num(meta.total_count, rows.length),
            totalPages,
            // Servis bununla ilerler; "bos sayfa = bitti" varsayimini devre disi birakir.
            hasMore: currentPage < totalPages,
            scannedOnPage: rows.length,
            items,
        };
    }

    _normalizeListItem(e) {
        const a = e.attributes || {};
        const payable = num(a.net_total);
        const tax = num(a.total_vat);
        return {
            invoiceId: String(e.id),
            // Resmi fatura numarasi (or. YB12026000176927)
            documentId: a.external_id || '',
            uuid: a.uuid || '',
            type: a.item_type || '',
            // Uyumsoft'ta Sales/Return; Parasut'te SATIS/IADE. IADE bir tedarikci iade
            // faturasidir — onaylanirsa stok ARTIRIR; panel bu alani gostermelidir.
            invoiceTipType: a.invoice_type_code || '',
            profileId: a.profile_id || '',
            scenario: a.scenario || '',
            status: a.status || '',
            statusCode: num(a.status_code, 0),
            envelopeStatus: '',
            counterpartyVkn: a.from_vkn || '',
            counterpartyTitle: a.contact_name || '',
            createDateUtc: a.created_at || '',
            executionDate: a.issue_date || '',
            payableAmount: payable,
            taxTotal: tax,
            taxExclusiveAmount: round2(payable - tax),
            // Parasut para birimini TRL yazar; sistemin geri kalani TRY kullanir.
            currency: a.currency === 'TRL' ? 'TRY' : (a.currency || 'TRY'),
            isNew: a.is_seen !== true,
            isSeen: a.is_seen === true,
            isAnswerable: a.is_answerable === true,
            responseType: a.response_type || null,
        };
    }

    /** UBL-TR fatura XML'i. signed_ubl zip doner; tek dosyasi cikarilir. */
    async getInboxInvoiceXml(invoiceId) {
        if (!invoiceId) throw new Error('ParasutInboxProvider.getInboxInvoiceXml: invoiceId required');
        const res = await this._get(`/e_invoices/${encodeURIComponent(invoiceId)}/signed_ubl`, 'arraybuffer');
        const buf = Buffer.from(res.data || []);
        if (buf.length === 0) {
            throw new InvoiceProviderError(`Parasut signed_ubl bos (${invoiceId})`, { code: 'BAD_RESPONSE', retryable: false });
        }
        let xml;
        if (buf[0] === 0x50 && buf[1] === 0x4b) {
            try {
                xml = unzipFirstEntry(buf).toString('utf8');
            } catch (e) {
                throw new InvoiceProviderError(`Parasut signed_ubl zip acilamadi (${invoiceId}): ${e.message}`, { code: 'BAD_RESPONSE', retryable: false });
            }
        } else {
            const asText = buf.toString('utf8');
            if (asText.trimStart().startsWith('<')) xml = asText;
            else {
                throw new InvoiceProviderError(`Parasut signed_ubl beklenmeyen govde (${invoiceId}): ${asText.slice(0, 120)}`, { code: 'BAD_RESPONSE', retryable: false });
            }
        }
        return { invoiceId: String(invoiceId), xml };
    }

    /** PDF onizleme: /pdf imzali S3 linki verir, indirme kimliksizdir. */
    async getInboxInvoicePdf(invoiceId) {
        if (!invoiceId) throw new Error('ParasutInboxProvider.getInboxInvoicePdf: invoiceId required');
        const res = await this._get(`/e_invoices/${encodeURIComponent(invoiceId)}/pdf`);
        const url = res.data && res.data.data && res.data.data.attributes && res.data.data.attributes.url;
        if (!url) {
            throw new InvoiceProviderError(`Parasut PDF linki alinamadi (${invoiceId})`, { code: 'BAD_RESPONSE', retryable: false });
        }
        const file = await axios.get(url, { timeout: this.timeoutMs, responseType: 'arraybuffer', validateStatus: () => true });
        if (file.status >= 400) {
            throw new InvoiceProviderError(`Parasut PDF indirilemedi (${invoiceId}) HTTP ${file.status}`, { code: 'BAD_RESPONSE', status: file.status, retryable: file.status >= 500 });
        }
        return { invoiceId: String(invoiceId), pdfBase64: Buffer.from(file.data || []).toString('base64') };
    }

    /**
     * Parasut v4'te gelen faturaya resmi kabul/red cevabi gonderen uc YOK (baslik 6).
     * FIRLATMAZ — cagiran katman best-effort calisir; unsupported isaretiyle doner.
     */
    async sendDocumentResponse(responses) {
        return {
            ok: false,
            unsupported: true,
            message: 'Parasut API gelen faturaya DocumentResponse gondermeyi desteklemiyor; kabul/red Parasut arayuzunden verilir.',
            requested: Array.isArray(responses) ? responses.length : 0,
        };
    }

    /** Ayni sekilde sorgulanamaz. */
    async queryDocumentResponseStatus(invoiceIds) {
        const ids = Array.isArray(invoiceIds) ? invoiceIds : [invoiceIds].filter(Boolean);
        return ids.map((id) => ({ invoiceId: String(id), status: 'UNSUPPORTED', statusCode: 0, message: 'Parasut DocumentResponse sorgusu desteklemiyor' }));
    }

    /** Saglik testi: 1 kayitlik liste sorgusu. */
    async ping() {
        try {
            const r = await this.listInboxInvoices({ pageIndex: 0, pageSize: 1 });
            return { ok: true, totalCount: r.totalCount };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }
}

module.exports = ParasutInboxProvider;
module.exports.unzipFirstEntry = unzipFirstEntry;
module.exports.toDateOnly = toDateOnly;
