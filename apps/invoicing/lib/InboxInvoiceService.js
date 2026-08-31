// ==================================================================================
// InboxInvoiceService — gelen tedarikci e-faturasi: senkron -> sube onayi -> stok girisi
// ==================================================================================
// Akis (2026-08-03, sahip karari: onay ekrani PANEL WEB):
//   1) syncInbox        : Uyumsoft gelen kutusu -> incomingInvoices/{tenantId}__{invoiceId}
//                         (status 'new'; var olan dokuman ASLA ezilmez — onay durumu korunur)
//   2) loadInvoiceLines : UBL XML cek + parse et + dokumana yaz; kalemlere ogrenilmis
//                         tedarikci-urun eslesmesi (supplierProductMappings) onerisi ekle
//   3) approveInvoice   : TEK transaction icinde INVOICE_ENTRY stockMovements +
//                         branchStocks increment + status 'approved' (idempotent guard).
//                         Ticari faturaysa Uyumsoft'a Approve cevabi best-effort gider.
//   4) declineInvoice   : status 'declined'; ticari faturaysa Decline cevabi best-effort.
//
// Stok yazimi WPF StockEntryBuilder INVOICE_ENTRY sekliyle birebir uyumludur
// (movementType, invoiceInfo{invoiceNo,supplierName,invoiceDate}, pozitif quantity).
// branchStocks guncellemesi CanonicalStockWriter deseniyle aynidir (merge + currentStock).
//
// Idempotency: approve, transaction icindeki "status zaten approved ise cik" guard'i ile
// tek sefer calisir (cift tiklama / cift sekme guvenli).
// ==================================================================================

