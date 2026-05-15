// ==================================================================================
// OTP SERVICE - Telefon doğrulama kodu üretimi, saklama, doğrulama
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F2.
//
// Akış:
//   sendOtp(phone)   → kod üret, SMS gönder, Firestore'a yaz
//   verifyOtp(phone) → kodu kontrol et, başarıda imzalı verificationToken döndür
//
// verificationToken (HMAC-SHA256 imzalı, kısa ömürlü) "bu telefon numarasının
// sahipliği şu anda doğrulandı" kanıtıdır. F3'te her platform bu token'ı kendi
// kullanıcı koleksiyonunda çözümleyip Firebase Custom Token'a çevirir.
//
// - OTP kodları Firestore'da SADECE hash olarak saklanır (düz metin yok).
// - Doc id = normalize telefon → her numaranın tek aktif kodu olur.
// ==================================================================================

const crypto = require('crypto');

const DEFAULTS = {
    collectionName: 'otpVerifications',
    codeLength: 6,
    expirySeconds: 5 * 60,          // kodun geçerlilik süresi
    resendCooldownSeconds: 60,      // iki gönderim arası min bekleme
    maxSendsPerWindow: 5,           // pencere içinde max gönderim
    sendWindowSeconds: 60 * 60,     // gönderim sayım penceresi
    maxVerifyAttempts: 5,           // max yanlış kod denemesi
    verificationTokenTtlSeconds: 10 * 60
};

class OtpService {
    constructor({ db, smsProvider, tokenSecret, config = {}, now, testNumbers = {} } = {}) {
        if (!db) throw new Error('OtpService requires a Firestore db instance');
        if (!smsProvider) throw new Error('OtpService requires an smsProvider');
        if (!tokenSecret) throw new Error('OtpService requires a tokenSecret');

        this.db = db;
        this.smsProvider = smsProvider;
        this.tokenSecret = tokenSecret;
        this.config = { ...DEFAULTS, ...config };
        this._now = now || (() => Date.now()); // test enjeksiyonu için
        // App Store / Play Store inceleme ekibi için sabit-kodlu test numaraları.
        // { '+905XXXXXXXXX': '123456' } — bu numaralara gerçek SMS gönderilmez.
        this.testNumbers = testNumbers;
    }

    _collection() {
        return this.db.collection(this.config.collectionName);
    }

    _generateCode() {
        const max = 10 ** this.config.codeLength;
        return String(crypto.randomInt(0, max)).padStart(this.config.codeLength, '0');
    }

    _hashCode(phone, code) {
        return crypto.createHmac('sha256', this.tokenSecret)
            .update(`${phone}:${code}`)
            .digest('hex');
    }

    async sendOtp(phone, { ip } = {}) {
        const nowMs = this._now();

        // Test numarası: gerçek SMS gönderilmez, sabit kod saklanır.
        // App Store / Play Store inceleme girişleri için. Cooldown/rate-limit muaf.
        const testCode = this.testNumbers[phone];
        if (testCode) {
            await this._collection().doc(phone).set({
                phone,
                codeHash: this._hashCode(phone, String(testCode)),
                expiresAtMs: nowMs + this.config.expirySeconds * 1000,
                createdAtMs: nowMs,
                lastSentAtMs: nowMs,
                windowStartMs: nowMs,
                sendCount: 1,
                attempts: 0,
                consumed: false,
                requestIp: ip || null,
                isTestNumber: true
            });
            return {
                success: true,
                expiresInSeconds: this.config.expirySeconds,
                resendAvailableInSeconds: 0,
                sendsRemaining: this.config.maxSendsPerWindow
            };
        }

        const ref = this._collection().doc(phone);
        const snap = await ref.get();
        const existing = snap.exists ? snap.data() : null;

        // Cooldown: iki gönderim arası
        if (existing && existing.lastSentAtMs) {
            const elapsed = nowMs - existing.lastSentAtMs;
            const cooldownMs = this.config.resendCooldownSeconds * 1000;
            if (elapsed < cooldownMs) {
                return {
                    success: false,
                    code: 'COOLDOWN',
                    error: 'Yeni kod istemek için biraz bekleyin',
                    retryAfterSeconds: Math.ceil((cooldownMs - elapsed) / 1000)
                };
            }
        }

        // Pencere içi gönderim sayısı
        let sendCount = 1;
        let windowStartMs = nowMs;
        if (existing && existing.windowStartMs &&
            (nowMs - existing.windowStartMs) < this.config.sendWindowSeconds * 1000) {
            sendCount = (existing.sendCount || 0) + 1;
            windowStartMs = existing.windowStartMs;
            if (sendCount > this.config.maxSendsPerWindow) {
                return {
                    success: false,
                    code: 'RATE_LIMITED',
                    error: 'Saatlik kod isteği limitine ulaşıldı, daha sonra tekrar deneyin'
                };
            }
        }

        const otpCode = this._generateCode();
        const minutes = Math.round(this.config.expirySeconds / 60);
        const body = `Yemigo dogrulama kodunuz: ${otpCode}. Kod ${minutes} dakika gecerli.`;

        // SMS önce gönderilir; başarısızsa Firestore'a yazılmaz (hata fırlatır)
        await this.smsProvider.sendSms(phone, body);

        await ref.set({
            phone,
            codeHash: this._hashCode(phone, otpCode),
            expiresAtMs: nowMs + this.config.expirySeconds * 1000,
            createdAtMs: nowMs,
            lastSentAtMs: nowMs,
            windowStartMs,
            sendCount,
            attempts: 0,
            consumed: false,
            requestIp: ip || null
        });

        return {
            success: true,
            expiresInSeconds: this.config.expirySeconds,
            resendAvailableInSeconds: this.config.resendCooldownSeconds,
            sendsRemaining: this.config.maxSendsPerWindow - sendCount
        };
    }

