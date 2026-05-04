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
        try {
            const data = await this._get(token, '/me');
            return { ok: true, company: data && data.data ? data.data.attributes || {} : {} };
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
                    tax_number: taxNo || '',
                    tax_office: branch.taxOffice || '',
                    contact_type: 'company',
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

        const detailsAttributes = items.map((it) => ({
            quantity: it.quantity,
            unit_price: it.unitPrice,
            vat_rate: typeof it.vatRate === 'number' ? it.vatRate : 20,
            description: it.description || it.name || '',
        }));
        const detailsRelationship = items.map((it, i) => ({
            type: 'sales_invoice_details',
            id: `temp-${i}`,
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
                    details: { data: detailsRelationship.map((d) => ({ type: d.type, id: d.id })) },
                },
            },
            included: detailsRelationship,
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

    _wrap(err, code) {
        const status = err.response && err.response.status;
        const payload = err.response && err.response.data;
        const retryable = !status || status === 408 || status === 429 || (status >= 500 && status < 600);
        const msg = (payload && (payload.message || payload.error_description || payload.error)) || err.message;
        return new InvoiceProviderError(msg, { code, status, retryable, providerPayload: payload });
    }
}

module.exports = ParasutProvider;
