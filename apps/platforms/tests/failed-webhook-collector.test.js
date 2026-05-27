// ==================================================================================
// failed-webhook-collector Tests
//
// 2026-05-27 (WPF Resilience İş 3):
// DLQ collector'ın fail-soft + idempotent + truncate + flag davranışını doğrular.
// ==================================================================================

// Mock @yemigo/shared dependencies before require.
const mockSet = jest.fn().mockResolvedValue();
const mockDoc = jest.fn(() => ({ set: mockSet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

jest.mock('@yemigo/shared/firestore-admin', () => ({
    db: { collection: mockCollection },
    firebaseInitialized: true,
}));

const mockCaptureMessage = jest.fn();
jest.mock('@yemigo/shared/sentry-init', () => ({
    getSentry: jest.fn(() => ({ captureMessage: mockCaptureMessage })),
    initSentry: jest.fn(),
}));

const collector = require('../services/failed-webhook-collector');

beforeEach(() => {
    mockSet.mockClear().mockResolvedValue();
    mockDoc.mockClear();
    mockCollection.mockClear();
    mockCaptureMessage.mockClear();
    delete process.env.WEBHOOK_DLQ_ENABLED;
});

describe('failed-webhook-collector', () => {

    // ── Test 1: Basit yazım — Firestore set çağrılır ────────────────────────

    test('record_basit_yazim', async () => {
        const result = await collector.record({
            platform: 'YemekSepeti',
            remoteOrderId: 'YS-001',
            branchId: 'br-maltepe',
            rawPayload: { order: 'data' },
            transformedOrder: { OrderId: 'YS-001' },
            error: new Error('Firestore unavailable'),
        });

        expect(result.success).toBe(true);
        expect(result.docId).toMatch(/^YemekSepeti_YS-001_\d+$/);
        expect(mockCollection).toHaveBeenCalledWith('failedWebhooks');
        expect(mockSet).toHaveBeenCalledTimes(1);
        const writtenDoc = mockSet.mock.calls[0][0];
        expect(writtenDoc.platform).toBe('YemekSepeti');
        expect(writtenDoc.remoteOrderId).toBe('YS-001');
        expect(writtenDoc.branchId).toBe('br-maltepe');
        expect(writtenDoc.error.message).toBe('Firestore unavailable');
        expect(writtenDoc.status).toBe('pending_retry');
        expect(writtenDoc.retryCount).toBe(0);
    });

    // ── Test 2: Büyük payload truncate edilir ───────────────────────────────

    test('record_buyuk_payload_truncate_eder', async () => {
        const bigString = 'x'.repeat(200 * 1024);  // 200 KB
        await collector.record({
            platform: 'GetirYemek',
            remoteOrderId: 'GY-1',
            branchId: 'br-1',
            rawPayload: { big: bigString },
            transformedOrder: { OrderId: 'GY-1' },
            error: new Error('timeout'),
        });

        const writtenDoc = mockSet.mock.calls[0][0];
        expect(writtenDoc.rawPayload._truncated).toBe(true);
        expect(writtenDoc.rawPayload._originalLength).toBeGreaterThan(100 * 1024);
        expect(writtenDoc.rawPayload._preview).toHaveLength(100 * 1024);
    });

    // ── Test 3: Firestore hata fırlatırsa collector hata yutar (fail-soft) ──

    test('record_Firestore_hata_intake_bozmaz', async () => {
        mockSet.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));

        const result = await collector.record({
            platform: 'TrendyolGo',
            remoteOrderId: 'TG-1',
            branchId: 'br-1',
            rawPayload: {},
            transformedOrder: {},
            error: new Error('write failed'),
        });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('PERMISSION_DENIED');
        // Throw etmemeli — webhook akışı bozulmaz.
    });

    // ── Test 4: Env flag false → skip eder ──────────────────────────────────

    test('record_flag_kapali_skip_eder', async () => {
        process.env.WEBHOOK_DLQ_ENABLED = 'false';

        const result = await collector.record({
            platform: 'Fuudy',
            remoteOrderId: 'F-1',
            branchId: 'br-1',
            rawPayload: {},
            transformedOrder: {},
            error: new Error('test'),
        });

        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('flag_off');
        expect(mockSet).not.toHaveBeenCalled();
    });

    // ── Test 5: buildDocId — aynı orderId iki çağrı farklı doc-id ───────────

    test('buildDocId_unique_timestamp', async () => {
        await collector.record({
            platform: 'YemekSepeti', remoteOrderId: 'YS-1',
            branchId: 'br-1', rawPayload: {}, transformedOrder: {}, error: new Error('e'),
        });
        await new Promise(resolve => setTimeout(resolve, 5));  // farklı timestamp için minimum bekleme
        await collector.record({
            platform: 'YemekSepeti', remoteOrderId: 'YS-1',
            branchId: 'br-1', rawPayload: {}, transformedOrder: {}, error: new Error('e'),
        });

        const docId1 = mockDoc.mock.calls[0][0];
        const docId2 = mockDoc.mock.calls[1][0];
        expect(docId1).not.toBe(docId2);
        expect(docId1).toMatch(/^YemekSepeti_YS-1_/);
        expect(docId2).toMatch(/^YemekSepeti_YS-1_/);
    });

    // ── Test 6: buildDocId — özel karakter temizler ─────────────────────────

    test('buildDocId_special_chars_temizler', async () => {
        await collector.record({
            platform: 'MigrosYemek',
            remoteOrderId: 'abc/def#xyz[1]?2',
            branchId: 'br-1',
            rawPayload: {},
            transformedOrder: {},
            error: new Error('test'),
        });

        const docId = mockDoc.mock.calls[0][0];
        expect(docId).not.toContain('/');
        expect(docId).not.toContain('#');
        expect(docId).not.toContain('?');
        expect(docId).not.toContain('[');
        expect(docId).not.toContain(']');
        // Firestore doc-id güvenli karakterler.
    });

    // ── Test 7: Sentry capture (DSN varsa) ──────────────────────────────────

    test('record_sentry_capture_calismali', async () => {
        await collector.record({
            platform: 'YemekSepeti',
            remoteOrderId: 'YS-1',
            branchId: 'br-1',
            rawPayload: {},
            transformedOrder: {},
            error: new Error('test'),
        });

        expect(mockCaptureMessage).toHaveBeenCalledWith(
            'webhook_dlq_recorded',
            expect.objectContaining({
                level: 'warning',
                tags: expect.objectContaining({ platform: 'YemekSepeti' }),
            })
        );
    });
});
