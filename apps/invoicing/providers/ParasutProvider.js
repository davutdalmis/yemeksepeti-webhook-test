// ==================================================================================
// ParasutProvider — IInvoiceProvider impl for Parasut (api.parasut.com v4)
// ==================================================================================
// OAuth2 password grant + JSON:API request builder + response normalizer.
// Tek-tenant scope: her instance bir tenant'in credentialslarina sahip.
// Tenant izolasyonu cagiran katman (TokenManager + Worker) tarafindan saglanir.
// ==================================================================================

const axios = require('axios');
const { InvoiceProviderError } = require('./IInvoiceProvider');

const DEFAULT_BASE_URL = 'https://api.parasut.com';
const DEFAULT_TIMEOUT_MS = 30000;

class ParasutProvider {
    /**
     * @param {object} opts
     * @param {string} opts.clientId
     * @param {string} opts.clientSecret
     * @param {string} opts.username
     * @param {string} opts.password
     * @param {string} opts.companyId
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.timeoutMs]
     * @param {object} [opts.refCache]   ProviderRefCache — isim->Parasut ID kalici onbellegi.
     *                                   Verilmezse davranis eskisiyle birebir ayni (her cagri arama yapar).
     * @param {string} [opts.tenantId]   refCache scope'u icin zorunlu; refCache yoksa gereksiz.
     */
    constructor(opts) {
        const required = ['clientId', 'clientSecret', 'username', 'password', 'companyId'];
        for (const k of required) {
            if (!opts || !opts[k]) throw new Error(`ParasutProvider: missing required option "${k}"`);
        }
        this.clientId = opts.clientId;
        this.clientSecret = opts.clientSecret;
        this.username = opts.username;
        this.password = opts.password;
        this.companyId = String(opts.companyId);
        this.baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
        this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.providerName = 'parasut';
        // 2026-07-29: 429 olayi sonrasi eklendi. Onbellek YALNIZ kimlik cozumleme
        // (arama) isteklerini eler; olusturma/fatura akisi degismez.
        this.refCache = opts.refCache || null;
        this.tenantId = opts.tenantId || null;
        // Istek-basina hiz limiti. Parasut tavani: 10 istek / 10 sn (swagger "Genel
        // Bilgiler"). InvoiceWorker'daki kapi IS basina sayiyordu; tek bir siparis
        // 17 istek uretebildigi icin tavan asiliyordu. Burasi HER istegi sayar.
        // Enjekte edilmezse davranis eskisiyle birebir ayni (limitleme yok).
        this.rateLimiter = opts.rateLimiter || null;
        this.rateLimitMaxWaitMs = opts.rateLimitMaxWaitMs || 30000;
    }

