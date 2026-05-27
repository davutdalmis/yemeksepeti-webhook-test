// ==================================================================================
// WEBHOOK SIGNATURE AUDITOR — Discovery Mode
// ==================================================================================
// 2026-05-27 (WPF Resilience İş 4-A):
// YS ve TG platform webhook'larında gelen header'ları (maskelenmiş) ve body hash'i
// `webhookSignatureAudit` Firestore koleksiyonuna yazar. Davut audit doc'larına bakıp
// hangi header'ın imzayı taşıdığını + hangi pattern'i kullandığını öğrenir.
//
// **Sıfır enforce — HİÇBİR webhook 401 dönmez.** Bu modül `next()` çağrısını
// etkilemez. Yalnızca audit verisi toplar.
//
// Garantiler:
//   - Default-off: WEBHOOK_SIGNATURE_DISCOVERY_ENABLED=true olmadıkça hiçbir şey yazmaz.
//   - PII koruma: body kendisi YAZILMAZ (sadece SHA256 hash). authorization/cookie/
//     x-api-key/x-auth-token/proxy-authorization/x-csrf-token header'ları maskelenir.
//   - Fail-soft: audit yazımı fail olsa bile webhook akışı bozulmaz.
//   - Yalnızca YS+TG için çağrılır (caller server-v4.js path tabanlı filtreler).
// ==================================================================================

const crypto = require('crypto');
const { db } = require('@yemigo/shared/firestore-admin');

const COLLECTION = 'webhookSignatureAudit';

// Hassas header'lar — maskelenir (sadece uzunluk yazılır).
const SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'x-api-key',
    'x-auth-token',
    'proxy-authorization',
    'x-csrf-token',
]);

// Her header değeri için maksimum karakter cap (storage + log şişmesi koruması).
const MAX_HEADER_VALUE_LENGTH = 500;

function maskHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [key, val] of Object.entries(headers)) {
        const lk = String(key).toLowerCase();
        if (SENSITIVE_HEADERS.has(lk)) {
            out[lk] = `***(len=${String(val == null ? '' : val).length})`;
        } else {
            out[lk] = String(val == null ? '' : val).slice(0, MAX_HEADER_VALUE_LENGTH);
        }
    }
    return out;
}

function sha256Hex(input) {
    try {
        const text = typeof input === 'string' ? input : JSON.stringify(input || {});
        return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');
    } catch (e) {
        return null;
    }
}

function buildDocId(platform) {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const safePlatform = String(platform || 'unknown')
        .replace(/[\/\#\?\[\]]/g, '_')
        .slice(0, 30);
    return `${safePlatform}_${ts}_${rand}`;
}

async function recordRequest({ platform, req, body } = {}) {
    // Default-off — flag explicitly "true" olmalı.
    if (process.env.WEBHOOK_SIGNATURE_DISCOVERY_ENABLED !== 'true') {
        return { skipped: true, reason: 'flag_off' };
    }

    if (!req) {
        return { skipped: true, reason: 'no_request' };
    }

    try {
        const docId = buildDocId(platform);
        const bodyText = typeof body === 'string' ? body : JSON.stringify(body || {});

        await db.collection(COLLECTION).doc(docId).set({
            platform: platform || 'unknown',
            timestamp: new Date().toISOString(),
            method: req.method || '',
            path: String(req.path || req.url || '').slice(0, 200),
            remoteIp: req.ip || '',
            xff: (req.headers && req.headers['x-forwarded-for']) || '',
            headers: maskHeaders(req.headers),
            bodyHash: sha256Hex(bodyText),
            bodyLength: Buffer.byteLength(bodyText || ''),
            // Aşama A (Discovery) — sadece veri toplama.
            // Aşama B (Compute) bu doc'a sonradan signatureProvided, signatureComputed,
            // status alanlarını ekleyecek. Şu an boş.
        });

        return { success: true, docId };
    } catch (writeErr) {
        // Fail-soft: collector da fail olursa webhook akışını bozma.
        console.error('[WebhookSignatureAuditor] Audit yazımı başarısız:', writeErr.message);
        return { success: false, reason: writeErr.message };
    }
}

module.exports = {
    recordRequest,
    COLLECTION,
    // Test için iç fonksiyonları aç:
    _internals: {
        maskHeaders,
        sha256Hex,
        buildDocId,
        SENSITIVE_HEADERS,
        MAX_HEADER_VALUE_LENGTH,
    },
};
