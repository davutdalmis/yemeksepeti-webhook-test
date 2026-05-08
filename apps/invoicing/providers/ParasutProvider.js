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
        if (taxNo) {
            const found = await this._get(token, `/contacts?filter[tax_number]=${encodeURIComponent(taxNo)}&page[size]=1`);
            if (found && Array.isArray(found.data) && found.data.length > 0) {
                return { contactId: String(found.data[0].id), created: false };
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
        return { contactId: String(created.data.id), created: true };
    }

    // -------------------- PRODUCT --------------------

    async upsertProduct(token, product) {
        const name = product.name || product.productName;
        if (!name) throw new InvoiceProviderError('Product name required', { code: 'PRODUCT_NO_NAME' });

        const found = await this._get(token, `/products?filter[name]=${encodeURIComponent(name)}&page[size]=1`);
        if (found && Array.isArray(found.data) && found.data.length > 0) {
            return { productId: String(found.data[0].id), created: false };
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
        return { productId: String(created.data.id), created: true };
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
            const earchive = await this._post(token, '/e_archives', {
                data: {
                    type: 'e_archives',
                    attributes: { vat_withholding_code: '', internet_sale: { url: '', payment_type: 'KREDIKARTI/BANKAKARTI', payment_platform: 'SISTEM', payment_date: issueDate } },
                    relationships: {
                        sales_invoice: { data: { type: 'sales_invoices', id: created.data.id } },
                    },
                },
            });
            if (earchive && earchive.data && earchive.data.id) {
                result.eArchiveId = String(earchive.data.id);
            }
        }

        return result;
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
            return {
                registered: true,
                alias: first.attributes && (first.attributes.email_address || first.attributes.alias),
                type: first.attributes && first.attributes.address_type,
            };
        } catch (_e) {
            return { registered: false };
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

    // -------------------- HELPERS --------------------

    _basePath(suffix) {
        const s = suffix.startsWith('/') ? suffix : '/' + suffix;
        return `/v4/${this.companyId}${s}`;
    }

    async _get(token, suffix) {
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
