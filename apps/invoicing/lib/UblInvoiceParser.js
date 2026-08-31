// ==================================================================================
// UblInvoiceParser — UBL-TR 1.2 gelen fatura XML -> normalize kalem listesi
// ==================================================================================
// Uyumsoft GetInboxInvoiceData'nin dondurdugu UBL Invoice XML'ini stok girisi
// akisinin bekledigi sade modele cevirir. Saglayici-bagimsizdir: ayni UBL-TR'yi
// eLogo/Foriba da dondurur, parser ortak kalir.
//
// Cikti sozlesmesi (approve akisinin girdisi):
// {
//   uuid, invoiceNumber, profileId, invoiceTypeCode, issueDate, currency, notes[],
//   supplier: { vkn, title }, customer: { vkn, title },
//   lines: [{ lineNumber, name, sellerCode, quantity, unitCode, unitLabel,
//             unitPrice, lineTotal, vatRate, vatAmount, description }],
//   totals: { lineExtensionAmount, taxExclusiveAmount, taxInclusiveAmount,
//             allowanceTotalAmount, payableAmount, taxTotal }
// }
// ==================================================================================

const { XMLParser } = require('fast-xml-parser');

// UN/ECE Rec 20 birim kodu -> depo girisinde gosterilecek TR etiket.
// Kapsam disi kodlar oldugu gibi birakilir (unitLabel = unitCode).
const UNIT_CODE_LABELS = {
    C62: 'adet',
    NIU: 'adet',
    EA: 'adet',
    BX: 'kutu',
    CT: 'koli',
    CS: 'kasa',
    PA: 'paket',
    PK: 'paket',
    KGM: 'kg',
    GRM: 'gr',
    LTR: 'lt',
    MLT: 'ml',
    MTR: 'm',
    CMT: 'cm',
    SET: 'set',
    DZN: 'düzine',
    PR: 'çift',
};

function asArray(v) {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
}

// cbc elemanlari attribute tasidiginda { '#text': '12.5', '@_currencyID': 'TRY' }
// seklinde gelir; sade oldugunda direkt string'tir.
function text(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : '';
    return String(v);
}

function num(v, fallback = 0) {
    const n = Number(text(v));
    return Number.isFinite(n) ? n : fallback;
}

function attr(v, name) {
    return v && typeof v === 'object' ? (v[`@_${name}`] || '') : '';
}

/** cac:Party -> { vkn, title }. VKN/TCKN schemeID'li PartyIdentification'dan. */
function parseParty(party) {
    if (!party) return { vkn: '', title: '' };
    let vkn = '';
    for (const pid of asArray(party.PartyIdentification)) {
        const scheme = attr(pid.ID, 'schemeID');
        if (scheme === 'VKN' || scheme === 'TCKN') {
            vkn = text(pid.ID);
            break;
        }
        if (!vkn) vkn = text(pid.ID);
    }
    const title = text(party.PartyName && party.PartyName.Name)
        || [text(party.Person && party.Person.FirstName), text(party.Person && party.Person.FamilyName)].filter(Boolean).join(' ');
    return { vkn, title };
}

/** cac:TaxTotal (satir veya belge) -> { taxAmount, vatRate }. Ilk KDV subtotal'i esas alinir. */
function parseTax(taxTotal) {
    if (!taxTotal) return { taxAmount: 0, vatRate: null };
    const tt = asArray(taxTotal)[0];
    const taxAmount = num(tt.TaxAmount);
    let vatRate = null;
    for (const st of asArray(tt.TaxSubtotal)) {
        const code = text(st.TaxCategory && st.TaxCategory.TaxScheme && st.TaxCategory.TaxScheme.TaxTypeCode);
        // UBL-TR'de KDV vergi kodu 0015'tir; kod yoksa ilk subtotal'in Percent'i alinir.
        if (code === '' || code === '0015') {
            const p = st.Percent !== undefined ? num(st.Percent, null) : (st.TaxCategory && st.TaxCategory.Percent !== undefined ? num(st.TaxCategory.Percent, null) : null);
            if (p !== null) {
                vatRate = p;
                break;
            }
        }
    }
    return { taxAmount, vatRate };
}

/**
 * @param {string} xml  UBL-TR Invoice belgesi
 * @returns normalize fatura (yukaridaki sozlesme)
 * @throws {Error} kok eleman Invoice degilse veya XML bozuksa
 */
function parseUblInvoice(xml) {
    if (!xml || typeof xml !== 'string') throw new Error('UblInvoiceParser: xml string required');
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        removeNSPrefix: true,
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
    });
    let doc;
    try {
        doc = parser.parse(xml);
    } catch (e) {
        throw new Error(`UblInvoiceParser: XML parse hatasi — ${e.message}`);
    }
    const inv = doc.Invoice;
    if (!inv) throw new Error('UblInvoiceParser: kok eleman Invoice degil');

    const supplier = parseParty(inv.AccountingSupplierParty && inv.AccountingSupplierParty.Party);
    const customer = parseParty(inv.AccountingCustomerParty && inv.AccountingCustomerParty.Party);

    const lines = asArray(inv.InvoiceLine).map((ln) => {
        const item = ln.Item || {};
        const { taxAmount, vatRate } = parseTax(ln.TaxTotal);
        const unitCode = attr(ln.InvoicedQuantity, 'unitCode') || 'C62';
        return {
            lineNumber: text(ln.ID),
            name: text(item.Name),
            sellerCode: text(item.SellersItemIdentification && item.SellersItemIdentification.ID),
            quantity: num(ln.InvoicedQuantity),
            unitCode,
            unitLabel: UNIT_CODE_LABELS[unitCode] || unitCode,
            unitPrice: num(ln.Price && ln.Price.PriceAmount),
            lineTotal: num(ln.LineExtensionAmount),
            vatRate,
            vatAmount: taxAmount,
            description: text(item.Description) || asArray(ln.Note).map(text).filter(Boolean).join(' '),
        };
    });

    const lmt = inv.LegalMonetaryTotal || {};
    const docTax = parseTax(inv.TaxTotal);

    return {
        uuid: text(inv.UUID),
        invoiceNumber: text(inv.ID),
        profileId: text(inv.ProfileID),           // TICARIFATURA | TEMELFATURA | EARSIVFATURA
        invoiceTypeCode: text(inv.InvoiceTypeCode), // SATIS | IADE | ISTISNA ...
        issueDate: text(inv.IssueDate),
        currency: text(inv.DocumentCurrencyCode) || 'TRY',
        notes: asArray(inv.Note).map(text).filter(Boolean),
        supplier,
        customer,
        lines,
        totals: {
            lineExtensionAmount: num(lmt.LineExtensionAmount),
            taxExclusiveAmount: num(lmt.TaxExclusiveAmount),
            taxInclusiveAmount: num(lmt.TaxInclusiveAmount),
            allowanceTotalAmount: num(lmt.AllowanceTotalAmount),
            payableAmount: num(lmt.PayableAmount),
            taxTotal: docTax.taxAmount,
        },
    };
}

module.exports = { parseUblInvoice, UNIT_CODE_LABELS };
