// ==================================================================================
// InventoryAggregator — inventoryMovements -> branchInventory aggregate (saf)
// ==================================================================================
// Plan 28 Faz 1.4.3.
// Saf, baska state'e dokunmayan reducer. Engine eager-update yaparken VEYA
// tarihten replay yaparken kullanir. Yan etki yok.
// ==================================================================================

const VALID_TYPES = new Set([
    'production_in',
    'shipment_out',
    'shipment_in',
    'waste',
    'manual_adjust',
]);

/**
 * @returns {{ ok: boolean, reason?: string, errors?: string[] }}
 */
function validateMovement(m) {
    const errors = [];
    if (!m || typeof m !== 'object') return { ok: false, reason: 'not_object' };
    if (!m.tenantId) errors.push('missing:tenantId');
    if (!m.productId) errors.push('missing:productId');
    if (typeof m.quantity !== 'number' || !Number.isFinite(m.quantity)) errors.push('invalid:quantity');
    if (!VALID_TYPES.has(m.type)) errors.push(`invalid:type:${m.type}`);
    // shipment_in icin toLocation, shipment_out icin fromLocation zorunlu
    if (m.type === 'shipment_in') {
        if (!m.toLocation || !m.toLocation.id) errors.push('shipment_in_requires_toLocation');
    }
    if (m.type === 'shipment_out') {
        if (!m.fromLocation || !m.fromLocation.id) errors.push('shipment_out_requires_fromLocation');
    }
    if (m.type === 'production_in') {
        if (!m.toLocation || m.toLocation.type !== 'production') {
            errors.push('production_in_requires_production_toLocation');
        }
    }
    if (m.type === 'waste') {
        if (!m.fromLocation || !m.fromLocation.id) errors.push('waste_requires_fromLocation');
    }
    if (errors.length) return { ok: false, reason: 'schema', errors };
    return { ok: true };
}

function makeEmptyAggregate(tenantId) {
    return {
        tenantId,
        branches: {},
        production: {},
        updatedAt: 0,
    };
}

function adjustLocation(map, key, productId, delta, ts) {
    if (!map[key]) map[key] = {};
    if (!map[key][productId]) {
        map[key][productId] = { quantity: 0, lastMovementAt: 0 };
    }
    map[key][productId].quantity += delta;
    if (ts && ts > (map[key][productId].lastMovementAt || 0)) {
        map[key][productId].lastMovementAt = ts;
    }
}

/**
 * Tek bir movement'i mevcut aggregate uzerine uygular (mutating).
 */
function applyMovement(aggregate, movement) {
    const v = validateMovement(movement);
    if (!v.ok) {
        const e = new Error(`InventoryAggregator: invalid movement (${v.reason})`);
        e.errors = v.errors;
        throw e;
    }
    if (movement.tenantId !== aggregate.tenantId) {
        throw new Error(`InventoryAggregator: tenant mismatch ${movement.tenantId}!=${aggregate.tenantId}`);
    }
    const ts = movement.ts || 0;
    const qty = movement.quantity;
    switch (movement.type) {
        case 'production_in':
            adjustLocation(aggregate, 'production', movement.productId, qty, ts);
            break;
        case 'shipment_out':
            // Tipik akis: production -> branch. Kaynak konum production ise oradan dus.
            if (movement.fromLocation && movement.fromLocation.type === 'production') {
                adjustLocation(aggregate, 'production', movement.productId, -qty, ts);
            } else if (movement.fromLocation && movement.fromLocation.type === 'branch') {
                adjustLocation(aggregate.branches, movement.fromLocation.id, movement.productId, -qty, ts);
            }
            break;
        case 'shipment_in':
            if (movement.toLocation && movement.toLocation.type === 'branch') {
                adjustLocation(aggregate.branches, movement.toLocation.id, movement.productId, qty, ts);
            } else if (movement.toLocation && movement.toLocation.type === 'production') {
                adjustLocation(aggregate, 'production', movement.productId, qty, ts);
            }
            break;
        case 'waste':
            if (movement.fromLocation && movement.fromLocation.type === 'production') {
                adjustLocation(aggregate, 'production', movement.productId, -qty, ts);
            } else if (movement.fromLocation && movement.fromLocation.type === 'branch') {
                adjustLocation(aggregate.branches, movement.fromLocation.id, movement.productId, -qty, ts);
            }
            break;
        case 'manual_adjust':
            if (movement.toLocation && movement.toLocation.type === 'branch') {
                adjustLocation(aggregate.branches, movement.toLocation.id, movement.productId, qty, ts);
            } else if (movement.toLocation && movement.toLocation.type === 'production') {
                adjustLocation(aggregate, 'production', movement.productId, qty, ts);
            }
            break;
        default:
            throw new Error(`InventoryAggregator: unknown type ${movement.type}`);
    }
    if (ts > (aggregate.updatedAt || 0)) aggregate.updatedAt = ts;
    return aggregate;
}

function aggregate(tenantId, movements) {
    const out = makeEmptyAggregate(tenantId);
    for (const m of movements) applyMovement(out, m);
    return out;
}

function adjustLocationHelper(map, key, productId, delta, ts) {
    return adjustLocation(map, key, productId, delta, ts);
}

module.exports = {
    applyMovement,
    aggregate,
    makeEmptyAggregate,
    validateMovement,
    VALID_TYPES,
    // exposed for unit test of helper
    _adjustLocation: adjustLocationHelper,
};
