// ==================================================================================
// OTP API — POST /api/v2/otp/send  +  POST /api/v2/otp/verify
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F2. createDelayedCallApi pattern'ı ile aynı.
//
// Bu uçlar tarayıcı/mobil istemcilerden DOĞRUDAN çağrılır → x-api-key YOK.
// Kötüye kullanım IP rate-limit + telefon başına cooldown/limit ile sınırlanır.
// ==================================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const { normalizeTurkishPhone } = require('../otp/phone-utils');

/**
 * @param {OtpService} otpService
 * @returns {express.Router}
 */
function createOtpApi(otpService) {
    const router = express.Router();

    router.use((req, res, next) => {
        if (!otpService) {
            return res.status(503).json({
                success: false,
                error: 'OtpService not initialized',
                code: 'SERVICE_UNAVAILABLE'
            });
        }
        next();
    });

    const ipLimiter = (max) => rateLimit({
        windowMs: 15 * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: 'Çok fazla istek, daha sonra deneyin', code: 'IP_RATE_LIMITED' }
    });

    router.post('/send', ipLimiter(20), sendHandler(otpService));
    router.post('/verify', ipLimiter(30), verifyHandler(otpService));

    return router;
}

function sendHandler(otpService) {
    return async (req, res) => {
        const phone = normalizeTurkishPhone((req.body || {}).phone);
        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Geçerli bir Türkiye cep telefonu numarası girin',
                code: 'INVALID_PHONE'
            });
        }

        try {
            const result = await otpService.sendOtp(phone, { ip: req.ip });
            if (!result.success) {
                const status = (result.code === 'COOLDOWN' || result.code === 'RATE_LIMITED') ? 429 : 400;
                return res.status(status).json(result);
            }
            return res.status(200).json(result);
        } catch (error) {
            console.error('[OtpApi] send error:', error.message);
            return res.status(502).json({
                success: false,
                error: 'SMS gönderilemedi, lütfen tekrar deneyin',
                code: 'SMS_SEND_FAILED'
            });
        }
    };
}

function verifyHandler(otpService) {
    return async (req, res) => {
        const { phone: rawPhone, code } = req.body || {};
        const phone = normalizeTurkishPhone(rawPhone);
        if (!phone) {
            return res.status(400).json({
                success: false,
                error: 'Geçerli bir Türkiye cep telefonu numarası girin',
                code: 'INVALID_PHONE'
            });
        }
        if (!code || !/^\d{4,8}$/.test(String(code))) {
            return res.status(400).json({
                success: false,
                error: 'Geçerli bir doğrulama kodu girin',
                code: 'INVALID_CODE_FORMAT'
            });
        }

        try {
            const result = await otpService.verifyOtp(phone, String(code));
            if (!result.success) {
                const statusByCode = {
                    NOT_FOUND: 404,
                    EXPIRED: 410,
                    TOO_MANY_ATTEMPTS: 429,
                    ALREADY_USED: 409,
                    INVALID_CODE: 401
                };
                return res.status(statusByCode[result.code] || 400).json(result);
            }
            return res.status(200).json(result);
        } catch (error) {
            console.error('[OtpApi] verify error:', error.message);
            return res.status(500).json({
                success: false,
                error: 'Doğrulama sırasında bir hata oluştu',
                code: 'VERIFY_FAILED'
            });
        }
    };
}

module.exports = createOtpApi;
module.exports.sendHandler = sendHandler;
module.exports.verifyHandler = verifyHandler;