    /**
     * Hiz limiti jetonu alinana kadar bekler. Jeton yoksa THROW ETMEZ, bekler —
     * cunku bir siparisin ortasinda patlamak yerine yavaslamak dogru davranis.
     * Ust sinir asilirsa retryable 429 firlatir, BullMQ backoff'a devreder.
     */
    async _acquireSlot() {
        if (!this.rateLimiter || !this.tenantId) return;
        const deadline = Date.now() + this.rateLimitMaxWaitMs;
        for (;;) {
            let res;
            try {
                res = await this.rateLimiter.tryAcquire(this.tenantId);
            } catch (e) {
                return; // limitleyici bozuksa akisi durdurma
            }
            if (res && res.allowed) return;

            const waitMs = Math.min(Math.max(Number(res && res.retryAfterMs) || 250, 100), 2000);
            if (Date.now() + waitMs > deadline) {
                throw new InvoiceProviderError('Local rate limit wait exceeded', {
                    code: 'RATE_LIMIT_WAIT_TIMEOUT',
                    status: 429,
                    retryable: true,
                });
            }
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }

    // -------------------- AUTH --------------------

    async authenticate() {
        const url = `${this.baseUrl}/oauth/token`;
        const body = {
            grant_type: 'password',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            username: this.username,
            password: this.password,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        };
        try {
            const { data } = await axios.post(url, body, { timeout: this.timeoutMs });
            return {
                accessToken: data.access_token,
                expiresIn: data.expires_in || 7200,
                refreshToken: data.refresh_token,
                tokenType: data.token_type || 'Bearer',
            };
        } catch (err) {
            throw this._wrap(err, 'AUTH_FAILED');
        }
    }

    async refresh(refreshToken) {
        const url = `${this.baseUrl}/oauth/token`;
        const body = {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: this.clientId,
            client_secret: this.clientSecret,
        };
        try {
            const { data } = await axios.post(url, body, { timeout: this.timeoutMs });
            return {
                accessToken: data.access_token,
                expiresIn: data.expires_in || 7200,
                refreshToken: data.refresh_token,
                tokenType: data.token_type || 'Bearer',
            };
        } catch (err) {
            throw this._wrap(err, 'REFRESH_FAILED');
        }
    }

    // -------------------- HEALTH --------------------

    async ping(token) {
        // Parasut API: /v4/me ve /v4/companies global endpoint'leri (companyId prefix YOK).
        // Her tenant icin /me ile kullaniciyi dogrula + /companies'ten configure edilen
        // companyId'nin gercekten erisilebilir oldugunu validate et.
        try {
            const meUrl = `${this.baseUrl}/v4/me`;
            const companiesUrl = `${this.baseUrl}/v4/companies`;
            const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
            const [meRes, coRes] = await Promise.all([
                axios.get(meUrl, { headers, timeout: this.timeoutMs }),
                axios.get(companiesUrl, { headers, timeout: this.timeoutMs }),
            ]);
            const companies = Array.isArray(coRes.data && coRes.data.data) ? coRes.data.data : [];
            const match = companies.find((c) => String(c.id) === this.companyId);
            if (!match) {
                return {
                    ok: false,
                    error: `companyId "${this.companyId}" not accessible by user "${meRes.data && meRes.data.data && meRes.data.data.attributes && meRes.data.data.attributes.email || '?'}". Available: ${companies.map((c) => c.id).join(', ') || 'none'}`,
                    code: 'COMPANY_NOT_ACCESSIBLE',
                };
            }
            return {
                ok: true,
                company: { id: match.id, ...(match.attributes || {}) },
            };
        } catch (err) {
            return { ok: false, error: err.message, code: err.code };
        }
    }

    // -------------------- CONTACT --------------------

    async upsertContact(token, branch) {
        const taxNo = branch.taxNumber || branch.vatNumber || branch.vergiNo;
        // Onbellek anahtari: vergi no varsa o, yoksa sube adi.
        // NOT: vergi no YOKKEN eski kod arama bile yapmadan HER SEFERINDE yeni cari
        // yaratiyordu (Parasut'ta mukerrer sube carileri). Onbellek bunu da kapatir.
        const refLabel = taxNo || branch.name || branch.branchName;
        const cachedId = await this._lookupRef('contacts', refLabel);
        if (cachedId) return { contactId: cachedId, created: false, fromCache: true };

        if (taxNo) {
            const found = await this._get(token, `/contacts?filter[tax_number]=${encodeURIComponent(taxNo)}&page[size]=1`);
            if (found && Array.isArray(found.data) && found.data.length > 0) {
                const foundId = String(found.data[0].id);
                await this._rememberRef('contacts', refLabel, foundId);
                return { contactId: foundId, created: false };
            }
        }
        const payload = {
            data: {
                type: 'contacts',
                attributes: {
                    name: branch.name || branch.branchName || 'Sube',
                    // account_type Parasut'ta ZORUNLU (sadece 'customer' | 'supplier').
                    // Sube faturalanan taraf oldugu icin daima 'customer'.
                    account_type: 'customer',
                    contact_type: taxNo ? 'company' : 'person',
                    tax_number: taxNo || '',
                    tax_office: branch.taxOffice || '',
                    address: branch.address || '',
                    city: branch.city || '',
                    district: branch.district || '',
                    phone: branch.phone || '',
                    email: branch.email || '',
                },
            },
        };
        const created = await this._post(token, '/contacts', payload);
        if (!created || !created.data || !created.data.id) {
            throw new InvoiceProviderError('Contact create returned no id', { code: 'CONTACT_CREATE_NO_ID' });
        }
        const newId = String(created.data.id);
        await this._rememberRef('contacts', refLabel, newId);
        return { contactId: newId, created: true };
    }

    // -------------------- PRODUCT --------------------

    async upsertProduct(token, product) {
        const name = product.name || product.productName;
        if (!name) throw new InvoiceProviderError('Product name required', { code: 'PRODUCT_NO_NAME' });

        // Onbellek: daha once cozulmus urun icin Parasut'a HIC gitme.
        // Bu satir olmadan her siparis her kalem icin 1 arama istegi atiyordu (429 kok nedeni).
        const cachedId = await this._lookupRef('products', name);
        if (cachedId) return { productId: cachedId, created: false, fromCache: true };

        const found = await this._get(token, `/products?filter[name]=${encodeURIComponent(name)}&page[size]=1`);
        if (found && Array.isArray(found.data) && found.data.length > 0) {
            const foundId = String(found.data[0].id);
            await this._rememberRef('products', name, foundId);
            return { productId: foundId, created: false };
        }
        const payload = {
            data: {
                type: 'products',
                attributes: {
                    name,
                    code: product.code || product.sku || '',
                    vat_rate: typeof product.vatRate === 'number' ? product.vatRate : 20,
                    unit: product.unit || 'Adet',
                    list_price: typeof product.listPrice === 'number' ? product.listPrice : 0,
                    currency: product.currency || 'TRL',
                    inventory_tracking: false,
                },
            },
        };
        const created = await this._post(token, '/products', payload);
        if (!created || !created.data || !created.data.id) {
            throw new InvoiceProviderError('Product create returned no id', { code: 'PRODUCT_CREATE_NO_ID' });
        }
        const newId = String(created.data.id);
        await this._rememberRef('products', name, newId);
        return { productId: newId, created: true };
    }

    // -------------------- REF CACHE (isim -> Parasut ID) --------------------

    /** Onbellekte varsa ID doner, yoksa null. refCache enjekte edilmemisse daima null. */
    async _lookupRef(kind, label) {
        if (!this.refCache || !this.tenantId || !label) return null;
        try {
            return await this.refCache.get(this.tenantId, kind, label);
        } catch (e) {
            return null; // onbellek asla akisi bozmaz
        }
    }

    /** Cozulen eslesmeyi kaydet. Hata yutulur. */
    async _rememberRef(kind, label, parasutId) {
        if (!this.refCache || !this.tenantId || !label || !parasutId) return;
        try {
            await this.refCache.set(this.tenantId, kind, label, parasutId);
        } catch (e) {
            // yoksay
        }
    }

    // -------------------- INVOICE --------------------

    async createInvoice(token, payload) {
        const {
            contactId,
            items,
            currency = 'TRL',
            issueDate,
            invoiceSeries,
            description,
            shipmentIncluded = false,
            documentType = 'sales_invoice',
            // Plan 28++++ Gorev B: e-arsiv internet_sale override (ctx'ten).
            // {payment_type, payment_platform, url, payment_date} alanlari kismi/tam set edilebilir.
            internetSale,
        } = payload;

        if (!contactId) throw new InvoiceProviderError('contactId required', { code: 'INVOICE_NO_CONTACT' });
        if (!Array.isArray(items) || items.length === 0) {
            throw new InvoiceProviderError('items required', { code: 'INVOICE_NO_ITEMS' });
        }

        // Parasut JSON:API beklentisi: details_inline (id YOK, included YOK, dogrudan
        // relationships.details.data icine gomulu). 404 "Record was not found:
        // SalesInvoiceDetail" hatasi temp-X id'leri yuzunden olusuyordu.
        const details = items.map((it) => ({
            type: 'sales_invoice_details',
            attributes: {
                quantity: it.quantity,
                unit_price: it.unitPrice,
                vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 20,
                description: it.description || it.name || '',
            },
            relationships: {
                product: { data: { type: 'products', id: String(it.productId) } },
            },
        }));

        const body = {
            data: {
                type: 'sales_invoices',
                attributes: {
                    item_type: 'invoice',
                    description: description || '',
                    issue_date: issueDate || new Date().toISOString().slice(0, 10),
                    invoice_series: invoiceSeries || 'A',
                    currency,
                    shipment_included: shipmentIncluded,
                },
                relationships: {
                    contact: { data: { type: 'contacts', id: String(contactId) } },
                    details: { data: details },
                },
            },
        };

        const created = await this._post(token, '/sales_invoices?include=active_e_document', body);
        if (!created || !created.data || !created.data.id) {
            throw new InvoiceProviderError('Invoice create returned no id', { code: 'INVOICE_CREATE_NO_ID' });
        }

        const result = {
            providerInvoiceId: String(created.data.id),
            invoiceNumber: created.data.attributes && created.data.attributes.invoice_no,
            pdfUrl: this._extractPdfUrl(created),
            eArchiveId: null,
        };

        if (documentType === 'e_archive') {
            // Plan 28++++ Gorev B: internet_sale ctx override (default values geriye uyumlu).
            const is = internetSale || {};
            const earchive = await this._post(token, '/e_archives', {
                data: {
                    type: 'e_archives',
                    attributes: {
                        vat_withholding_code: '',
                        internet_sale: {
                            url: is.url || '',
                            payment_type: is.payment_type || 'KREDIKARTI/BANKAKARTI',
                            payment_platform: is.payment_platform || 'SISTEM',
                            payment_date: is.payment_date || issueDate,
                        },
                    },
                    relationships: {
                        sales_invoice: { data: { type: 'sales_invoices', id: created.data.id } },
                    },
                },
            });
            // 2026-07-29 DUZELTME — resmi doku (swagger.yaml:377): e-Fatura/e-Arsiv/e-Smm
            // olusturma SENKRON DEGILDIR. POST /e_archives yaniti 201 "Trackable Job"
            // olup donen id bir ISLEM TAKIP numarasidir, e-arsiv belgesinin id'si DEGIL.
            // Eski kod bu id'yi eArchiveId sanip Firestore'a yaziyordu:
            //   - id 15 dakika sonra olu; belgeye erisim icin kullanilamaz
            //   - is "error" ile bitse bile biz "sent" yaziyorduk (sessiz basarisizlik)
            // Dogru akis: isi bekle -> sonra sales_invoice'i ?include=active_e_document
            // ile cekip GERCEK e-belge id'sini al (resmi doku 3. adim).
            const respType = earchive && earchive.data && earchive.data.type;
            const respId = earchive && earchive.data && earchive.data.id;

            if (respId && respType === 'trackable_jobs') {
                result.eArchiveJobId = String(respId);
                await this.waitForTrackableJob(token, respId);
                const resolved = await this._resolveActiveEDocument(token, created.data.id);
                if (resolved) {
                    result.eArchiveId = resolved.id;
                    result.eDocType = resolved.type;
                    if (resolved.pdfUrl) result.pdfUrl = resolved.pdfUrl;
                }
            } else if (respId) {
                // Savunma dali: bazi ortamlar/mock'lar dogrudan e_archives kaynagi donuyor.
                // Gercek Parasut API'sinde bu dal beklenmiyor.
                result.eArchiveId = String(respId);
            }
        }

        return result;
    }

    /**
     * Trackable job'i sonuclanana kadar sorgular (resmi doku: swagger.yaml:377).
     * Statuler: pending | running | error | done
     * NOT: swagger'in TrackableJobAttributes enum'unda 'pending' EKSIK, ama duz metin
     * aciklamasinda var — ikisi de bekleme durumu sayilir.
     * Job id'sinin omru 15 dk; varsayilan timeout bunun cok altinda tutuldu.
     */
    async waitForTrackableJob(token, jobId, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
        if (!jobId) throw new InvoiceProviderError('jobId required', { code: 'TRACKABLE_JOB_NO_ID' });
        const deadline = Date.now() + timeoutMs;

        for (;;) {
            const res = await this._get(token, `/trackable_jobs/${jobId}`);
            const attrs = (res && res.data && res.data.attributes) || {};
            const status = String(attrs.status || '').toLowerCase();

            if (status === 'done') {
                return { status, errors: [] };
            }
            if (status === 'error') {
                const errors = Array.isArray(attrs.errors) ? attrs.errors : [];
                throw new InvoiceProviderError(
                    `Parasut e-document job failed: ${errors.join('; ') || 'unknown error'}`,
                    { code: 'EDOC_JOB_FAILED', retryable: false, providerPayload: res }
                );
            }
            // pending | running | bilinmeyen -> beklemeye devam
            if (Date.now() + intervalMs > deadline) {
                throw new InvoiceProviderError(`Parasut e-document job still "${status || 'unknown'}" after ${timeoutMs}ms`, {
                    code: 'EDOC_JOB_TIMEOUT',
                    retryable: true,
                    providerPayload: res,
                });
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }

    /**
     * Resmi doku 3. adim: e-belge olustuktan sonra gercek id'yi almak icin
     * sales_invoice'i ?include=active_e_document ile cek.
     */
    async _resolveActiveEDocument(token, salesInvoiceId) {
        const fresh = await this._get(token, `/sales_invoices/${salesInvoiceId}?include=active_e_document`);
        if (!fresh || !Array.isArray(fresh.included)) return null;
        const eDoc = fresh.included.find((x) => x.type === 'e_archives' || x.type === 'e_invoices');
        if (!eDoc) return null;
        return {
            id: String(eDoc.id),
            type: eDoc.type === 'e_invoices' ? 'e_invoice' : 'e_archive',
            pdfUrl: this._extractPdfUrl(fresh),
        };
    }

    /**
     * Plan 28+ — sadece taslak sales_invoice yaratir (e-belge YOK).
     * Donus: { providerInvoiceId, invoiceNumber, pdfUrl }
     * Yetkili sonra updateDraftInvoice ile duzeltir, finalizeInvoice ile resmilestirir.
     */
    async createDraftInvoice(token, payload) {
        const {
            contactId,
            items,
            currency = 'TRL',
            issueDate,
            invoiceSeries,
            description,
            shipmentIncluded = false,
            orderNo,
            orderDate,
        } = payload;

        if (!contactId) throw new InvoiceProviderError('contactId required', { code: 'INVOICE_NO_CONTACT' });
        if (!Array.isArray(items) || items.length === 0) {
            throw new InvoiceProviderError('items required', { code: 'INVOICE_NO_ITEMS' });
        }

        const details = items.map((it) => ({
            type: 'sales_invoice_details',
            attributes: {
                quantity: it.quantity,
                unit_price: it.unitPrice,
                vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 20,
                description: it.description || it.name || '',
            },
            relationships: {
                product: { data: { type: 'products', id: String(it.productId) } },
            },
        }));

        const attributes = {
            item_type: 'invoice',
            description: description || '',
            issue_date: issueDate || new Date().toISOString().slice(0, 10),
            invoice_series: invoiceSeries || 'A',
            currency,
            shipment_included: shipmentIncluded,
        };
        if (orderNo) attributes.order_no = orderNo;
        if (orderDate) attributes.order_date = orderDate;

        const body = {
            data: {
                type: 'sales_invoices',
                attributes,
                relationships: {
                    contact: { data: { type: 'contacts', id: String(contactId) } },
                    details: { data: details },
                },
            },
        };

        const created = await this._post(token, '/sales_invoices', body);
        if (!created || !created.data || !created.data.id) {
            throw new InvoiceProviderError('Draft invoice create returned no id', { code: 'INVOICE_CREATE_NO_ID' });
        }

        return {
            providerInvoiceId: String(created.data.id),
            invoiceNumber: created.data.attributes && created.data.attributes.invoice_no,
            pdfUrl: this._extractSalesInvoicePdfUrl(created),
        };
    }

    /**
     * Plan 28+ — taslak sales_invoice icindeki kalemleri/aciklamayi guncelle.
     * Sadece taslak (resmilesmemis) belgelerde calisir; e-fatura/e-arsiv olmus
     * belgelerde Parasut PUT'u reddeder, cancel + recreate gerek.
     *
     * Bu impl PATCH semantik degil, full replace: tum kalemleri yeniden yazar.
     */
    async updateDraftInvoice(token, providerInvoiceId, payload) {
        const {
            items,
            description,
            shipmentIncluded,
            issueDate,
        } = payload;

        const attributes = {};
        if (description != null) attributes.description = description;
        if (shipmentIncluded != null) attributes.shipment_included = !!shipmentIncluded;
        if (issueDate) attributes.issue_date = issueDate;

        const body = {
            data: {
                id: String(providerInvoiceId),
                type: 'sales_invoices',
                attributes,
            },
        };

        if (Array.isArray(items)) {
            const details = items.map((it) => ({
                type: 'sales_invoice_details',
                attributes: {
                    quantity: it.quantity,
                    unit_price: it.unitPrice,
                    vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 20,
                    description: it.description || it.name || '',
                },
                relationships: {
                    product: { data: { type: 'products', id: String(it.productId) } },
                },
            }));
            body.data.relationships = {
                details: { data: details },
            };
        }

        const updated = await this._put(token, `/sales_invoices/${providerInvoiceId}`, body);
        if (!updated || !updated.data || !updated.data.id) {
            throw new InvoiceProviderError('Draft invoice update returned no id', { code: 'INVOICE_UPDATE_NO_ID' });
        }
        return {
            providerInvoiceId: String(updated.data.id),
            invoiceNumber: updated.data.attributes && updated.data.attributes.invoice_no,
            pdfUrl: this._extractSalesInvoicePdfUrl(updated),
        };
    }

    /**
     * Plan 28+ — taslak sales_invoice'i resmi e-fatura veya e-arsiv'e cevirir.
     * Parasut /sales_invoices/{id}/convert_to_invoice endpoint'i.
     * VKN durumuna gore Parasut otomatik e_invoice (B2B) veya e_archive (B2C) secer.
     *
     * @param {string} providerInvoiceId taslak sales_invoice ID
     * @param {object} [opts]
     * @param {string} [opts.documentType] 'e_invoice' | 'e_archive' (Yemigo'nun zorlamak istedigi tip)
     * @param {object} [opts.eInvoiceAttrs] e-fatura icin GİB attribute'lari (scenario, to_phase)
     * @param {object} [opts.eArchiveAttrs] e-arsiv icin attribute'lar (vat_withholding_code, internet_sale)
     * @returns {Promise<{providerInvoiceId, eDocId, eDocType, pdfUrl, invoiceNumber}>}
     */
    async finalizeInvoice(token, providerInvoiceId, opts = {}) {
        const { documentType, eInvoiceAttrs = {}, eArchiveAttrs = {} } = opts;
        const body = {
            data: {
                type: 'sales_invoices',
                attributes: {},
            },
        };
        if (documentType === 'e_invoice') {
            body.data.attributes.scenario = eInvoiceAttrs.scenario || 'temel_fatura';
            body.data.attributes.to_phase = eInvoiceAttrs.to_phase || null;
            if (eInvoiceAttrs.invoice_note) body.data.attributes.invoice_note = eInvoiceAttrs.invoice_note;
        } else if (documentType === 'e_archive') {
            const internetSale = eArchiveAttrs.internet_sale || {};
            body.data.attributes.vat_withholding_code = eArchiveAttrs.vat_withholding_code || '';
            body.data.attributes.internet_sale = {
                url: internetSale.url || '',
                payment_type: internetSale.payment_type || 'KREDIKARTI/BANKAKARTI',
                payment_platform: internetSale.payment_platform || 'SISTEM',
                payment_date: internetSale.payment_date || new Date().toISOString().slice(0, 10),
            };
        }

        const result = await this._post(token, `/sales_invoices/${providerInvoiceId}/convert_to_invoice`, body);
        if (!result || !result.data || !result.data.id) {
            throw new InvoiceProviderError('Finalize returned no id', { code: 'FINALIZE_NO_ID' });
        }

        // Resmi belge ID'yi cek
        const fresh = await this._get(token, `/sales_invoices/${providerInvoiceId}?include=active_e_document`);
        let eDocId = null;
        let eDocType = null;
        if (fresh && Array.isArray(fresh.included)) {
            const eDoc = fresh.included.find((x) => x.type === 'e_archives' || x.type === 'e_invoices');
            if (eDoc) {
                eDocId = String(eDoc.id);
                eDocType = eDoc.type === 'e_invoices' ? 'e_invoice' : 'e_archive';
            }
        }

        return {
            providerInvoiceId: String(result.data.id),
            eDocId,
            eDocType,
            pdfUrl: this._extractPdfUrl(fresh) || this._extractSalesInvoicePdfUrl(fresh),
            invoiceNumber: result.data.attributes && result.data.attributes.invoice_no,
        };
    }

    /**
     * Plan 28+ — Aliciyi e-fatura mukellefi mi diye sorgular.
     * VKN/TCKN bazli e-fatura inbox arar; bulunursa B2B (e_invoice), bulunmazsa B2C (e_archive).
     *
     * @returns {Promise<{registered: boolean, alias?: string, type?: string}>}
     */
    async checkVknInbox(token, vkn) {
        if (!vkn) return { registered: false };
        try {
            const data = await this._get(token, `/e_invoice_inboxes?filter[vkn]=${encodeURIComponent(vkn)}`);
            const items = (data && Array.isArray(data.data)) ? data.data : [];
            if (items.length === 0) return { registered: false };
            const first = items[0];
            const a = first.attributes || {};
            // 2026-09-06: admin "Yeni Firma" sihirbazı resmî unvanı ve kayıt tarihini de kullanır
            // (Paraşüt e_invoice_inboxes attributes: vkn, name, e_invoice_address, inbox_type,
            // address_registered_at, registered_at). Eski alanlar (alias/type) korunur.
            return {
                registered: true,
                alias: a.e_invoice_address || a.email_address || a.alias || null,
                type: a.inbox_type || a.address_type || null,
                name: a.name || null,
                registeredAt: a.registered_at || a.address_registered_at || null,
            };
        } catch (_e) {
            // ApprovalProcessor `!!inbox.registered` bakar; `error` yalnız taxpayer ucu için.
            return { registered: false, error: true, message: _e && _e.message ? _e.message : 'lookup_failed' };
        }
    }

    async getDocument(token, providerInvoiceId) {
        const data = await this._get(token, `/sales_invoices/${providerInvoiceId}?include=active_e_document`);
        if (!data || !data.data) {
            throw new InvoiceProviderError('Document not found', { code: 'DOC_NOT_FOUND', status: 404 });
        }
        return {
            status: data.data.attributes && data.data.attributes.payment_status,
            pdfUrl: this._extractPdfUrl(data),
            xmlUrl: null,
        };
    }

    async cancelDocument(token, providerInvoiceId, _reason) {
        try {
            await this._delete(token, `/sales_invoices/${providerInvoiceId}`);
            return { ok: true };
        } catch (err) {
            throw this._wrap(err, 'CANCEL_FAILED');
        }
    }

    // -------------------- SHIPMENT DOCUMENT (Plan 28++) --------------------

    /**
     * Plan 28++ — Sevk irsaliyesi (e-İrsaliye'nin Paraşüt karşılığı) yarat.
     * Fatura'dan farklı: GİB'e gönderilen e-İrsaliye QR kodlu PDF olur,
     * sürücü malla birlikte götürür. Mali değer içermez (KDV hesaplaması fatura tarafında).
     *
     * Paraşüt JSON:API: data.relationships.stock_movements.data[] zorunlu — her stok hareketi
     * bir ürün satırını + miktar + fiyat'ı temsil eder. include=stock_movements ile resmi
     * hareketler döner.
     *
     * @param {object} payload
     * @param {string} payload.contactId  Alıcı (şube) Paraşüt contact ID
     * @param {Array}  payload.items      [{ productId, quantity, unitPrice, vatRate, name }]
     * @param {string} [payload.issueDate]       İrsaliye düzenleme tarihi (default: bugün)
     * @param {string} [payload.shipmentDate]    Fiili sevk tarihi-saati (ISO 8601)
     * @param {string} [payload.procurementNumber] İrsaliye numarası (opsiyonel; verilmezse Paraşüt otomatik)
     * @param {string} [payload.description]     İrsaliye açıklaması
     * @param {string} [payload.address]         Sevk adresi
     * @param {string} [payload.city]
     * @param {string} [payload.district]
     * @param {boolean} [payload.inflow]         false=satış (giden), true=alış (gelen). Default: false
     * @returns {Promise<{providerShipmentId, shipmentNumber, pdfUrl, qrUrl, eDocStatus}>}
     */
    async createShipmentDocument(token, payload) {
        const {
            contactId,
            items,
            issueDate,
            shipmentDate,
            procurementNumber,
            description,
            address,
            city,
            district,
            inflow = false,
        } = payload;

        if (!contactId) throw new InvoiceProviderError('contactId required', { code: 'SHIPMENT_NO_CONTACT' });
        if (!Array.isArray(items) || items.length === 0) {
            throw new InvoiceProviderError('items required', { code: 'SHIPMENT_NO_ITEMS' });
        }

        // Paraşüt: stock_movements relationship'i ile ürün satırları gömülü olarak gönderilir.
        // sales_invoice_details ile aynı pattern: id YOK, included YOK, doğrudan inline.
        const stockMovements = items.map((it) => ({
            type: 'stock_movements',
            attributes: {
                quantity: Number(it.quantity),
                unit_price: Number(it.unitPrice || 0),
                vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 0,
                description: it.description || it.name || '',
            },
            relationships: {
                product: { data: { type: 'products', id: String(it.productId) } },
            },
        }));

        const attributes = {
            issue_date: issueDate || new Date().toISOString().slice(0, 10),
            inflow: !!inflow,
        };
        if (description) attributes.description = description;
        if (address) attributes.address = address;
        if (city) attributes.city = city;
        if (district) attributes.district = district;
        if (shipmentDate) attributes.shipment_date = shipmentDate;
        if (procurementNumber) attributes.procurement_number = procurementNumber;

        const body = {
            data: {
                type: 'shipment_documents',
                attributes,
                relationships: {
                    contact: { data: { type: 'contacts', id: String(contactId) } },
                    stock_movements: { data: stockMovements },
                },
            },
        };

        const created = await this._post(token, '/shipment_documents?include=stock_movements', body);
        if (!created || !created.data || !created.data.id) {
            throw new InvoiceProviderError('Shipment document create returned no id', { code: 'SHIPMENT_CREATE_NO_ID' });
        }

        const shipmentId = String(created.data.id);
        return {
            providerShipmentId: shipmentId,
            shipmentNumber: created.data.attributes && (created.data.attributes.procurement_number || created.data.attributes.invoice_no),
            // Plan 28++ — kullanici browser'da acabilsin diye Parasut panel URL'i dondur.
            // Eski 'api.parasut.com/.../print' API endpoint'iydi, browser'dan 401 verirdi.
            pdfUrl: this._buildPanelShipmentUrl(shipmentId),
            apiPrintUrl: this._extractShipmentPdfUrl(created),
            issueDate: created.data.attributes && created.data.attributes.issue_date,
            shipmentDate: created.data.attributes && created.data.attributes.shipment_date,
        };
    }

    /**
     * Plan 28++ — taslak e-İrsaliye'yi güncelle (kalemler, açıklama, adres, sevk tarihi).
     * Paraşüt resmilemiş irsaliyeyi reddeder; sadece taslak (henüz GİB'e gönderilmemiş) çalışır.
     */
    async updateShipmentDocument(token, providerShipmentId, payload) {
        const {
            items,
            description,
            address,
            city,
            district,
            shipmentDate,
            issueDate,
            procurementNumber,
        } = payload;

        const attributes = {};
        if (description != null) attributes.description = description;
        if (address != null) attributes.address = address;
        if (city != null) attributes.city = city;
        if (district != null) attributes.district = district;
        if (shipmentDate != null) attributes.shipment_date = shipmentDate;
        if (issueDate != null) attributes.issue_date = issueDate;
        if (procurementNumber != null) attributes.procurement_number = procurementNumber;

        const body = {
            data: {
                id: String(providerShipmentId),
                type: 'shipment_documents',
                attributes,
            },
        };

        if (Array.isArray(items)) {
            const stockMovements = items.map((it) => ({
                type: 'stock_movements',
                attributes: {
                    quantity: Number(it.quantity),
                    unit_price: Number(it.unitPrice || 0),
                    vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 0,
                    description: it.description || it.name || '',
                },
                relationships: {
                    product: { data: { type: 'products', id: String(it.productId) } },
                },
            }));
            body.data.relationships = {
                stock_movements: { data: stockMovements },
            };
        }

        const updated = await this._put(token, `/shipment_documents/${providerShipmentId}`, body);
        if (!updated || !updated.data || !updated.data.id) {
            throw new InvoiceProviderError('Shipment document update returned no id', { code: 'SHIPMENT_UPDATE_NO_ID' });
        }
        return {
            providerShipmentId: String(updated.data.id),
            shipmentNumber: updated.data.attributes && (updated.data.attributes.procurement_number || updated.data.attributes.invoice_no),
            pdfUrl: this._extractShipmentPdfUrl(updated),
        };
    }

    /**
     * Plan 28++ — Şu anki Paraşüt API'si "convert_to_e_shipment" gibi resmilestirme
     * endpoint'i sunmuyor. Resmî e-İrsaliye süreci Paraşüt panelinden manuel veya
     * Paraşüt'ün kendi otomasyonu ile tetikleniyor. Bu metod taslak irsaliyeyi
     * yeniden çekip pdf+QR url'ini döner.
     */
    async getShipmentDocument(token, providerShipmentId) {
        const data = await this._get(token, `/shipment_documents/${providerShipmentId}?include=stock_movements,contact`);
        if (!data || !data.data) {
            throw new InvoiceProviderError('Shipment document not found', { code: 'SHIPMENT_NOT_FOUND', status: 404 });
        }
        return {
            providerShipmentId: String(data.data.id),
            shipmentNumber: data.data.attributes && (data.data.attributes.procurement_number || data.data.attributes.invoice_no),
            pdfUrl: this._extractShipmentPdfUrl(data),
            issueDate: data.data.attributes && data.data.attributes.issue_date,
            shipmentDate: data.data.attributes && data.data.attributes.shipment_date,
            archived: data.data.attributes && data.data.attributes.archived,
        };
    }

    async deleteShipmentDocument(token, providerShipmentId) {
        try {
            await this._delete(token, `/shipment_documents/${providerShipmentId}`);
            return { ok: true };
        } catch (err) {
            // _delete zaten InvoiceProviderError ile sarmalamış; status'u koruyup code'u shipment-spesifik yap.
            if (err && err.name === 'InvoiceProviderError') {
                err.code = 'SHIPMENT_DELETE_FAILED';
                throw err;
            }
            throw this._wrap(err, 'SHIPMENT_DELETE_FAILED');
        }
    }

    // -------------------- HELPERS --------------------

    _basePath(suffix) {
        const s = suffix.startsWith('/') ? suffix : '/' + suffix;
        return `/v4/${this.companyId}${s}`;
    }

    /**
     * Listele 'person' tipindeki contact'lari (Yemigo'da bunlar surucu olarak kullanilir).
     * Paraşüt'te merkezi sürücü/carrier CRUD yok; person contacts kullanılır.
     *
     * NOT: Paraşüt API'sinde `filter[contact_type]` parametresi YOK (swagger:2304).
     * Tüm contact'lar çekilir, client-side `attributes.contact_type === 'person'` filtresi.
     *
     * @returns {Promise<Array<{id, name, taxNumber, phone, email, archived}>>}
     */
    async listPersonContacts(token, { limit = 200 } = {}) {
        const out = [];
        let page = 1;
        // Paraşüt page[size] max 25 (swagger:2304)
        const maxPages = Math.ceil(limit / 25);
        while (page <= maxPages) {
            const suffix = `/contacts?page[number]=${page}&page[size]=25&sort=name`;
            const data = await this._get(token, suffix);
            const items = Array.isArray(data?.data) ? data.data : [];
            if (items.length === 0) break;
            for (const it of items) {
                const a = it.attributes || {};
                // Client-side filter: yalniz 'person' tipindekiler
                if (a.contact_type !== 'person') continue;
                out.push({
                    id: it.id,
                    name: a.name || '',
                    taxNumber: a.tax_number || '',
                    phone: a.phone || '',
                    email: a.email || '',
                    city: a.city || '',
                    district: a.district || '',
                    address: a.address || '',
                    archived: a.archived === true,
                });
            }
            if (items.length < 25) break;
            page += 1;
        }
        return out;
    }

    async _get(token, suffix) {
        await this._acquireSlot();
        const url = `${this.baseUrl}${this._basePath(suffix)}`;
        try {
            const { data } = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                timeout: this.timeoutMs,
            });
            return data;
        } catch (err) {
            throw this._wrap(err, 'GET_FAILED');
        }
    }

    async _post(token, suffix, body) {
        await this._acquireSlot();
        const url = `${this.baseUrl}${this._basePath(suffix)}`;
        try {
            const { data } = await axios.post(url, body, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                timeout: this.timeoutMs,
            });
            return data;
        } catch (err) {
            throw this._wrap(err, 'POST_FAILED');
        }
    }

