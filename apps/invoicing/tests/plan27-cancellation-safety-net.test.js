// Plan 27 — IPTAL GUVENLIK AGI testleri (StockTransferListener._handleCancellation)
// shipped sonrasi iptal edilen transfer'in iliskili invoiceDocuments belgeleri:
//   - kesilmemis (draft vb.)  -> otomatik void (status='cancelled') + Parasut taslak sil
//   - kesilmis (sent)         -> OTOMATIK BOZMA YOK, cancellationRequested bayrak + manuel inceleme
//   - sending                 -> bayrak (mid-flight, gecis gecersiz)
//   - parasutCancellationHandled=true -> no-op (idempotent)

const StockTransferListener = require('../listeners/StockTransferListener');

// db: sadece constructor + start() icin; testlerde _handleCancellation dogrudan cagrilir.
function makeDb() {
    const chain = { where: () => chain, onSnapshot: () => () => {} };
    return { collection: () => chain };
}

// In-memory idempotency mock — invoiceDocuments store + cagri kaydi
function makeIdempotency(initialDocs = {}) {
    const docs = { ...initialDocs };
    const calls = { update: [], audit: [] };
    return {
        docs,
        calls,
        async getById(id) {
            return docs[id] ? { id, ...docs[id] } : null;
        },
        async update(id, patch) {
            calls.update.push({ id, patch });
            docs[id] = { ...(docs[id] || {}), ...patch };
        },
        async appendAudit(id, event, by, details) {
            calls.audit.push({ id, event, by, details });
        },
        async ensureDraft() { throw new Error('not used'); },
    };
}

function makeTransferSnap(id, data) {
    const refUpdates = [];
    return {
        id,
        data: () => data,
        ref: { update: async (patch) => { refUpdates.push(patch); } },
        _refUpdates: refUpdates,
    };
}

function makeListener(idempotency, { provider, tokenManager } = {}) {
    return new StockTransferListener({
        db: makeDb(),
        idempotency,
        settingsLoader: async () => ({ isEnabled: true }),
        providerFactory: provider ? async () => provider : null,
        tokenManager: tokenManager || null,
    });
}

describe('Plan 27 — iptal guvenlik agi', () => {
    test('KESILMEMIS draft -> otomatik void (status=cancelled) + transfer damgalanir', async () => {
        const idem = makeIdempotency({ 'doc-1': { status: 'draft', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeTransferSnap('trf-1', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutDocumentId: 'doc-1',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['doc-1'].status).toBe('cancelled');
        expect(idem.docs['doc-1'].cancellationReason).toBe('source_transfer_cancelled');
        const audits = idem.calls.audit.map((a) => a.event);
        expect(audits).toContain('transfer_cancelled_auto_void');
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('KESILMEMIS draft + Parasut taslak -> cancelDocument cagrilir', async () => {
        const idem = makeIdempotency({
            'doc-2': { status: 'draft', tenantId: 'T1', parasutInvoiceId: '111' },
        });
        const cancelCalls = [];
        const provider = {
            async cancelDocument(token, invId, reason) {
                cancelCalls.push({ token, invId, reason });
                return { ok: true };
            },
        };
        const tokenManager = { async getValidToken() { return 'TKN'; } };
        const listener = makeListener(idem, { provider, tokenManager });
        const snap = makeTransferSnap('trf-2', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutDocumentId: 'doc-2',
        });

        await listener._handleCancellation(snap);

        expect(cancelCalls).toHaveLength(1);
        expect(cancelCalls[0].invId).toBe('111');
        expect(cancelCalls[0].token).toBe('TKN');
        expect(idem.docs['doc-2'].status).toBe('cancelled');
        expect(idem.calls.audit.map((a) => a.event)).toContain('parasut_draft_deleted');
    });

    test('KESILMIS (sent) -> OTOMATIK BOZMA YOK, manuel inceleme bayragi', async () => {
        const idem = makeIdempotency({
            'doc-3': { status: 'sent', tenantId: 'T1', parasutInvoiceId: '222' },
        });
        const cancelCalls = [];
        const provider = { async cancelDocument(...a) { cancelCalls.push(a); return { ok: true }; } };
        const tokenManager = { async getValidToken() { return 'TKN'; } };
        const listener = makeListener(idem, { provider, tokenManager });
        const snap = makeTransferSnap('trf-3', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutDocumentId: 'doc-3',
        });

        await listener._handleCancellation(snap);

        // KRITIK: sent belge status'u DEGISMEZ + Parasut'a DELETE atilmaz
        expect(idem.docs['doc-3'].status).toBe('sent');
        expect(cancelCalls).toHaveLength(0);
        expect(idem.docs['doc-3'].cancellationRequested).toBe(true);
        expect(idem.calls.audit.map((a) => a.event)).toContain('transfer_cancelled_after_sent');
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('sending -> bayrak, status degismez (gecis gecersiz)', async () => {
        const idem = makeIdempotency({ 'doc-4': { status: 'sending', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeTransferSnap('trf-4', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutDocumentId: 'doc-4',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['doc-4'].status).toBe('sending');
        expect(idem.docs['doc-4'].cancellationRequested).toBe(true);
        expect(idem.calls.audit.map((a) => a.event)).toContain('transfer_cancelled_while_sending');
    });

    test('parasutCancellationHandled=true -> no-op (idempotent)', async () => {
        const idem = makeIdempotency({ 'doc-5': { status: 'draft', tenantId: 'T1' } });
        const listener = makeListener(idem);
        const snap = makeTransferSnap('trf-5', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutCancellationHandled: true,
            parasutDocumentId: 'doc-5',
        });

        await listener._handleCancellation(snap);

        expect(idem.calls.update).toHaveLength(0);
        expect(idem.docs['doc-5'].status).toBe('draft');
    });

    test('iliskili belge yok -> sadece damga vurulur (documents:0)', async () => {
        const idem = makeIdempotency({});
        const listener = makeListener(idem);
        const snap = makeTransferSnap('trf-6', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
        });

        await listener._handleCancellation(snap);

        expect(idem.calls.update).toHaveLength(0);
        expect(snap._refUpdates[0].parasutCancellationHandled).toBe(true);
    });

    test('hem invoice hem shipment belgesi varsa ikisi de islenir', async () => {
        const idem = makeIdempotency({
            'inv-doc': { status: 'draft', tenantId: 'T1' },
            'shp-doc': { status: 'pending_approval', tenantId: 'T1' },
        });
        const listener = makeListener(idem);
        const snap = makeTransferSnap('trf-7', {
            tenantId: 'T1',
            status: 'cancelled',
            parasutQueued: true,
            parasutDocumentId: 'inv-doc',
            parasutShipmentDocumentId: 'shp-doc',
        });

        await listener._handleCancellation(snap);

        expect(idem.docs['inv-doc'].status).toBe('cancelled');
        expect(idem.docs['shp-doc'].status).toBe('cancelled');
    });
});