const { parseUblInvoice } = require('./UblInvoiceParser');

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Eslesme anahtari: tr kucuk harf + tek bosluk; dokuman id'sinde yasak karakterler temizlenir.
function mappingKeyPart(s) {
    return String(s || '')
        .toLocaleLowerCase('tr')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[\/#?%\[\]]/g, '_')
        .slice(0, 200);
}

class InboxInvoiceError extends Error {
    constructor(message, { code, status } = {}) {
        super(message);
        this.name = 'InboxInvoiceError';
        this.code = code || 'INBOX_ERROR';
        this.status = status || 500;
    }
}

class InboxInvoiceService {
    /**
     * @param {object} opts
     * @param {object} opts.db               Firestore admin db (veya test fake'i)
     * @param {object} opts.Timestamp        firebase-admin/firestore Timestamp (fromMillis kullanilir)
     * @param {(tenantId: string) => Promise<object>} opts.providerFactory  IInboxInvoiceProvider uretir
     * @param {() => number} [opts.now]
     * @param {object} [opts.logger]
     */
    constructor({ db, Timestamp, providerFactory, now, logger }) {
        if (!db) throw new Error('InboxInvoiceService: db required');
        if (!Timestamp) throw new Error('InboxInvoiceService: Timestamp required');
        if (!providerFactory) throw new Error('InboxInvoiceService: providerFactory required');
        this.db = db;
        this.Timestamp = Timestamp;
        this.providerFactory = providerFactory;
        this.now = now || (() => Date.now());
        this.logger = logger || console;
    }

    _docId(tenantId, invoiceId) {
        return `${tenantId}__${invoiceId}`;
    }

    _mappingDocId(tenantId, supplierVkn, line) {
        const key = mappingKeyPart(line.sellerCode) || mappingKeyPart(line.name);
        return `${tenantId}__${supplierVkn || 'vkn'}__${key || 'bilinmeyen'}`;
    }

    // -------------------- 1) SYNC --------------------

    /**
     * Gelen kutusunu incomingInvoices koleksiyonuna indirir.
     * Yalniz YENI dokumanlar yazilir; mevcut dokumanlarin status/onay alanlari korunur
     * (liste metadatasi degisken degil — fatura kesildikten sonra sabittir).
     */
    async syncInbox({ tenantId, createStartDate, createEndDate, pageSize = 50, maxPages = 10 }) {
        if (!tenantId) throw new InboxInvoiceError('tenantId required', { code: 'BAD_REQUEST', status: 400 });
        const provider = await this.providerFactory(tenantId);

        let created = 0;
        let skipped = 0;
        let fetched = 0;
        let totalCount = 0;
        let scanned = 0;
        let pagesRead = 0;
        let truncated = false;
        for (let page = 0; page < maxPages; page++) {
            const r = await provider.listInboxInvoices({
                createStartDate,
                createEndDate,
                pageIndex: page,
                pageSize,
            });
            totalCount = r.totalCount;
            pagesRead++;
            scanned += Number.isFinite(r.scannedOnPage) ? r.scannedOnPage : r.items.length;
            fetched += r.items.length;
            for (const item of r.items) {
                if (!item.invoiceId) continue;
                const ref = this.db.collection('incomingInvoices').doc(this._docId(tenantId, item.invoiceId));
                const snap = await ref.get();
                if (snap.exists) {
                    skipped++;
                    continue;
                }
                await ref.set({
                    id: this._docId(tenantId, item.invoiceId),
                    tenantId,
                    provider: provider.providerName || 'uyumsoft',
                    invoiceId: item.invoiceId,
                    documentId: item.documentId,
                    invoiceTipType: item.invoiceTipType || '',
                    supplierVkn: item.counterpartyVkn || '',
                    supplierTitle: item.counterpartyTitle || '',
                    payableAmount: item.payableAmount,
                    taxTotal: item.taxTotal,
                    taxExclusiveAmount: item.taxExclusiveAmount,
                    currency: item.currency,
                    invoiceCreateDateUtc: item.createDateUtc || '',
                    invoiceExecutionDate: item.executionDate || '',
                    status: 'new',
                    syncedAt: this.Timestamp.fromMillis(this.now()),
                });
                created++;
            }
            // Sayfalama karari SAGLAYICININDIR. Parasut'te yon filtresi olmadigi icin
            // bir API sayfasi tamamen GIDEN faturadan olusabilir; o sayfada items bos
            // gelir. "Bos sayfa = bitti" varsayimi kalan gelen faturalari kaybettirir.
            // Saglayici hasMore bildirmiyorsa (Uyumsoft) eski davranis birebir korunur.
            const more = typeof r.hasMore === 'boolean'
                ? r.hasMore
                : !((page + 1) * pageSize >= totalCount || r.items.length === 0);
            if (!more) break;
            if (page === maxPages - 1) truncated = true;
        }
        // truncated: maxPages tavanina carpildi, gelen kutusunda daha eski kayit VAR.
        return { ok: true, fetched, created, skipped, totalCount, scanned, pagesRead, truncated };
    }

    // -------------------- 2) DETAIL / LINES --------------------

    /**
     * UBL'i ceker, parse eder, dokumana yazar. Kalemlere ogrenilmis eslesme onerisi
     * (suggestedInventoryProductId / suggestedUnitMultiplier) eklenir.
     * Parse edilmis dokumanda tekrar cagrilirsa yeniden CEKMEZ (force ile zorlanir).
     */
    async loadInvoiceLines({ tenantId, invoiceId, force = false }) {
        if (!tenantId || !invoiceId) throw new InboxInvoiceError('tenantId+invoiceId required', { code: 'BAD_REQUEST', status: 400 });
        const ref = this.db.collection('incomingInvoices').doc(this._docId(tenantId, invoiceId));
        const snap = await ref.get();
        if (!snap.exists) throw new InboxInvoiceError('incoming invoice not found', { code: 'NOT_FOUND', status: 404 });
        const doc = snap.data();
        if (doc.tenantId !== tenantId) throw new InboxInvoiceError('cross-tenant erisim reddedildi', { code: 'FORBIDDEN', status: 403 });

        let parsed = doc.parsed;
        if (!parsed || force) {
            const provider = await this.providerFactory(tenantId);
            const { xml } = await provider.getInboxInvoiceXml(invoiceId);
            parsed = parseUblInvoice(xml);
            await ref.set({
                parsed,
                parsedAt: this.Timestamp.fromMillis(this.now()),
                // liste senkronu VKN'siz kalmis olabilir; UBL kesin kaynak
                supplierVkn: parsed.supplier.vkn || doc.supplierVkn || '',
                supplierTitle: parsed.supplier.title || doc.supplierTitle || '',
            }, { merge: true });
        }

        // Ogrenilmis eslesme onerileri (salt okuma — otomatik stok yazilmaz)
        const supplierVkn = parsed.supplier.vkn || doc.supplierVkn || '';
        const lines = [];
        for (const line of parsed.lines) {
            const mapRef = this.db.collection('supplierProductMappings')
                .doc(this._mappingDocId(tenantId, supplierVkn, line));
            const mapSnap = await mapRef.get();
            const m = mapSnap.exists ? mapSnap.data() : null;
            lines.push({
                ...line,
                suggestedInventoryProductId: m ? m.inventoryProductId : null,
                suggestedInventoryProductName: m ? (m.inventoryProductName || null) : null,
                suggestedUnitMultiplier: m ? (m.unitMultiplier || 1) : null,
            });
        }
        return { ...parsed, lines, status: doc.status };
    }

    // -------------------- 3) APPROVE --------------------

    /**
     * Sube onayi -> stok girisi. items paneldeki eslesmis kalemlerdir; quantity STOK
     * BIRIMINDE gelir (koli->adet cevrimi panelde carpanla yapilir).
     * @param {object} p
     * @param {string} p.tenantId
     * @param {string} p.invoiceId
     * @param {string} p.branchId      Stok girisinin yapilacagi sube
     * @param {Array<{inventoryProductId:string, productName:string, quantity:number, unit:string,
     *                lineNumber?:string, unitMultiplier?:number, mappingSource?:{sellerCode?:string,name?:string}}>} p.items
     * @param {string} p.approvedBy
     * @param {boolean} [p.sendProviderResponse=true]
     */
    async approveInvoice({ tenantId, invoiceId, branchId, items, approvedBy, sendProviderResponse = true }) {
        if (!tenantId || !invoiceId) throw new InboxInvoiceError('tenantId+invoiceId required', { code: 'BAD_REQUEST', status: 400 });
        if (!branchId) throw new InboxInvoiceError('branchId required', { code: 'BAD_REQUEST', status: 400 });
        const list = Array.isArray(items) ? items : [];
        const valid = list.filter((it) => it && it.inventoryProductId && Number(it.quantity) > 0);
        if (valid.length === 0) throw new InboxInvoiceError('en az bir eslesmis kalem gerekli', { code: 'NO_ITEMS', status: 400 });

        const ref = this.db.collection('incomingInvoices').doc(this._docId(tenantId, invoiceId));
        const ts = this.Timestamp.fromMillis(this.now());

        const result = await this.db.runTransaction(async (txn) => {
            const snap = await txn.get(ref);
            if (!snap.exists) throw new InboxInvoiceError('incoming invoice not found', { code: 'NOT_FOUND', status: 404 });
            const doc = snap.data();
            if (doc.tenantId !== tenantId) throw new InboxInvoiceError('cross-tenant erisim reddedildi', { code: 'FORBIDDEN', status: 403 });
            if (doc.status === 'approved') return { alreadyApproved: true, doc };
            if (doc.status === 'declined') throw new InboxInvoiceError('fatura reddedilmis; onaylanamaz', { code: 'ALREADY_DECLINED', status: 409 });

            // Okumalar (hepsi yazmalardan once — Firestore kurali)
            const stockRefs = valid.map((it) => this.db.collection('branchStocks').doc(`${branchId}_${it.inventoryProductId}`));
            const stockSnaps = [];
            for (const sr of stockRefs) stockSnaps.push(await txn.get(sr));

            const invoiceNo = doc.documentId || (doc.parsed && doc.parsed.invoiceNumber) || '';
            const supplierName = doc.supplierTitle || (doc.parsed && doc.parsed.supplier && doc.parsed.supplier.title) || '';

            // Yazimlar
            for (let i = 0; i < valid.length; i++) {
                const it = valid[i];
                const qty = round2(Number(it.quantity));
                const current = stockSnaps[i].exists ? Number((stockSnaps[i].data() || {}).currentStock || 0) : 0;
                txn.set(stockRefs[i], {
                    id: `${branchId}_${it.inventoryProductId}`,
                    tenantId,
                    branchId,
                    productId: it.inventoryProductId,
                    productName: it.productName || it.inventoryProductId,
                    currentStock: round2(current + qty),
                    unit: it.unit || 'adet',
                    lastUpdated: ts,
                }, { merge: true });

                const moveRef = this.db.collection('stockMovements').doc();
                txn.set(moveRef, {
                    id: moveRef.id,
                    tenantId,
                    branchId,
                    movementType: 'INVOICE_ENTRY',
                    productId: it.inventoryProductId,
                    productName: it.productName || it.inventoryProductId,
                    quantity: qty,
                    unit: it.unit || 'adet',
                    movementDate: ts,
                    createdAt: ts,
                    notes: `Gelen e-fatura onayi ${invoiceNo}`.trim(),
                    sourceType: 'incoming_invoice',
                    sourceDocumentId: this._docId(tenantId, invoiceId),
                    createdBy: approvedBy || 'invoicing-engine',
                    invoiceInfo: {
                        invoiceNo,
                        supplierName,
                        invoiceDate: doc.invoiceExecutionDate || doc.invoiceCreateDateUtc || '',
                    },
                });
            }

            txn.set(ref, {
                status: 'approved',
                approval: {
                    branchId,
                    approvedBy: approvedBy || '',
                    approvedAt: ts,
                    items: valid.map((it) => ({
                        inventoryProductId: it.inventoryProductId,
                        productName: it.productName || '',
                        quantity: round2(Number(it.quantity)),
                        unit: it.unit || 'adet',
                        lineNumber: it.lineNumber || '',
                    })),
                },
            }, { merge: true });

            return { alreadyApproved: false, doc };
        });

        if (result.alreadyApproved) {
            return { ok: true, alreadyApproved: true, stockEntries: 0 };
        }

        // Eslesme ogrenmesi (transaction disi — kritik degil, hata yutulur)
        try {
            const supplierVkn = result.doc.supplierVkn
                || (result.doc.parsed && result.doc.parsed.supplier && result.doc.parsed.supplier.vkn) || '';
            for (const it of valid) {
                if (!it.mappingSource) continue;
                const mapRef = this.db.collection('supplierProductMappings')
                    .doc(this._mappingDocId(tenantId, supplierVkn, it.mappingSource));
                await mapRef.set({
                    tenantId,
                    supplierVkn,
                    sellerCode: it.mappingSource.sellerCode || '',
                    sourceName: it.mappingSource.name || '',
                    inventoryProductId: it.inventoryProductId,
                    inventoryProductName: it.productName || '',
                    unitMultiplier: Number(it.unitMultiplier) > 0 ? Number(it.unitMultiplier) : 1,
                    updatedAt: ts,
                    updatedBy: approvedBy || '',
                }, { merge: true });
            }
        } catch (e) {
            this.logger.warn('[inbox] mapping learn failed:', e.message);
        }

        // Uyumsoft'a resmi Approve cevabi — YALNIZ ticari fatura; best-effort.
        let providerResponse = { attempted: false };
        const profileId = result.doc.parsed && result.doc.parsed.profileId;
        if (sendProviderResponse && profileId === 'TICARIFATURA') {
            providerResponse = await this._sendResponseBestEffort(tenantId, invoiceId, 'Approved', 'Mal kabulu yapildi');
        }
        await ref.set({ providerResponse }, { merge: true });

        return { ok: true, alreadyApproved: false, stockEntries: valid.length, providerResponse };
    }

    // -------------------- 4) DECLINE --------------------

    async declineInvoice({ tenantId, invoiceId, reason, declinedBy, sendProviderResponse = true }) {
        if (!tenantId || !invoiceId) throw new InboxInvoiceError('tenantId+invoiceId required', { code: 'BAD_REQUEST', status: 400 });
        const ref = this.db.collection('incomingInvoices').doc(this._docId(tenantId, invoiceId));
        const ts = this.Timestamp.fromMillis(this.now());

        const doc = await this.db.runTransaction(async (txn) => {
            const snap = await txn.get(ref);
            if (!snap.exists) throw new InboxInvoiceError('incoming invoice not found', { code: 'NOT_FOUND', status: 404 });
            const d = snap.data();
            if (d.tenantId !== tenantId) throw new InboxInvoiceError('cross-tenant erisim reddedildi', { code: 'FORBIDDEN', status: 403 });
            if (d.status === 'approved') throw new InboxInvoiceError('onaylanmis fatura reddedilemez', { code: 'ALREADY_APPROVED', status: 409 });
            txn.set(ref, {
                status: 'declined',
                decline: { reason: reason || '', declinedBy: declinedBy || '', declinedAt: ts },
            }, { merge: true });
            return d;
        });

        let providerResponse = { attempted: false };
        const profileId = doc.parsed && doc.parsed.profileId;
        if (sendProviderResponse && profileId === 'TICARIFATURA') {
            providerResponse = await this._sendResponseBestEffort(tenantId, invoiceId, 'Declined', reason || 'Mal kabulu reddedildi');
        }
        await ref.set({ providerResponse }, { merge: true });
        return { ok: true, providerResponse };
    }

    async _sendResponseBestEffort(tenantId, invoiceId, status, reason) {
        try {
            const provider = await this.providerFactory(tenantId);
            // Parasut gelen faturaya resmi kabul/red gondermeyi desteklemiyor; hata
            // uretmek yerine adim atlanir ve dokumana neden yazilir.
            if (provider.supportsDocumentResponse === false || typeof provider.sendDocumentResponse !== 'function') {
                return { attempted: false, unsupported: true, provider: provider.providerName || '', status, at: this.now() };
            }
            const r = await provider.sendDocumentResponse([{ invoiceId, status, reason }]);
            return { attempted: true, ok: !!r.ok, status, at: this.now() };
        } catch (e) {
            this.logger.warn(`[inbox] SendDocumentResponse ${status} failed (${invoiceId}):`, e.message);
            return { attempted: true, ok: false, status, error: e.message, at: this.now() };
        }
    }
}

module.exports = { InboxInvoiceService, InboxInvoiceError };
