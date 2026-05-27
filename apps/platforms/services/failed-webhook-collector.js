// ==================================================================================
// FAILED WEBHOOK COLLECTOR — Webhook DLQ (Dead Letter Queue)
// ==================================================================================
// 2026-05-27 (WPF Resilience İş 3):
// Platform webhook'larında (YS/GY/TG/Fuudy/Migros) Firestore yazımı fail olduğunda
// ham payload + transformed order + error'u `failedWebhooks` Firestore koleksiyonuna
// idempotent kaydeder.
//
// Garantiler:
//   - Fail-soft: collector da fail olursa webhook akışı bozulmaz (`{ success: false }`).
//   - Idempotent doc-id: `{platform}_{orderId}_{ts}` — her fail anı izlenebilir.
//   - Env flag: WEBHOOK_DLQ_ENABLED=false → tamamen skip (acil rollback).
//   - Payload cap: 100KB (Firestore 1MB limit, 10x safety) — büyükse truncate.
//   - Sentry alarm: DSN varsa `webhook_dlq_recorded` event'i.
//
// Retry kapsam dışı: Bu iterasyonda sadece KAYIT. Cron retry + admin endpoints
// sonraki iş.
// ==================================================================================

const { db } = require('@yemigo/shared/firestore-admin');
const { getSentry } = require('@yemigo/shared/sentry-init');

const COLLECTION = 'failedWebhooks';
const MAX_PAYLOAD_BYTES = 100 * 1024;  // 100 KB

function buildDocId({ platform, remoteOrderId }) {
    const ts = Date.now();
    const safeOrderId = String(remoteOrderId || 'unknown')
        .replace(/[\/\#\?\[\]]/g, '_')
        .slice(0, 80);
    const safePlatform = String(platform || 'unknown').replace(/[\/\#\?\[\]]/g, '_').slice(0, 30);
    return `${safePlatform}_${safeOrderId}_${ts}`;
}

function safeTruncate(obj) {
    try {
        const json = JSON.stringify(obj || {});
        if (json.length <= MAX_PAYLOAD_BYTES) return obj;
        return {
            _truncated: true,
            _originalLength: json.length,
            _preview: json.slice(0, MAX_PAYLOAD_BYTES),
        };
    } catch (e) {
        return { _serializationError: e.message };
    }
}

async function record({
    platform,
    remoteOrderId,
    branchId,
    rawPayload,
    transformedOrder,
    error,
} = {}) {
    // Acil kapama: env flag false ise tamamen skip et.
    if (process.env.WEBHOOK_DLQ_ENABLED === 'false') {
        return { skipped: true, reason: 'flag_off' };
    }

    try {
        const docId = buildDocId({ platform, remoteOrderId });
        await db.collection(COLLECTION).doc(docId).set({
            platform: platform || 'unknown',
            remoteOrderId: String(remoteOrderId || ''),
            branchId: branchId || '',
            rawPayload: safeTruncate(rawPayload),
            transformedOrder: safeTruncate(transformedOrder),
            error: {
                message: (error && error.message) || String(error || 'unknown'),
                code: (error && error.code) || null,
                stack: ((error && error.stack) || '').slice(0, 2000),
            },
            status: 'pending_retry',
            retryCount: 0,
            createdAt: new Date().toISOString(),
        });

        // Sentry alarm (DSN yoksa no-op).
        try {
            const Sentry = getSentry && getSentry();
            if (Sentry && Sentry.captureMessage) {
                Sentry.captureMessage('webhook_dlq_recorded', {
                    level: 'warning',
                    tags: { webhook_dlq: 'true', platform: platform || 'unknown', branchId: branchId || '' },
                    extra: { docId, errorMessage: (error && error.message) || null },
                });
            }
        } catch (_) { /* Sentry yoksa sessiz geç */ }

        return { success: true, docId };
    } catch (writeErr) {
        // Fail-soft: collector DA fail olursa webhook akışını bozma.
        console.error('[FailedWebhookCollector] DLQ yazımı başarısız:', writeErr.message);
        return { success: false, reason: writeErr.message };
    }
}

module.exports = {
    record,
    COLLECTION,
    // Test için iç fonksiyonları aç:
    _internals: { buildDocId, safeTruncate, MAX_PAYLOAD_BYTES },
};