    async verifyOtp(phone, code) {
        const nowMs = this._now();
        const ref = this._collection().doc(phone);
        const snap = await ref.get();

        if (!snap.exists) {
            return { success: false, code: 'NOT_FOUND', error: 'Bu numara için aktif kod yok' };
        }
        const data = snap.data();

        if (data.consumed) {
            return { success: false, code: 'ALREADY_USED', error: 'Bu kod zaten kullanıldı' };
        }
        if (nowMs > data.expiresAtMs) {
            return { success: false, code: 'EXPIRED', error: 'Kodun süresi doldu, yeni kod isteyin' };
        }
        if ((data.attempts || 0) >= this.config.maxVerifyAttempts) {
            return { success: false, code: 'TOO_MANY_ATTEMPTS', error: 'Çok fazla yanlış deneme, yeni kod isteyin' };
        }

        const expected = this._hashCode(phone, String(code));
        const match = expected.length === (data.codeHash || '').length &&
            crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(data.codeHash));

        if (!match) {
            const attempts = (data.attempts || 0) + 1;
            await ref.update({ attempts });
            return {
                success: false,
                code: 'INVALID_CODE',
                error: 'Kod hatalı',
                attemptsRemaining: Math.max(0, this.config.maxVerifyAttempts - attempts)
            };
        }

        await ref.update({ consumed: true, verifiedAtMs: nowMs });

        return {
            success: true,
            verificationToken: this._issueToken(phone, nowMs),
            expiresInSeconds: this.config.verificationTokenTtlSeconds
        };
    }

    _issueToken(phone, issuedAtMs) {
        const iat = Math.floor(issuedAtMs / 1000);
        const payload = {
            phone,
            iat,
            exp: iat + this.config.verificationTokenTtlSeconds,
            purpose: 'phone_verification'
        };
        const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const sig = crypto.createHmac('sha256', this.tokenSecret).update(body).digest('base64url');
        return `${body}.${sig}`;
    }

    // verificationToken doğrular — F3'te platform sign-in akışları çağırır.
    verifyToken(token) {
        if (!token || typeof token !== 'string' || !token.includes('.')) {
            return { valid: false, error: 'malformed' };
        }
        const [body, sig] = token.split('.');
        const expected = crypto.createHmac('sha256', this.tokenSecret).update(body).digest('base64url');
        if (expected.length !== sig.length ||
            !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
            return { valid: false, error: 'bad_signature' };
        }
        let payload;
        try {
            payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        } catch (e) {
            return { valid: false, error: 'bad_payload' };
        }
        if (Math.floor(this._now() / 1000) > payload.exp) {
            return { valid: false, error: 'expired' };
        }
        return { valid: true, phone: payload.phone, payload };
    }
}

module.exports = OtpService;
module.exports.DEFAULTS = DEFAULTS;
