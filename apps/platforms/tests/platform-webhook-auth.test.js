// ==================================================================================
// platform-webhook-auth Tests
//
// Inbound platform webhook paylaşımlı token kimlik doğrulaması — sahte sipariş
// enjeksiyonu koruması. Karar tablosu: token boş (no-op) → audit modu → enforce reddi.
// ==================================================================================

const crypto = require('crypto');
const { evaluateWebhookToken, platformFromPath, timingSafeCompare, verifyDeliveryHeroJwt } =
    require('../services/platform-webhook-auth');

// ── Test yardımcıları: HS512 JWT üret (yerleşik crypto ile — gerçek doğrulamayı test eder) ──
function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt({ alg = 'HS512', payload = {}, secret = 'dh-secret', tamperSig = null }) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg }));
    const body = b64url(JSON.stringify(payload));
    const signingInput = `${header}.${body}`;
    let sig;
    if (alg === 'none') {
        sig = '';
    } else {
        const hashAlg = alg === 'HS256' ? 'sha256' : 'sha512';
        sig = b64url(crypto.createHmac(hashAlg, secret).update(signingInput).digest());
    }
    if (tamperSig !== null) sig = tamperSig;
    return `${header}.${body}.${sig}`;
}
const bearer = (t) => `Bearer ${t}`;

const TOKEN = 'sup3r-s3cret-abc';
const SET = [TOKEN];
const enforceAll = new Set(['all']);
const enforceYs = new Set(['yemeksepeti']);
const enforceNone = new Set();

describe('platformFromPath', () => {
    test('yemeksepeti /order/:remoteId', () => {
        expect(platformFromPath('/order/QgNkbMyFVgDWGqbHG1ZS')).toBe('yemeksepeti');
    });
    test('getiryemek /webhook/newOrder', () => {
        expect(platformFromPath('/webhook/newOrder')).toBe('getiryemek');
    });
    test('trendyolgo prefix', () => {
        expect(platformFromPath('/webhook/trendyolgo/cancel')).toBe('trendyolgo');
    });
    test('fuudy prefix', () => {
        expect(platformFromPath('/webhook/fuudy/order')).toBe('fuudy');
    });
    test('bilinmeyen path', () => {
        expect(platformFromPath('/health')).toBe('unknown');
        expect(platformFromPath(null)).toBe('unknown');
    });
});

describe('timingSafeCompare', () => {
    test('eşit stringler', () => expect(timingSafeCompare('abc', 'abc')).toBe(true));
    test('farklı stringler', () => expect(timingSafeCompare('abc', 'abd')).toBe(false));
    test('farklı uzunluk', () => expect(timingSafeCompare('abc', 'abcd')).toBe(false));
    test('string olmayan', () => expect(timingSafeCompare('abc', null)).toBe(false));
});

describe('evaluateWebhookToken — geriye uyumluluk (token env boş)', () => {
    test('token seti boşsa kimlik doğrulama devre dışı, izin verilir', () => {
        const d = evaluateWebhookToken({ providedToken: null, tokenSet: [], platform: 'yemeksepeti', enforceSet: enforceAll });
        expect(d).toEqual({ active: false, allow: true, matched: null, enforcing: false, platform: 'yemeksepeti' });
    });
    test('tokenSet dizi değilse de güvenli (no-op)', () => {
        const d = evaluateWebhookToken({ providedToken: 'x', tokenSet: undefined, platform: 'fuudy', enforceSet: enforceAll });
        expect(d.active).toBe(false);
        expect(d.allow).toBe(true);
    });
});

describe('evaluateWebhookToken — audit modu (token dolu, platform enforce DIŞI)', () => {
    test('yanlış token → izin verilir ama matched:false (audit log tetikler)', () => {
        const d = evaluateWebhookToken({ providedToken: 'yanlis', tokenSet: SET, platform: 'yemeksepeti', enforceSet: enforceNone });
        expect(d.active).toBe(true);
        expect(d.enforcing).toBe(false);
        expect(d.matched).toBe(false);
        expect(d.allow).toBe(true);
    });
    test('doğru token → izin, matched:true', () => {
        const d = evaluateWebhookToken({ providedToken: TOKEN, tokenSet: SET, platform: 'yemeksepeti', enforceSet: enforceNone });
        expect(d.matched).toBe(true);
        expect(d.allow).toBe(true);
    });
    test('token yok → izin (audit)', () => {
        const d = evaluateWebhookToken({ providedToken: null, tokenSet: SET, platform: 'fuudy', enforceSet: enforceNone });
        expect(d.matched).toBe(false);
        expect(d.allow).toBe(true);
    });
});

