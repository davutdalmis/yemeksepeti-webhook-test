// Plan 28 Faz 1.4.1 — invoiceDocuments status transition validation

const { validateTransition, isTerminal, VALID_STATUSES } = require('../lib/StatusTransitionValidator');

describe('StatusTransitionValidator.validateTransition', () => {
    test('happy path through edit: draft -> pending_approval -> approved -> sent', () => {
        expect(validateTransition('draft', 'pending_approval').ok).toBe(true);
        expect(validateTransition('pending_approval', 'approved').ok).toBe(true);
        expect(validateTransition('approved', 'sent').ok).toBe(true);
    });

    test('happy path direct approve (no edit): draft -> approved -> sent', () => {
        // Plan 28: owner can approve draft directly without editing
        expect(validateTransition('draft', 'approved').ok).toBe(true);
        expect(validateTransition('approved', 'sent').ok).toBe(true);
    });

    test('legacy worker path: approved -> queued -> sending -> sent', () => {
        expect(validateTransition('approved', 'queued').ok).toBe(true);
        expect(validateTransition('queued', 'sending').ok).toBe(true);
        expect(validateTransition('sending', 'sent').ok).toBe(true);
    });

    test('cannot bypass approval: draft cannot go directly to queued or sent', () => {
        expect(validateTransition('draft', 'queued').ok).toBe(false);
        expect(validateTransition('draft', 'sent').ok).toBe(false);
        expect(validateTransition('pending_approval', 'queued').ok).toBe(false);
        expect(validateTransition('pending_approval', 'sent').ok).toBe(false);
    });

    test('pending_approval can revert to draft (yetkili duzenlemeyi iptal etti)', () => {
        expect(validateTransition('pending_approval', 'draft').ok).toBe(true);
    });

    test('sent is terminal — only sent->sent (idempotent)', () => {
        expect(validateTransition('sent', 'cancelled').ok).toBe(false);
        expect(validateTransition('sent', 'failed').ok).toBe(false);
        expect(validateTransition('sent', 'sent').ok).toBe(true);
    });

    test('cancelled is terminal', () => {
        expect(validateTransition('cancelled', 'draft').ok).toBe(false);
        expect(validateTransition('cancelled', 'sent').ok).toBe(false);
    });

    test('failed can be re-queued or cancelled', () => {
        expect(validateTransition('failed', 'queued').ok).toBe(true);
        expect(validateTransition('failed', 'cancelled').ok).toBe(true);
        expect(validateTransition('failed', 'sent').ok).toBe(false);
    });

    test('cancellation always allowed from non-terminal active states', () => {
        for (const s of ['draft', 'pending_approval', 'approved', 'queued', 'failed']) {
            expect(validateTransition(s, 'cancelled').ok).toBe(true);
        }
    });

    test('rejects unknown status names', () => {
        expect(validateTransition('foo', 'draft').ok).toBe(false);
        expect(validateTransition('draft', 'bar').ok).toBe(false);
    });

    test('isTerminal flags sent and cancelled', () => {
        expect(isTerminal('sent')).toBe(true);
        expect(isTerminal('cancelled')).toBe(true);
        expect(isTerminal('draft')).toBe(false);
        expect(isTerminal('pending_approval')).toBe(false);
        expect(isTerminal('approved')).toBe(false);
    });

    test('VALID_STATUSES set has 8 entries', () => {
        expect(VALID_STATUSES.size).toBe(8);
        for (const s of ['draft', 'pending_approval', 'approved', 'queued', 'sending', 'sent', 'failed', 'cancelled']) {
            expect(VALID_STATUSES.has(s)).toBe(true);
        }
    });
});
