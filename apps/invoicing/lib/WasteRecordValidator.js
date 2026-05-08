// ==================================================================================
// WasteRecordValidator — wasteRecords schema + tenant izolasyonu
// ==================================================================================
// Plan 28 Faz 1.4.2.
// ==================================================================================

const VALID_SOURCE_TYPES = new Set([
    'invoice_approval',
    'production_loss',
    'expiry',
    'manual',
]);

/**
 * @returns {{ ok: boolean, reason?: string, errors?: string[] }}
 */
function validateWasteRecord(record) {
    if (!record || typeof record !== 'object') {
        return { ok: false, reason: 'not_object' };
    }
    const errors = [];
    const required = ['tenantId', 'branchId', 'productId', 'quantity', 'sourceType', 'sourceId'];
    for (const field of required) {
        if (record[field] === undefined || record[field] === null || record[field] === '') {
            errors.push(`missing:${field}`);
        }
    }
    if (typeof record.quantity === 'number') {
        if (record.quantity <= 0) errors.push('quantity_must_be_positive');
        if (!Number.isFinite(record.quantity)) errors.push('quantity_not_finite');
    } else if (record.quantity !== undefined) {
        errors.push('quantity_not_number');
    }
    if (record.sourceType && !VALID_SOURCE_TYPES.has(record.sourceType)) {
        errors.push(`invalid_sourceType:${record.sourceType}`);
    }
    if (errors.length) return { ok: false, reason: 'schema', errors };
    return { ok: true };
}

/**
 * Caller'in tenantId'si record.tenantId ile eslesmeli.
 */
function assertTenantIsolation(record, callerTenantId) {
    if (!callerTenantId) {
        return { ok: false, reason: 'caller_tenant_missing' };
    }
    if (record.tenantId !== callerTenantId) {
        return { ok: false, reason: `tenant_mismatch:${record.tenantId}!=${callerTenantId}` };
    }
    return { ok: true };
}

module.exports = { validateWasteRecord, assertTenantIsolation, VALID_SOURCE_TYPES };
