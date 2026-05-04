// ==================================================================================
// MockInvoiceProvider — IInvoiceProvider impl for tests + local dev
// ==================================================================================
// Tum metotlar canned cevap verir, call counter tutar.
// Test'te: const m = new MockInvoiceProvider(); ... expect(m.calls.createInvoice).toBe(1);
// ==================================================================================

const { InvoiceProviderError } = require('./IInvoiceProvider');

class MockInvoiceProvider {
    constructor(opts = {}) {
        this.providerName = 'mock';
        this.companyId = opts.companyId || 'mock-company';
        this.calls = {
            authenticate: 0,
            refresh: 0,
            ping: 0,
            upsertContact: 0,
            upsertProduct: 0,
            createInvoice: 0,
            getDocument: 0,
            cancelDocument: 0,
        };
        this.responses = Object.assign({
            authenticate: { accessToken: 'mock-access-token', expiresIn: 7200, refreshToken: 'mock-refresh' },
            refresh: { accessToken: 'mock-refresh-access', expiresIn: 7200, refreshToken: 'mock-refresh-2' },
            ping: { ok: true, company: { name: 'Mock Restaurant' } },
        }, opts.responses || {});
        this.failNext = null;
        this.contactCounter = 0;
        this.productCounter = 0;
        this.invoiceCounter = 0;
        this.documents = new Map();
    }

    _maybeFail() {
        if (this.failNext) {
            const err = this.failNext;
            this.failNext = null;
            if (err instanceof Error) throw err;
            throw new InvoiceProviderError(err.message || 'mock failure', err);
        }
    }

    async authenticate() {
        this.calls.authenticate++;
        this._maybeFail();
        return { ...this.responses.authenticate };
    }

    async refresh(_refreshToken) {
        this.calls.refresh++;
        this._maybeFail();
        return { ...this.responses.refresh };
    }

    async ping(_token) {
        this.calls.ping++;
        this._maybeFail();
        return { ...this.responses.ping };
    }

    async upsertContact(_token, branch) {
        this.calls.upsertContact++;
        this._maybeFail();
        const taxNo = branch.taxNumber || branch.vatNumber;
        const id = `mock-contact-${taxNo || ++this.contactCounter}`;
        return { contactId: id, created: true };
    }

    async upsertProduct(_token, product) {
        this.calls.upsertProduct++;
        this._maybeFail();
        const id = `mock-product-${product.id || product.sku || ++this.productCounter}`;
        return { contactId: id, productId: id, created: true };
    }

    async createInvoice(_token, payload) {
        this.calls.createInvoice++;
        this._maybeFail();
        const id = `mock-invoice-${++this.invoiceCounter}`;
        const result = {
            providerInvoiceId: id,
            invoiceNumber: `MOCK-${this.invoiceCounter.toString().padStart(6, '0')}`,
            pdfUrl: `https://mock.parasut.test/pdf/${id}.pdf`,
            eArchiveId: payload.documentType === 'e_archive' ? `mock-earchive-${this.invoiceCounter}` : null,
        };
        this.documents.set(id, { ...result, status: 'unpaid' });
        return result;
    }

    async getDocument(_token, providerInvoiceId) {
        this.calls.getDocument++;
        this._maybeFail();
        const doc = this.documents.get(providerInvoiceId);
        if (!doc) {
            throw new InvoiceProviderError('Document not found', { code: 'DOC_NOT_FOUND', status: 404 });
        }
        return { status: doc.status, pdfUrl: doc.pdfUrl, xmlUrl: null };
    }

    async cancelDocument(_token, providerInvoiceId, _reason) {
        this.calls.cancelDocument++;
        this._maybeFail();
        if (!this.documents.has(providerInvoiceId)) {
            throw new InvoiceProviderError('Document not found', { code: 'DOC_NOT_FOUND', status: 404 });
        }
        this.documents.delete(providerInvoiceId);
        return { ok: true };
    }
}

module.exports = MockInvoiceProvider;
