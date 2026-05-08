// Plan 28 Faz 1.4.2 — wasteRecords schema + tenantId izolasyonu

const { validateWasteRecord, assertTenantIsolation } = require('../lib/WasteRecordValidator');

const valid = () => ({
    tenantId: 't1',
    branchId: 'b1',
    productId: 'p1',
    productName: 'Mozzarella 1kg',
    quantity: 5,
    unit: 'paket',
    sourceType: 'invoice_approval',
    sourceId: 'inv-doc-id',
    reason: 'yolda hasar',
    recordedBy: 'owner-uid',
    recordedAt: Date.now(),
});

describe('validateWasteRecord', () => {
    test('happy path', () => {
        expect(validateWasteRecord(valid()).ok).toBe(true);
    });

    test('rejects missing required fields', () => {
        const required = ['tenantId', 'branchId', 'productId', 'sourceType', 'sourceId'];
        for (const field of required) {
            const r = valid();
            delete r[field];
            const v = validateWasteRecord(r);
            expect(v.ok).toBe(false);
            expect(v.errors).toContain(`missing:${field}`);
        }
    });

    test('rejects non-positive quantity', () => {
        const r = valid();
        r.quantity = 0;
        expect(validateWasteRecord(r).ok).toBe(false);
        r.quantity = -3;
        expect(validateWasteRecord(r).ok).toBe(false);
    });

    test('rejects unknown sourceType', () => {
        const r = valid();
        r.sourceType = 'foo';
        const v = validateWasteRecord(r);
        expect(v.ok).toBe(false);
        expect(v.errors.some(e => e.startsWith('invalid_sourceType'))).toBe(true);
    });

    test('accepts all 4 known sourceTypes', () => {
        for (const st of ['invoice_approval', 'production_loss', 'expiry', 'manual']) {
            const r = valid();
            r.sourceType = st;
            expect(validateWasteRecord(r).ok).toBe(true);
        }
    });
});

describe('assertTenantIsolation', () => {
    test('passes when tenantId matches caller', () => {
        const r = valid();
        expect(assertTenantIsolation(r, 't1').ok).toBe(true);
    });

    test('rejects when tenantId differs from caller', () => {
        const r = valid();
        const v = assertTenantIsolation(r, 't2');
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/tenant_mismatch/);
    });

    test('rejects when caller tenant is missing', () => {
        const r = valid();
        expect(assertTenantIsolation(r, '').ok).toBe(false);
        expect(assertTenantIsolation(r, undefined).ok).toBe(false);
    });
});
