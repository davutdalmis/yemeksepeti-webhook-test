// ==================================================================================
// platform-webhook-auth
//
// Inbound platform webhook (YemekSepeti / GetirYemek / TrendyolGo / Fuudy) paylaşımlı
// token kimlik doğrulaması — sahte sipariş enjeksiyonuna karşı.
//
// Neden: Platformlar per-sipariş secret göndermiyor; şubeyi yönlendiren `branchId` gizli
// değil (Firestore belge kimliği, herkese açık okunuyor). Kimlik gate'i olmadan branchId
// bilen biri sahte sipariş POST edebiliyor. Çözüm: callback URL'sine paylaşımlı token koy
// (?whk=<TOKEN> veya x-webhook-token header). Migros'taki authenticateMigrosWebhook ile aynı ruh.
//
// Karar saf fonksiyon olarak buraya çıkarıldı ki server-v4.js'i ayağa kaldırmadan test edilsin.
// ==================================================================================

const crypto = require('crypto');

// Timing-safe string karşılaştırma (server-v4.js'deki ile aynı davranış; modül bağımsız kalsın diye kopyalı)
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Uzunluk farklıysa bile sabit sürede karşılaştır (bilgi sızdırmamak için)
        const padded = Buffer.alloc(bufA.length);
        bufB.copy(padded, 0, 0, Math.min(bufB.length, padded.length));
        crypto.timingSafeEqual(bufA, padded);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// İstek path'inden platform tahmini (audit + enforce kararı için).
function platformFromPath(path) {
    const p = path || '';
    if (p.startsWith('/order/')) return 'yemeksepeti';
    if (p === '/webhook/newOrder' || p === '/webhook/cancelOrder' ||
        p === '/webhook/courierArrival' || p === '/webhook/restaurantStatus') return 'getiryemek';
    if (p.startsWith('/webhook/trendyolgo')) return 'trendyolgo';
    if (p.startsWith('/webhook/fuudy')) return 'fuudy';
    return 'unknown';
}

/**
 * Token kararını verir. Yan etkisiz.
 * @param {object} p
 * @param {string|null} p.providedToken  İstekten okunan token (header veya query)
 * @param {string[]} p.tokenSet          Geçerli token(lar) — parseKeySet çıktısı (rotasyon için çoklu)
 * @param {string} p.platform            'yemeksepeti' | 'getiryemek' | 'trendyolgo' | 'fuudy' | 'unknown'
 * @param {Set<string>} p.enforceSet     Reddedecek platformlar (küçük harf); 'all' hepsini kapsar
 * @returns {{active:boolean, allow:boolean, matched:(boolean|null), enforcing:boolean, platform:string}}
 *   active=false → token yapılandırılmamış, kimlik doğrulama devre dışı (tam geriye uyumlu).
 *   allow=false  → istek reddedilmeli (401).
 */
function evaluateWebhookToken({ providedToken, tokenSet, platform, enforceSet }) {
    if (!Array.isArray(tokenSet) || tokenSet.length === 0) {
        // Token env boş → hiçbir değişiklik: bugünkü davranış korunur.
        return { active: false, allow: true, matched: null, enforcing: false, platform };
    }
    const provided = providedToken || null;
    const matched = !!provided && tokenSet.some(k => timingSafeCompare(String(provided), String(k)));
    const set = enforceSet instanceof Set ? enforceSet : new Set();
    const enforcing = set.has(platform) || set.has('all');
    // Audit modu (enforcing=false): eşleşmese bile izin ver, yalnız görünürlük.
    const allow = matched || !enforcing;
    return { active: true, allow, matched, enforcing, platform };
}

// ── Delivery Hero (YemekSepeti) inbound webhook JWT doğrulaması ──────────────────
// DH, bize ittiği her webhook'u Authorization: Bearer <JWT> ile imzalar (HS512, DH'nin
// verdiği ortam-özel gizli anahtar) ve token'da `service: middleware` claim'i taşır
// (pluginApi.yaml MiddlewareJWTAuth). Uydurma ?whk= token yerine bu resmi mekanizmayı
// doğrularız. Bağımlılık eklememek için HS512 doğrulaması yerleşik crypto ile yapılır.

function base64urlToBuffer(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

/**
 * DH inbound webhook JWT'sini doğrular. Yan etkisiz.
 * @param {string|null} authorizationHeader  "Bearer <jwt>" başlığı
 * @param {string[]|string} secrets          DH doğrulama gizli anahtar(lar)ı (rotasyon için dizi)
 * @param {object} [opts]
 * @param {string} [opts.requiredService='middleware']  Zorunlu `service` claim değeri
 * @param {number} [opts.nowSeconds]          Test için sabit zaman (varsayılan: şimdi)
 * @param {number} [opts.clockSkewSeconds=60] exp için tolerans
 * @returns {{valid:boolean, reason:string, configured:boolean, claims?:object}}
 */
function verifyDeliveryHeroJwt(authorizationHeader, secrets, opts = {}) {
    const requiredService = opts.requiredService || 'middleware';
    const skew = typeof opts.clockSkewSeconds === 'number' ? opts.clockSkewSeconds : 60;
    const nowSeconds = typeof opts.nowSeconds === 'number' ? opts.nowSeconds : Math.floor(Date.now() / 1000);
    const secretList = (Array.isArray(secrets) ? secrets : (secrets ? [secrets] : [])).filter(Boolean);
    if (secretList.length === 0) return { valid: false, reason: 'no_secret_configured', configured: false };

    const m = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || '').trim());
    if (!m) return { valid: false, reason: 'missing_bearer', configured: true };

    const parts = m[1].trim().split('.');
    if (parts.length !== 3) return { valid: false, reason: 'malformed', configured: true };
    const [h, p, s] = parts;

    let header;
    try { header = JSON.parse(base64urlToBuffer(h).toString('utf8')); }
    catch (e) { return { valid: false, reason: 'bad_header', configured: true }; }
    // alg-confusion koruması: yalnız HS512 kabul; 'none'/RS*/ES* reddedilir.
    if (header.alg !== 'HS512') return { valid: false, reason: 'bad_alg', configured: true };

    const signingInput = `${h}.${p}`;
    const providedSig = base64urlToBuffer(s);
    const sigOk = secretList.some(secret => {
        const expected = crypto.createHmac('sha512', secret).update(signingInput).digest();
        return expected.length === providedSig.length && crypto.timingSafeEqual(expected, providedSig);
    });
    if (!sigOk) return { valid: false, reason: 'bad_signature', configured: true };

    let payload;
    try { payload = JSON.parse(base64urlToBuffer(p).toString('utf8')); }
    catch (e) { return { valid: false, reason: 'bad_payload', configured: true }; }

    if (typeof payload.exp === 'number' && payload.exp + skew < nowSeconds) {
        return { valid: false, reason: 'expired', configured: true };
    }
    if (payload.service !== requiredService) {
        return { valid: false, reason: 'bad_service_claim', configured: true };
    }
    return { valid: true, reason: 'ok', configured: true, claims: payload };
}

module.exports = { timingSafeCompare, platformFromPath, evaluateWebhookToken, verifyDeliveryHeroJwt };
