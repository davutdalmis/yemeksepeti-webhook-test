// ==================================================================================
// IInvoiceProvider — provider abstraction (JSDoc tipli pseudo-interface)
// ==================================================================================
// JS'te runtime interface yok; her concrete provider asagidaki metotlari export eder.
// Plan 27 1.2 — Parasut, Mock; ileride Logo/Mikro/Foriba.
// ==================================================================================

/**
 * @typedef {Object} IInvoiceProvider
 *
 * @property {() => Promise<{ accessToken: string, expiresIn: number, refreshToken?: string }>} authenticate
 *   OAuth2 password grant ile token al. TokenManager bunu cache'ler.
 *
 * @property {(refreshToken: string) => Promise<{ accessToken: string, expiresIn: number, refreshToken?: string }>} [refresh]
 *   Refresh token ile yeni access token al. Yoksa TokenManager re-auth'a duser.
 *
 * @property {(token: string) => Promise<{ ok: true, company: object } | { ok: false, error: string }>} ping
 *   Saglik testi (Parasut: GET /v4/{company_id}/me).
 *
 * @property {(token: string, branch: object) => Promise<{ contactId: string, created: boolean }>} upsertContact
 *   Sube -> Cari Hesap eslemesi. Vergi no ile arama, yoksa yeni olustur.
 *
 * @property {(token: string, product: object) => Promise<{ productId: string, created: boolean }>} upsertProduct
 *   Urun -> Parasut Product eslemesi. Ad ile arama, yoksa yeni olustur.
 *
 * @property {(token: string, payload: object) => Promise<{ providerInvoiceId: string, invoiceNumber?: string, pdfUrl?: string, eArchiveId?: string }>} createInvoice
 *   Fatura kes. payload = { contactId, items, vatRate, currency, issueDate, shipmentIncluded, documentType }.
 *
 * @property {(token: string, providerInvoiceId: string) => Promise<{ status: string, pdfUrl?: string, xmlUrl?: string }>} getDocument
 *   Belge durumu/PDF URL sorgu.
 *
 * @property {(token: string, providerInvoiceId: string, reason?: string) => Promise<{ ok: boolean }>} cancelDocument
 *   Belge iptal (veya credit note + delete).
 */

class InvoiceProviderError extends Error {
    constructor(message, { code, status, retryable, providerPayload, reqUrl, reqMethod } = {}) {
        super(message);
        this.name = 'InvoiceProviderError';
        this.code = code || 'PROVIDER_ERROR';
        this.status = status || null;
        this.retryable = !!retryable;
        this.providerPayload = providerPayload || null;
        this.reqUrl = reqUrl || null;
        this.reqMethod = reqMethod || null;
    }
}

module.exports = { InvoiceProviderError };
