// ==================================================================================
// StatusTransitionValidator — invoiceDocuments.status icin gecerli gecisler
// ==================================================================================
// Plan 28 Faz 1.4.1.
// Akis:
//   draft -> pending_approval | approved | cancelled
//     (approved: owner direkt onayladı, düzenleme yapmadı)
//     (pending_approval: owner düzenleme kaydetti, onaya bekliyor)
//   pending_approval -> approved | draft | cancelled
//   approved -> sent | queued | failed | pending_approval | cancelled
//     (sent: tek txn'de Paraşüt+stok bitti)
//     (queued/sending: worker'lı eski akış)
//     (pending_approval: Paraşüt başarısız, geri çekildi)
//   queued -> sending | failed | cancelled
//   sending -> sent | failed | queued
//   sent -> (terminal — sadece audit eklenebilir)
//   failed -> queued | cancelled | approved (manuel retry yolu)
//   cancelled -> (terminal)
// ==================================================================================

const VALID_STATUSES = new Set([
    'draft',
    'pending_approval',
    'approved',
    'queued',
    'sending',
    'sent',
    'failed',
    'cancelled',
]);

const TRANSITIONS = {
    draft: new Set(['pending_approval', 'approved', 'cancelled', 'draft']),
    pending_approval: new Set(['approved', 'draft', 'cancelled', 'pending_approval']),
    // approved → pending_approval Paraşüt rollback yolu icin sadece
    // ApprovalProcessor tarafindan dogrudan IdempotencyService.update()
    // ile yazilir (validator'i bypass eder). Bu yuzden burada listelenmez.
    approved: new Set(['sent', 'queued', 'failed', 'cancelled', 'approved']),
    queued: new Set(['sending', 'failed', 'cancelled', 'queued']),
    sending: new Set(['sent', 'failed', 'queued', 'sending']),
    sent: new Set(['sent']),
    failed: new Set(['queued', 'cancelled', 'approved', 'failed']),
    cancelled: new Set(['cancelled']),
};

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateTransition(fromStatus, toStatus) {
    if (!VALID_STATUSES.has(fromStatus)) {
        return { ok: false, reason: `unknown_from_status:${fromStatus}` };
    }
    if (!VALID_STATUSES.has(toStatus)) {
        return { ok: false, reason: `unknown_to_status:${toStatus}` };
    }
    const allowed = TRANSITIONS[fromStatus];
    if (!allowed || !allowed.has(toStatus)) {
        return { ok: false, reason: `invalid_transition:${fromStatus}->${toStatus}` };
    }
    return { ok: true };
}

function isTerminal(status) {
    return status === 'sent' || status === 'cancelled';
}

module.exports = { validateTransition, isTerminal, VALID_STATUSES, TRANSITIONS };
