// ==================================================================================
// PHONE UTILS - Türkiye telefon numarası normalizasyonu
// ==================================================================================
// SMS_BRANDING_MIGRATION_PLAN.md F2 — 5 platformda kopyalanmış normalizasyon
// mantığı burada tek noktada toplanır. Tüm varyantları E.164'e indirger:
//   +905XXXXXXXXX / 905XXXXXXXXX / 05XXXXXXXXX / 5XXXXXXXXX / 00905XXXXXXXXX
// ==================================================================================

// Girdiyi kanonik E.164 Türkiye cep formatına çevirir: +905XXXXXXXXX
// Geçersizse null döner.
function normalizeTurkishPhone(input) {
    if (!input || typeof input !== 'string') return null;

    let digits = input.replace(/\D/g, '');
    if (!digits) return null;

    if (digits.startsWith('0090')) {
        digits = digits.slice(4);
    } else if (digits.startsWith('90') && digits.length === 12) {
        digits = digits.slice(2);
    } else if (digits.startsWith('0') && digits.length === 11) {
        digits = digits.slice(1);
    }

    // Bu noktada 5 ile başlayan 10 hane beklenir
    if (digits.length !== 10 || digits[0] !== '5') return null;

    return '+90' + digits;
}

function isValidTurkishMobile(input) {
    return normalizeTurkishPhone(input) !== null;
}

module.exports = { normalizeTurkishPhone, isValidTurkishMobile };
