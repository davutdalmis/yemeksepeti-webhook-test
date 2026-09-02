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
const { normalizeUnit, convertQuantity, roundQty } = require('./UnitConversion');

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ----------------------------------------------------------------------------------
// 02.09.2026 (Davut karari) — TEDARIKCI = FILTRE, URUN = KONUM, ISTISNA = ONAYDA ELLE
//   * supplierKind  : 'stock' | 'service' | 'unclassified'. Kaynak sirasi:
//       tenants/{tenantId}/supplierProfiles/{vkn}.kind  (panel yazar; Firestore kurali izinli)
//       > tedarikcinin supplierProductMappings kaydi varsa 'stock'
//       > 'unclassified'
//     Ayni Parasut sirketi imalat + sube (Barbeku Turizm: imalat + Saskinbakkal) oldugu icin
//     gelen kutusunda komisyon/elektrik/kurye faturalari da var; bunlar stok ekranini bogar.
//   * targetLocation: satir bazinda 'imalat' | <branchId>. Kaynak sirasi:
//       supplierProductMappings.targetLocation > supplierProfiles.defaultLocation > null (onayci secer)
//     Ayni fatura hem imalat hem sube mali tasiyabilir; her satir kendi konumuna yazilir.
//   * Onayda birim: kalem miktari stok biriminde gelir; mevcut branchStocks satirinin birimi
//     farkliysa (kg satiri / g satiri) UnitConversion ile cevrilir, satir birimi EZILMEZ
//     (CanonicalStockWriter ile ayni kural).
// ----------------------------------------------------------------------------------
const SUPPLIER_PROFILES = 'supplierProfiles';