    async _put(token, suffix, body) {
        await this._acquireSlot();
        const url = `${this.baseUrl}${this._basePath(suffix)}`;
        try {
            const { data } = await axios.put(url, body, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                timeout: this.timeoutMs,
            });
            return data;
        } catch (err) {
            throw this._wrap(err, 'PUT_FAILED');
        }
    }

    async _delete(token, suffix) {
        await this._acquireSlot();
        const url = `${this.baseUrl}${this._basePath(suffix)}`;
        try {
            const { data } = await axios.delete(url, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: this.timeoutMs,
            });
            return data;
        } catch (err) {
            throw this._wrap(err, 'DELETE_FAILED');
        }
    }

    _extractPdfUrl(response) {
        if (!response || !response.included) return null;
        const eDoc = response.included.find((x) => x.type === 'e_archives' || x.type === 'e_invoices');
        if (eDoc && eDoc.attributes) {
            return eDoc.attributes.printable_html_url || eDoc.attributes.url || null;
        }
        return null;
    }

    /**
     * Plan 28+ — Taslak sales_invoice PDF link'i (henuz e-belge olmadan).
     * Parasut sales_invoice attribute'larinda preview/printable url donulebilir;
     * yoksa null doner ve panel/WPF kendi taraflarinda PDF olusturmak zorunda.
     */
    _extractSalesInvoicePdfUrl(response) {
        if (!response || !response.data || !response.data.attributes) return null;
        const a = response.data.attributes;
        return a.printable_html_url || a.preview_url || a.print_url || null;
    }

    /**
     * Plan 28++ — Shipment document PDF/QR url'i. Paraşüt response attributes'unda
     * printable_html_url benzeri alan dönerse onu kullanır; yoksa null.
     * Sürücüye basılan QR kodlu PDF bu URL'den indirilir.
     * NOT: Bu URL 'api.parasut.com/...' formatinda olur ve Bearer token gerektirir.
     * Kullanici browser'i icin _buildPanelShipmentUrl tercih edilir.
     */
    _extractShipmentPdfUrl(response) {
        if (!response || !response.data || !response.data.attributes) return null;
        const a = response.data.attributes;
        return a.printable_html_url || a.preview_url || a.print_url || null;
    }

    /**
     * Plan 28++ — Parasut'un kendi web panel URL'i (uygulama.parasut.com).
     * Kullanici hesabina login oldugu icin browser direkt acabilir;
     * orada 'Onayla / GIB'e Gonder' butonu da gorunur.
     */
    _buildPanelShipmentUrl(shipmentId) {
        return `https://uygulama.parasut.com/${this.companyId}/sales/shipment_documents/${shipmentId}`;
    }

    _wrap(err, code) {
        const status = err.response && err.response.status;
        const payload = err.response && err.response.data;
        const retryable = !status || status === 408 || status === 429 || (status >= 500 && status < 600);
        const msg = (payload && (payload.message || payload.error_description || payload.error)) || err.message;
        // Plan 28+ debug: hata URL'sini ve metodunu paylas, bilinmeyen 404'leri tesh icin
        const reqUrl = err.config && err.config.url;
        const reqMethod = err.config && err.config.method;
        return new InvoiceProviderError(msg, { code, status, retryable, providerPayload: payload, reqUrl, reqMethod });
    }
}

module.exports = ParasutProvider;
