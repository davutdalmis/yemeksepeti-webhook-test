// ==================================================================================
// webhook-signature-auditor Tests
//
// 2026-05-27 (WPF Resilience İş 4-A):
// Discovery mode auditor'ın default-off flag + PII masking + body hash +
// fail-soft davranışını doğrular. Hiçbir enforce yok.
// ==================================================================================

const mockSet = jest.fn().mockResolvedValue();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('@yemigo/shared/firestore-admin', () => ({
    db: { collection: mockCollection },
    firebaseInitialized: true,
}));

const auditor = require('../services/webhook-signature-auditor');
const { maskHeaders, sha256Hex, buildDocId } = auditor._internals;

beforeEach(() => {
    mockSet.mockClear().mockResolvedValue();
    mockDoc.mockClear();
    mockCollection.mockClear();
    process.env.WEBHOOK_SIGNATURE_DISCOVERY_ENABLED = 'true';  // varsayılan testte açık
});

afterEach(() => {
    delete process.env.WEBHOOK_SIGNATURE_DISCOVERY_ENABLED;
});

describe('webhook-signature-auditor', () => {

    // ── Test 1: Flag kapalı (false/missing) → skip eder ─────────────────────

    test('recordRequest_flag_kapali_skip_eder', async () => {
        delete process.env.WEBHOOK_SIGNATURE_DISCOVERY_ENABLED;

        const result = await auditor.recordRequest({
            platform: 'yemeksepeti',
            req: { method: 'POST', path: '/order/abc', headers: {}, ip: '1.2.3.4' },
            body: { orderId: 'YS-1' },
        });

        expect(result.skipped).toBe(true);
        expect(mockSet).not.toHaveBeenCalled();
    });

    // ── Test 2: Flag açık → Firestore set çağrılır, doğru alanlar ──────────

    test('recordRequest_basit_yazim', async () => {
        const result = await auditor.recordRequest({
            platform: 'yemeksepeti',
            req: {
                method: 'POST',
                path: '/order/abc123',
                ip: '1.2.3.4',
                headers: { 'content-type': 'application/json', 'x-signature': 'sig_xyz' },
            },
            body: { orderId: 'YS-1', total: 100 },
        });

        expect(result.success).toBe(true);
        expect(result.docId).toMatch(/^yemeksepeti_\d+_/);
        expect(mockCollection).toHaveBeenCalledWith('webhookSignatureAudit');
        const writtenDoc = mockSet.mock.calls[0][0];
        expect(writtenDoc.platform).toBe('yemeksepeti');
        expect(writtenDoc.method).toBe('POST');
        expect(writtenDoc.path).toBe('/order/abc123');
        expect(writtenDoc.headers['content-type']).toBe('application/json');
        expect(writtenDoc.headers['x-signature']).toBe('sig_xyz');
        expect(writtenDoc.bodyHash).toMatch(/^[a-f0-9]{64}$/);
        expect(writtenDoc.bodyLength).toBeGreaterThan(0);
    });

    // ── Test 3: authorization header maskelenir ─────────────────────────────

    test('maskHeaders_authorization_maskeli', () => {
        const masked = maskHeaders({
            'authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.xyz',
            'content-type': 'application/json',
        });
        expect(masked.authorization).toMatch(/^\*\*\*\(len=\d+\)$/);
        expect(masked.authorization).not.toContain('Bearer');
        expect(masked.authorization).not.toContain('eyJ');
        expect(masked['content-type']).toBe('application/json');
    });

    // ── Test 4: Tüm hassas header'lar maskelenir ────────────────────────────

    test('maskHeaders_tum_hassas_headerlar_maskeli', () => {
        const masked = maskHeaders({
            'cookie': 'session=abc123',
            'x-api-key': 'sk_live_xyz',
            'x-auth-token': 'tok_xyz',
            'x-csrf-token': 'csrf_xyz',
        });
        expect(masked.cookie).toMatch(/\*\*\*/);
        expect(masked['x-api-key']).toMatch(/\*\*\*/);
        expect(masked['x-auth-token']).toMatch(/\*\*\*/);
        expect(masked['x-csrf-token']).toMatch(/\*\*\*/);
    });

    // ── Test 5: sha256Hex deterministik ─────────────────────────────────────

    test('sha256Hex_deterministic', () => {
        const h1 = sha256Hex({ orderId: 'YS-1', total: 100 });
        const h2 = sha256Hex({ orderId: 'YS-1', total: 100 });
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    // ── Test 6: Farklı body → farklı hash ───────────────────────────────────

    test('sha256Hex_farkli_body_farkli_hash', () => {
        const h1 = sha256Hex({ orderId: 'YS-1' });
        const h2 = sha256Hex({ orderId: 'YS-2' });
        expect(h1).not.toBe(h2);
    });

    // ── Test 7: buildDocId — iki çağrı farklı doc-id ────────────────────────

    test('buildDocId_unique', () => {
        const id1 = buildDocId('yemeksepeti');
        const id2 = buildDocId('yemeksepeti');
        // Aynı millisaniyede olsa bile random suffix farklı.
        expect(id1).not.toBe(id2);
        expect(id1).toMatch(/^yemeksepeti_\d+_[a-z0-9]+$/);
    });

    // ── Test 8: Firestore hata fırlatırsa fail-soft ─────────────────────────

    test('recordRequest_Firestore_hata_intake_bozmaz', async () => {
        mockSet.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));

        const result = await auditor.recordRequest({
            platform: 'trendyolgo',
            req: { method: 'POST', path: '/webhook/trendyolgo/order', headers: {}, ip: '1.2.3.4' },
            body: { orderId: 'TG-1' },
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('PERMISSION_DENIED');
        // Throw etmemeli.
    });

    // ── Test 9: Body kendisi YAZILMAZ, sadece hash ──────────────────────────

    test('recordRequest_body_kendisi_yazmaz', async () => {
        await auditor.recordRequest({
            platform: 'yemeksepeti',
            req: { method: 'POST', path: '/order/abc', headers: {}, ip: '1.2.3.4' },
            body: { customerPhone: '05551234567', customerAddress: 'PII ADRES' },
        });

        const writtenDoc = mockSet.mock.calls[0][0];
        // Body field YOK, sadece hash + length:
        expect(writtenDoc.body).toBeUndefined();
        expect(writtenDoc.customerPhone).toBeUndefined();
        expect(JSON.stringify(writtenDoc)).not.toContain('05551234567');
        expect(JSON.stringify(writtenDoc)).not.toContain('PII ADRES');
        expect(writtenDoc.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    });
});
