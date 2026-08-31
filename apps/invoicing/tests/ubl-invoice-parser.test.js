// UblInvoiceParser birim testleri — UBL-TR 1.2 sekilli gercekci tedarikci faturasi.
// Fixture GIB UBL-TR kilavuzundaki alan/namespace yapisini birebir izler
// (cbc/cac prefix'leri, VKN schemeID, 0015 KDV kodu, LegalMonetaryTotal).

const { parseUblInvoice, UNIT_CODE_LABELS } = require('../lib/UblInvoiceParser');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>CCI2026000012345</cbc:ID>
  <cbc:UUID>e6b0a7a2-1111-2222-3333-444455556666</cbc:UUID>
  <cbc:IssueDate>2026-08-01</cbc:IssueDate>
  <cbc:IssueTime>09:12:47</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note>Haftalik icecek sevkiyati</cbc:Note>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>3</cbc:LineCountNumeric>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">2110056338</cbc:ID></cac:PartyIdentification>
      <cac:PartyIdentification><cbc:ID schemeID="MERSISNO">0211005633800015</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>COCA-COLA SATIS VE DAGITIM A.S.</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">1234567890</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>BAFETTO GIDA SAN. TIC. LTD. STI.</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="TRY">208.40</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="TRY">1042.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="TRY">208.40</cbc:TaxAmount>
      <cbc:Percent>20</cbc:Percent>
      <cac:TaxCategory>
        <cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">1092.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="TRY">1042.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">1250.40</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="TRY">50.00</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="TRY">1250.40</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="CT">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">600.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">120.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">600.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">120.00</cbc:TaxAmount>
        <cbc:Percent>20</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Coca-Cola 1 L Pet (12'li Koli)</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>CC-1L-12</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">60.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="BX">8</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">400.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">80.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">400.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">80.00</cbc:TaxAmount>
        <cbc:Percent>20</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Fanta 330 ml Kutu (24'lu)</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>FT-330-24</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">50.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>3</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">46</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">92.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">8.40</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">42.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">8.40</cbc:TaxAmount>
        <cbc:Percent>1</cbc:Percent>
        <cac:TaxCategory>
          <cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>Damla Su 0.5 L</cbc:Name>
      <cbc:Description>Cam sise</cbc:Description>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">2.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

describe('parseUblInvoice — belge basligi', () => {
    const inv = parseUblInvoice(SAMPLE);

    test('kimlik alanlari', () => {
        expect(inv.invoiceNumber).toBe('CCI2026000012345');
        expect(inv.uuid).toBe('e6b0a7a2-1111-2222-3333-444455556666');
        expect(inv.profileId).toBe('TICARIFATURA');
        expect(inv.invoiceTypeCode).toBe('SATIS');
        expect(inv.issueDate).toBe('2026-08-01');
        expect(inv.currency).toBe('TRY');
        expect(inv.notes).toEqual(['Haftalik icecek sevkiyati']);
    });

    test('tedarikci VKN schemeID ile secilir (MERSISNO degil)', () => {
        expect(inv.supplier.vkn).toBe('2110056338');
        expect(inv.supplier.title).toBe('COCA-COLA SATIS VE DAGITIM A.S.');
    });

    test('musteri (bizim firma)', () => {
        expect(inv.customer.vkn).toBe('1234567890');
        expect(inv.customer.title).toBe('BAFETTO GIDA SAN. TIC. LTD. STI.');
    });

    test('toplamlar LegalMonetaryTotal + belge KDV', () => {
        expect(inv.totals.payableAmount).toBe(1250.4);
        expect(inv.totals.taxExclusiveAmount).toBe(1042);
        expect(inv.totals.taxInclusiveAmount).toBe(1250.4);
        expect(inv.totals.allowanceTotalAmount).toBe(50);
        expect(inv.totals.taxTotal).toBe(208.4);
    });
});

describe('parseUblInvoice — kalemler', () => {
    const inv = parseUblInvoice(SAMPLE);

    test('3 kalem, siralama korunur', () => {
        expect(inv.lines).toHaveLength(3);
        expect(inv.lines.map((l) => l.lineNumber)).toEqual(['1', '2', '3']);
    });

    test('koli birimli kalem: miktar/birim/fiyat/kdv', () => {
        const l = inv.lines[0];
        expect(l.name).toBe("Coca-Cola 1 L Pet (12'li Koli)");
        expect(l.sellerCode).toBe('CC-1L-12');
        expect(l.quantity).toBe(10);
        expect(l.unitCode).toBe('CT');
        expect(l.unitLabel).toBe('koli');
        expect(l.unitPrice).toBe(60);
        expect(l.lineTotal).toBe(600);
        expect(l.vatRate).toBe(20);
        expect(l.vatAmount).toBe(120);
    });

    test('adet birimli kalem + farkli KDV orani + description', () => {
        const l = inv.lines[2];
        expect(l.unitCode).toBe('C62');
        expect(l.unitLabel).toBe('adet');
        expect(l.vatRate).toBe(1);
        expect(l.description).toBe('Cam sise');
        expect(l.sellerCode).toBe('');
    });
});

describe('parseUblInvoice — hata/kenar durumlari', () => {
    test('tek kalemli fatura: InvoiceLine dizi olmasa da dizi doner', () => {
        const single = SAMPLE.replace(/<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/,
            `<cac:InvoiceLine>
              <cbc:ID>1</cbc:ID>
              <cbc:InvoicedQuantity unitCode="KGM">2.5</cbc:InvoicedQuantity>
              <cbc:LineExtensionAmount currencyID="TRY">100.00</cbc:LineExtensionAmount>
              <cac:Item><cbc:Name>Mozzarella</cbc:Name></cac:Item>
              <cac:Price><cbc:PriceAmount currencyID="TRY">40.00</cbc:PriceAmount></cac:Price>
            </cac:InvoiceLine>`);
        const inv = parseUblInvoice(single);
        expect(inv.lines).toHaveLength(1);
        expect(inv.lines[0].quantity).toBe(2.5);
        expect(inv.lines[0].unitLabel).toBe('kg');
        expect(inv.lines[0].vatRate).toBeNull(); // satirda TaxTotal yok
    });

    test('kok eleman Invoice degilse throw', () => {
        expect(() => parseUblInvoice('<DespatchAdvice/>')).toThrow('Invoice degil');
    });

    test('bos/gecersiz girdi throw', () => {
        expect(() => parseUblInvoice('')).toThrow('xml string required');
        expect(() => parseUblInvoice(null)).toThrow('xml string required');
    });

    test('bilinmeyen birim kodu oldugu gibi kalir', () => {
        const x = SAMPLE.replace('unitCode="CT"', 'unitCode="ZZ"');
        const inv = parseUblInvoice(x);
        expect(inv.lines[0].unitCode).toBe('ZZ');
        expect(inv.lines[0].unitLabel).toBe('ZZ');
    });

    test('UNIT_CODE_LABELS temel kapsam', () => {
        expect(UNIT_CODE_LABELS.C62).toBe('adet');
        expect(UNIT_CODE_LABELS.CT).toBe('koli');
        expect(UNIT_CODE_LABELS.BX).toBe('kutu');
        expect(UNIT_CODE_LABELS.KGM).toBe('kg');
        expect(UNIT_CODE_LABELS.LTR).toBe('lt');
    });
});
