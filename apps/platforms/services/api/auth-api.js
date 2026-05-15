// ==================================================================================
// AUTH API — POST /api/v2/auth/phone-signin
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F3.
//
// OTP servisinden alınan verificationToken'ı Firebase Custom Token'a çevirir.
// Akış: istemci /otp/verify → verificationToken → buraya → customToken →
//        istemci signInWithCustomToken(auth, customToken).
//
// Üretilen Firebase kullanıcısının phoneNumber alanı set edilir; böylece
// platformların mevcut "firebaseUser.phoneNumber ile kullanıcı bul" akışı
// (panel onAuthStateChanged, vb.) DEĞİŞMEDEN çalışır. Mevcut telefon-auth
// kullanıcısı varsa uid'i korunur — kimlik bozulmaz.
// ==================================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');

/**
 * @param {OtpService} otpService
 * @param {import('firebase-admin').auth.Auth} firebaseAuth - admin.auth()
 * @returns {express.Router}
 */
function createAuthApi(otpService, firebaseAuth) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!otpService || !firebaseAuth) {
            return res.status(503).json({
                success: false,
                error: 'Auth service not initialized',
                code: 'SERVICE_UNAVAILABLE'
            });
        }
        next();
    });

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: 'Çok fazla istek, daha sonra deneyin', code: 'IP_RATE_LIMITED' }
    });

    router.post('/phone-signin', limiter, phoneSigninHandler(otpService, firebaseAuth));

    return router;
}

function phoneSigninHandler(otpService, firebaseAuth) {
    return async (req, res) => {
        const { verificationToken } = req.body || {};
        if (!verificationToken || typeof verificationToken !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'verificationToken gerekli',
                code: 'MISSING_TOKEN'
            });
        }

        const check = otpService.verifyToken(verificationToken);
        if (!check.valid || check.payload.purpose !== 'phone_verification') {
            return res.status(401).json({
                success: false,
                error: 'Doğrulama oturumu geçersiz veya süresi dolmuş',
                code: 'INVALID_TOKEN'
            });
        }

        const phone = check.phone;
        try {
            let uid;
            try {
                const existing = await firebaseAuth.getUserByPhoneNumber(phone);
                uid = existing.uid;
            } catch (e) {
                if (e.code === 'auth/user-not-found') {
                    const created = await firebaseAuth.createUser({ phoneNumber: phone });
                    uid = created.uid;
                } else {
                    throw e;
                }
            }

            const customToken = await firebaseAuth.createCustomToken(uid);
            return res.status(200).json({ success: true, customToken });
        } catch (error) {
            console.error('[AuthApi] phone-signin error:', error.message);
            return res.status(500).json({
                success: false,
                error: 'Giriş tokeni üretilemedi',
                code: 'SIGNIN_FAILED'
            });
        }
    };
}

module.exports = createAuthApi;
module.exports.phoneSigninHandler = phoneSigninHandler;
