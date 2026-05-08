// Plan 28 Faz 1.4.3 — inventoryMovements -> branchInventory aggregate

const {
    applyMovement,
    aggregate,
    makeEmptyAggregate,
    validateMovement,
} = require('../lib/InventoryAggregator');

describe('validateMovement', () => {
    test('happy path: shipment_in to branch', () => {
        const m = {
            tenantId: 't1',
            type: 'shipment_in',
            productId: 'p1',
            quantity: 95,
            toLocation: { type: 'branch', id: 'b1' },
            ts: 1000,
        };
        expect(validateMovement(m).ok).toBe(true);
    });

    test('rejects shipment_in without toLocation', () => {
        const v = validateMovement({ tenantId: 't1', type: 'shipment_in', productId: 'p1', quantity: 1 });
        expect(v.ok).toBe(false);
        expect(v.errors).toContain('shipment_in_requires_toLocation');
    });

    test('rejects shipment_out without fromLocation', () => {
        const v = validateMovement({ tenantId: 't1', type: 'shipment_out', productId: 'p1', quantity: 1 });
        expect(v.ok).toBe(false);
        expect(v.errors).toContain('shipment_out_requires_fromLocation');
    });

    test('rejects unknown type', () => {
        const v = validateMovement({ tenantId: 't1', type: 'wat', productId: 'p1', quantity: 1 });
        expect(v.ok).toBe(false);
        expect(v.errors.some(e => e.startsWith('invalid:type'))).toBe(true);
    });
});

describe('applyMovement (single-step)', () => {
    test('production_in adds to production[productId]', () => {
        const a = makeEmptyAggregate('t1');
        applyMovement(a, {
            tenantId: 't1',
            type: 'production_in',
            productId: 'p1',
            quantity: 100,
            toLocation: { type: 'production', id: 'central' },
            ts: 100,
        });
        expect(a.production['p1'].quantity).toBe(100);
        expect(a.production['p1'].lastMovementAt).toBe(100);
    });

    test('shipment_out from production reduces production stock', () => {
        const a = makeEmptyAggregate('t1');
        applyMovement(a, {
            tenantId: 't1', type: 'production_in', productId: 'p1', quantity: 100,
            toLocation: { type: 'production', id: 'central' }, ts: 100,
        });
        applyMovement(a, {
            tenantId: 't1', type: 'shipment_out', productId: 'p1', quantity: 95,
            fromLocation: { type: 'production', id: 'central' },
            toLocation: { type: 'branch', id: 'b1' },
            ts: 200,
        });
        expect(a.production['p1'].quantity).toBe(5);
    });

    test('shipment_in to branch increases branch stock', () => {
        const a = makeEmptyAggregate('t1');
        applyMovement(a, {
            tenantId: 't1', type: 'shipment_in', productId: 'p1', quantity: 95,
            toLocation: { type: 'branch', id: 'b1' }, ts: 200,
        });
        expect(a.branches['b1']['p1'].quantity).toBe(95);
    });

    test('rejects tenant mismatch', () => {
        const a = makeEmptyAggregate('t1');
        expect(() => applyMovement(a, {
            tenantId: 't-other', type: 'production_in', productId: 'p1', quantity: 1,
            toLocation: { type: 'production', id: 'central' }, ts: 1,
        })).toThrow(/tenant mismatch/);
    });
});

describe('aggregate (replay)', () => {
    test('Bafetto-style scenario: 100 prod -> 95 ship -> 5 fire', () => {
        const movements = [
            // 1. Imalat 100 paket pizza hamuru uretti
            {
                tenantId: 't1', type: 'production_in', productId: 'p1', quantity: 100,
                toLocation: { type: 'production', id: 'central' }, ts: 1000,
            },
            // 2. Sevkiyat: 95 paket Bafetto Kadikoy'e
            {
                tenantId: 't1', type: 'shipment_out', productId: 'p1', quantity: 95,
                fromLocation: { type: 'production', id: 'central' },
                toLocation: { type: 'branch', id: 'b-kadikoy' }, ts: 2000,
            },
            {
                tenantId: 't1', type: 'shipment_in', productId: 'p1', quantity: 95,
                toLocation: { type: 'branch', id: 'b-kadikoy' }, ts: 2000,
            },
            // 3. Yolda hasar: 5 paket fire
            {
                tenantId: 't1', type: 'waste', productId: 'p1', quantity: 5,
                fromLocation: { type: 'production', id: 'central' }, ts: 2001,
            },
        ];

        const result = aggregate('t1', movements);

        // Imalat: 100 - 95 - 5 = 0
        expect(result.production['p1'].quantity).toBe(0);
        // Bafetto Kadikoy: +95
        expect(result.branches['b-kadikoy']['p1'].quantity).toBe(95);
        // Conservation: prod_in (100) = ship_out (95) + waste (5) + branch_in (95) ?
        // Wait — accounting: prod 100, ship_out -95, waste -5 = prod 0. Branch +95. Correct.
        expect(result.updatedAt).toBe(2001);
    });

    test('multi-product aggregate is independent', () => {
        const movements = [
            {
                tenantId: 't1', type: 'production_in', productId: 'p1', quantity: 100,
                toLocation: { type: 'production', id: 'central' }, ts: 1,
            },
            {
                tenantId: 't1', type: 'production_in', productId: 'p2', quantity: 50,
                toLocation: { type: 'production', id: 'central' }, ts: 2,
            },
            {
                tenantId: 't1', type: 'shipment_in', productId: 'p1', quantity: 30,
                toLocation: { type: 'branch', id: 'b1' }, ts: 3,
            },
        ];
        const r = aggregate('t1', movements);
        expect(r.production['p1'].quantity).toBe(100);
        expect(r.production['p2'].quantity).toBe(50);
        expect(r.branches['b1']['p1'].quantity).toBe(30);
        expect(r.branches['b1']['p2']).toBeUndefined();
    });

    test('manual_adjust to branch can correct stock', () => {
        const movements = [
            {
                tenantId: 't1', type: 'shipment_in', productId: 'p1', quantity: 100,
                toLocation: { type: 'branch', id: 'b1' }, ts: 1,
            },
            {
                tenantId: 't1', type: 'manual_adjust', productId: 'p1', quantity: -7,
                toLocation: { type: 'branch', id: 'b1' }, ts: 2,
            },
        ];
        const r = aggregate('t1', movements);
        expect(r.branches['b1']['p1'].quantity).toBe(93);
    });
});