/** 'imalat' | 'imalat_<tenant>' -> 'imalat'; sube id'si aynen. Bos -> null. */
function normalizeLocation(loc, tenantId) {
    if (!loc) return null;
    const v = String(loc).trim();
    if (!v) return null;
    if (v === 'imalat' || v === `imalat_${tenantId}` || v.startsWith('imalat_')) return 'imalat';
    return v;
}
function locationBranchId(loc, tenantId) {
    return loc === 'imalat' ? `imalat_${tenantId}` : loc;
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

    // -------------------- 0) TEDARIKCI SINIFI / KONUM --------------------

    /** tenants/{tenantId}/supplierProfiles -> Map(vkn -> profile). Yoksa bos Map. */
    async _loadSupplierProfiles(tenantId) {
        const out = new Map();
        try {
            const snap = await this.db.collection('tenants').doc(tenantId).collection(SUPPLIER_PROFILES).get();
            for (const d of snap.docs || []) {
                const x = d.data() || {};
                out.set(String(x.vkn || d.id), { ...x, vkn: String(x.vkn || d.id) });
            }
        } catch (e) {
            this.logger.warn('[inbox] supplierProfiles okunamadi:', e.message);
        }
        return out;
    }

    /** Eslesme kaydi olan tedarikci VKN kumesi (stok tedarikcisi kaniti). */
    async _loadMappingVkns(tenantId) {
        const out = new Set();
        try {
            const snap = await this.db.collection('supplierProductMappings').where('tenantId', '==', tenantId).get();
            for (const d of snap.docs || []) { const v = (d.data() || {}).supplierVkn; if (v) out.add(String(v)); }
        } catch (e) {
            this.logger.warn('[inbox] supplierProductMappings okunamadi:', e.message);
        }
        return out;
    }

    /** Tedarikci sinifi: profil > eslesme kaydi > unclassified. */
    static classifySupplier(vkn, profiles, mappingVkns) {
        const p = vkn ? profiles.get(String(vkn)) : null;
        if (p && (p.kind === 'stock' || p.kind === 'service')) return { kind: p.kind, defaultLocation: p.defaultLocation || null, source: 'profile' };
        if (vkn && mappingVkns.has(String(vkn))) return { kind: 'stock', defaultLocation: null, source: 'mapping' };
        return { kind: 'unclassified', defaultLocation: null, source: 'none' };
    }

    /**
     * incomingInvoices listesi (panel tablo). Her satira supplierKind + supplierKindSource +
     * supplierDefaultLocation eklenir (anlik hesap, dokumana yazilmaz — profil degisince
     * eski faturalar da dogru sinifa duser).
     */
    async listInvoices({ tenantId, status, limit = 500 }) {
        if (!tenantId) throw new InboxInvoiceError('tenantId required', { code: 'BAD_REQUEST', status: 400 });
        let q = this.db.collection('incomingInvoices').where('tenantId', '==', tenantId);
        if (status) q = q.where('status', '==', String(status));
        const [snap, profiles, mappingVkns] = await Promise.all([
            q.limit(limit).get(),
            this._loadSupplierProfiles(tenantId),
            this._loadMappingVkns(tenantId),
        ]);
        const items = (snap.docs || [])
            .map((d) => {
                const { parsed, ...rest } = d.data();
                const c = InboxInvoiceService.classifySupplier(rest.supplierVkn, profiles, mappingVkns);
                return { ...rest, hasLines: !!parsed, supplierKind: c.kind, supplierKindSource: c.source, supplierDefaultLocation: c.defaultLocation };
            })
            .sort((a, b) => String(b.invoiceCreateDateUtc).localeCompare(String(a.invoiceCreateDateUtc)));
        const counts = { stock: 0, service: 0, unclassified: 0 };
        for (const it of items) counts[it.supplierKind] = (counts[it.supplierKind] || 0) + 1;
        return { ok: true, count: items.length, items, counts };
    }

    // -------------------- 0b) ERISIM IZI --------------------

    /**
     * 02.09.2026 (Davut): gelen fatura ekranina KIM ne zaman bakti — her list/lines/pdf/approve/
     * decline cagrisi inboxAccessLog'a yazilir; lines/pdf ayrica faturaya lastViewedAt/By yazar.
     * Aktor bilgisi Cloud Function proxy'den X-Actor-Uid / X-Actor-Role basliklariyla gelir;
     * eski proxy basliksiz cagirir -> actor 'unknown' olarak kaydedilir (iz yine dusur).
     * Hata yutulur: iz yazilamadi diye is akisi durmaz.
     */
    async logAccess({ tenantId, action, invoiceId, actor, meta }) {
        try {
            const ts = this.Timestamp.fromMillis(this.now());
            const ref = this.db.collection('inboxAccessLog').doc();
            await ref.set({
                id: ref.id,
                tenantId: tenantId || '',
                action: action || 'unknown',
                invoiceId: invoiceId || null,
                actorUid: (actor && actor.uid) || 'unknown',
                actorRole: (actor && actor.role) || 'unknown',
                actorFirmOwner: actor && typeof actor.firmOwner === 'boolean' ? actor.firmOwner : null,
                meta: meta || null,
                at: ts,
            });
            if (invoiceId && (action === 'lines' || action === 'pdf')) {
                await this.db.collection('incomingInvoices').doc(this._docId(tenantId, invoiceId)).set({
                    lastViewedAt: ts,
                    lastViewedBy: (actor && actor.uid) || 'unknown',
                    lastViewedRole: (actor && actor.role) || 'unknown',
                }, { merge: true });
            }
        } catch (e) {
            this.logger.warn('[inbox] erisim izi yazilamadi:', e.message);
        }
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
        const profiles = await this._loadSupplierProfiles(tenantId);
        const profile = profiles.get(String(supplierVkn)) || null;
        const profileLoc = profile ? normalizeLocation(profile.defaultLocation, tenantId) : null;
        const lines = [];
        for (const line of parsed.lines) {
            const mapRef = this.db.collection('supplierProductMappings')
                .doc(this._mappingDocId(tenantId, supplierVkn, line));
            const mapSnap = await mapRef.get();
            const m = mapSnap.exists ? mapSnap.data() : null;
            // Konum onerisi: eslesme kaydi > tedarikci profili > null (onayci secer)
            const suggestedTargetLocation = (m && normalizeLocation(m.targetLocation, tenantId)) || profileLoc || null;
            lines.push({
                ...line,
                suggestedInventoryProductId: m ? m.inventoryProductId : null,
                suggestedInventoryProductName: m ? (m.inventoryProductName || null) : null,
                suggestedUnitMultiplier: m ? (m.unitMultiplier || 1) : null,
                suggestedTargetLocation,
            });
        }
        return { ...parsed, lines, status: doc.status, supplierKind: profile ? (profile.kind || null) : null, supplierDefaultLocation: profileLoc };
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
        const defaultLoc = normalizeLocation(branchId, tenantId);
        const list = Array.isArray(items) ? items : [];
        // Her kalemin konumu: item.targetLocation > govde branchId. 'imalat' -> imalat_<tenant>.
        const valid = list
            .filter((it) => it && it.inventoryProductId && Number(it.quantity) > 0)
            .map((it) => ({ ...it, _loc: normalizeLocation(it.targetLocation, tenantId) || defaultLoc }));
        if (valid.length === 0) throw new InboxInvoiceError('en az bir eslesmis kalem gerekli', { code: 'NO_ITEMS', status: 400 });
        const konumsuz = valid.filter((it) => !it._loc);
        if (konumsuz.length) throw new InboxInvoiceError(`konum secilmemis kalem: ${konumsuz.map((it) => it.productName || it.inventoryProductId).join(', ')}`, { code: 'NO_LOCATION', status: 400 });

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
            const stockRefs = valid.map((it) => this.db.collection('branchStocks').doc(`${locationBranchId(it._loc, tenantId)}_${it.inventoryProductId}`));
            const stockSnaps = [];
            for (const sr of stockRefs) stockSnaps.push(await txn.get(sr));

            const invoiceNo = doc.documentId || (doc.parsed && doc.parsed.invoiceNumber) || '';
            const supplierName = doc.supplierTitle || (doc.parsed && doc.parsed.supplier && doc.parsed.supplier.title) || '';

            // Yazimlar — kalem kendi konumuna; satir birimi varsa ona cevrilir, ezilmez
            for (let i = 0; i < valid.length; i++) {
                const it = valid[i];
                const rowBranchId = locationBranchId(it._loc, tenantId);
                const rowData = stockSnaps[i].exists ? (stockSnaps[i].data() || {}) : {};
                const current = Number(rowData.currentStock || 0);
                const itemUnit = normalizeUnit(it.unit, 'adet');
                const rowUnit = rowData.unit ? normalizeUnit(rowData.unit, itemUnit) : itemUnit;
                const c = convertQuantity(Number(it.quantity), itemUnit, rowUnit);
                const qty = roundQty(c.qty);
                txn.set(stockRefs[i], {
                    id: `${rowBranchId}_${it.inventoryProductId}`,
                    tenantId,
                    branchId: rowBranchId,
                    productId: it.inventoryProductId,
                    productName: it.productName || it.inventoryProductId,
                    currentStock: roundQty(current + qty),
                    unit: rowUnit,
                    lastUpdated: ts,
                }, { merge: true });

                const moveRef = this.db.collection('stockMovements').doc();
                txn.set(moveRef, {
                    id: moveRef.id,
                    tenantId,
                    branchId: rowBranchId,
                    movementType: 'INVOICE_ENTRY',
                    productId: it.inventoryProductId,
                    productName: it.productName || it.inventoryProductId,
                    quantity: qty,
                    unit: rowUnit,
                    sourceQuantity: roundQty(Number(it.quantity)),
                    sourceUnit: itemUnit,
                    ...(c.mismatch ? { unitMismatch: true } : {}),
                    targetLocation: it._loc,
                    movementDate: ts,
                    createdAt: ts,
                    notes: `Gelen e-fatura onayi ${invoiceNo}`.trim() + (c.mismatch ? ` (birim uyusmazligi: ${itemUnit} -> ${rowUnit}, cevrilmedi)` : ''),
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

            const locations = [...new Set(valid.map((it) => it._loc))];
            txn.set(ref, {
                status: 'approved',
                approval: {
                    // Geriye uyum: branchId = ilk konumun deposu; tum konumlar `locations`ta
                    branchId: locationBranchId(locations[0], tenantId),
                    locations,
                    approvedBy: approvedBy || '',
                    approvedAt: ts,
                    items: valid.map((it) => ({
                        inventoryProductId: it.inventoryProductId,
                        productName: it.productName || '',
                        quantity: round2(Number(it.quantity)),
                        unit: it.unit || 'adet',
                        lineNumber: it.lineNumber || '',
                        targetLocation: it._loc,
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
                    targetLocation: it._loc,
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

module.exports = { InboxInvoiceService, InboxInvoiceError, normalizeLocation, locationBranchId };
