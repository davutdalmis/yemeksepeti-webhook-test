// ==================================================================================
// SMS PROVIDER - Tüm SMS sağlayıcıları için abstract base class
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F2 — sağlayıcı-agnostik OTP altyapısı.
// Yeni sağlayıcı (Netgsm, İleti Merkezi) eklemek için bu sınıfı extend et.
// ==================================================================================

class SmsProvider {
    constructor(config = {}) {
        this.config = config;
    }

    // ==================== ABSTRACT (Override edilmeli) ====================

    // Sağlayıcı kimliği — log/metric için (örn: 'twilio', 'netgsm')
    get name() {
        throw new Error('name getter must be implemented by subclass');
    }

    // Tek bir SMS gönder. Başarıda { sid, status } döner, hata fırlatır.
    async sendSms(toPhone, body) {
        throw new Error('sendSms() must be implemented by subclass');
    }
}

module.exports = SmsProvider;