describe('evaluateWebhookToken — enforce modu (reddet)', () => {
    test('enforce=all, token yok → REDDET', () => {
        const d = evaluateWebhookToken({ providedToken: null, tokenSet: SET, platform: 'trendyolgo', enforceSet: enforceAll });
        expect(d.enforcing).toBe(true);
        expect(d.matched).toBe(false);
        expect(d.allow).toBe(false);
    });
    test('enforce=all, yanlış token → REDDET', () => {
        const d = evaluateWebhookToken({ providedToken: 'yanlis', tokenSet: SET, platform: 'getiryemek', enforceSet: enforceAll });
        expect(d.allow).toBe(false);
    });
    test('enforce=all, doğru token → izin', () => {
        const d = evaluateWebhookToken({ providedToken: TOKEN, tokenSet: SET, platform: 'getiryemek', enforceSet: enforceAll });
        expect(d.matched).toBe(true);
        expect(d.allow).toBe(true);
    });
    test('per-platform: yemeksepeti enforce, doğru token → izin; token yok → reddet', () => {
        expect(evaluateWebhookToken({ providedToken: TOKEN, tokenSet: SET, platform: 'yemeksepeti', enforceSet: enforceYs }).allow).toBe(true);
        expect(evaluateWebhookToken({ providedToken: null, tokenSet: SET, platform: 'yemeksepeti', enforceSet: enforceYs }).allow).toBe(false);
    });
    test('per-platform: yemeksepeti enforce iken fuudy hâlâ audit (izin)', () => {
        const d = evaluateWebhookToken({ providedToken: null, tokenSet: SET, platform: 'fuudy', enforceSet: enforceYs });
        expect(d.enforcing).toBe(false);
        expect(d.allow).toBe(true);
    });
});

describe('evaluateWebhookToken — anahtar rotasyonu (çoklu token)', () => {
    test('eski veya yeni token kabul edilir', () => {
        const rotSet = ['eski-token', 'yeni-token'];
        expect(evaluateWebhookToken({ providedToken: 'eski-token', tokenSet: rotSet, platform: 'yemeksepeti', enforceSet: enforceAll }).allow).toBe(true);
        expect(evaluateWebhookToken({ providedToken: 'yeni-token', tokenSet: rotSet, platform: 'yemeksepeti', enforceSet: enforceAll }).allow).toBe(true);
        expect(evaluateWebhookToken({ providedToken: 'baska', tokenSet: rotSet, platform: 'yemeksepeti', enforceSet: enforceAll }).allow).toBe(false);
    });
});

describe('verifyDeliveryHeroJwt — YemekSepeti (Delivery Hero) imza doğrulaması', () => {
    const SECRET = 'dh-issued-verification-secret';
    const NOW = 1_800_000_000; // sabit "şimdi" (deterministik exp testi)

    test('secret yapılandırılmamışsa configured:false (generic token yoluna düşer)', () => {
        const r = verifyDeliveryHeroJwt(bearer(makeJwt({ payload: { service: 'middleware' }, secret: SECRET })), []);
        expect(r).toEqual({ valid: false, reason: 'no_secret_configured', configured: false });
    });

    test('geçerli imza + service:middleware → valid', () => {
        const t = makeJwt({ payload: { service: 'middleware', exp: NOW + 300 }, secret: SECRET });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r.valid).toBe(true);
        expect(r.claims.service).toBe('middleware');
    });

    test('yanlış secret → bad_signature', () => {
        const t = makeJwt({ payload: { service: 'middleware' }, secret: 'baska-secret' });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r).toMatchObject({ valid: false, reason: 'bad_signature' });
    });

    test('alg-confusion: alg=none reddedilir', () => {
        const t = makeJwt({ alg: 'none', payload: { service: 'middleware' } });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r).toMatchObject({ valid: false, reason: 'bad_alg' });
    });

    test('alg-confusion: HS256 (farklı alg) reddedilir', () => {
        const t = makeJwt({ alg: 'HS256', payload: { service: 'middleware' }, secret: SECRET });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r).toMatchObject({ valid: false, reason: 'bad_alg' });
    });

    test('service claim yanlış/eksik → bad_service_claim', () => {
        const t1 = makeJwt({ payload: { service: 'baska' }, secret: SECRET });
        const t2 = makeJwt({ payload: { foo: 1 }, secret: SECRET });
        expect(verifyDeliveryHeroJwt(bearer(t1), [SECRET], { nowSeconds: NOW }).reason).toBe('bad_service_claim');
        expect(verifyDeliveryHeroJwt(bearer(t2), [SECRET], { nowSeconds: NOW }).reason).toBe('bad_service_claim');
    });

    test('süresi dolmuş token → expired', () => {
        const t = makeJwt({ payload: { service: 'middleware', exp: NOW - 3600 }, secret: SECRET });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r).toMatchObject({ valid: false, reason: 'expired' });
    });

    test('Bearer başlığı yok → missing_bearer', () => {
        expect(verifyDeliveryHeroJwt(null, [SECRET]).reason).toBe('missing_bearer');
        expect(verifyDeliveryHeroJwt('Basic abc', [SECRET]).reason).toBe('missing_bearer');
    });

    test('bozuk token (3 parça değil) → malformed', () => {
        expect(verifyDeliveryHeroJwt(bearer('a.b'), [SECRET]).reason).toBe('malformed');
    });

    test('secret rotasyonu: eski veya yeni secret ile imzalı token kabul edilir', () => {
        const t = makeJwt({ payload: { service: 'middleware' }, secret: 'yeni-secret' });
        const r = verifyDeliveryHeroJwt(bearer(t), ['eski-secret', 'yeni-secret'], { nowSeconds: NOW });
        expect(r.valid).toBe(true);
    });

    test('imza kurcalanmış → bad_signature', () => {
        const t = makeJwt({ payload: { service: 'middleware' }, secret: SECRET, tamperSig: b64url('kurcalanmis-imza') });
        const r = verifyDeliveryHeroJwt(bearer(t), [SECRET], { nowSeconds: NOW });
        expect(r).toMatchObject({ valid: false, reason: 'bad_signature' });
    });
});
