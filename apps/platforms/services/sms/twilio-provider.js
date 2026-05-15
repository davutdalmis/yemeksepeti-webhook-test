// ==================================================================================
// TWILIO SMS PROVIDER
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F2 — geçici sağlayıcı (Netgsm onayına kadar).
// Gönderen Twilio US numarası; Türkiye operatörü gönderen başlığını yeniden yazar.
// ==================================================================================

const SmsProvider = require('./sms-provider');

class TwilioProvider extends SmsProvider {
    constructor(config = {}) {
        super(config);

        const accountSid = config.accountSid || process.env.TWILIO_ACCOUNT_SID;
        const authToken = config.authToken || process.env.TWILIO_AUTH_TOKEN;
        this.fromNumber = config.fromNumber || process.env.TWILIO_FROM_NUMBER;

        if (!accountSid || !authToken || !this.fromNumber) {
            throw new Error('TwilioProvider requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN ve TWILIO_FROM_NUMBER');
        }

        // Test enjeksiyonu için client config'den verilebilir
        this.client = config.client || require('twilio')(accountSid, authToken);
    }

    get name() {
        return 'twilio';
    }

    async sendSms(toPhone, body) {
        const message = await this.client.messages.create({
            to: toPhone,
            from: this.fromNumber,
            body
        });
        return { sid: message.sid, status: message.status };
    }
}

module.exports = TwilioProvider;
