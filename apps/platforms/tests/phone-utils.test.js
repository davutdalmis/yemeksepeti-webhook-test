const { normalizeTurkishPhone, isValidTurkishMobile } = require('../services/otp/phone-utils');

describe('normalizeTurkishPhone', () => {
    test('+90 prefix korunur', () => {
        expect(normalizeTurkishPhone('+905320563400')).toBe('+905320563400');
    });

    test('905... formatı', () => {
        expect(normalizeTurkishPhone('905320563400')).toBe('+905320563400');
    });

    test('05... formatı', () => {
        expect(normalizeTurkishPhone('05320563400')).toBe('+905320563400');
    });

    test('5... formatı', () => {
        expect(normalizeTurkishPhone('5320563400')).toBe('+905320563400');
    });

    test('0090... uluslararası prefix', () => {
        expect(normalizeTurkishPhone('00905320563400')).toBe('+905320563400');
    });

    test('boşluk ve tire temizlenir', () => {
        expect(normalizeTurkishPhone('0532 056 34 00')).toBe('+905320563400');
        expect(normalizeTurkishPhone('+90 532-056-34-00')).toBe('+905320563400');
    });

    test('geçersiz girdiler null döner', () => {
        expect(normalizeTurkishPhone('')).toBeNull();
        expect(normalizeTurkishPhone(null)).toBeNull();
        expect(normalizeTurkishPhone(undefined)).toBeNull();
        expect(normalizeTurkishPhone('12345')).toBeNull();
        expect(normalizeTurkishPhone('05320563400000')).toBeNull();
        expect(normalizeTurkishPhone('0212456789')).toBeNull(); // sabit hat (5 ile başlamıyor)
        expect(normalizeTurkishPhone('abcdefghij')).toBeNull();
    });

    test('isValidTurkishMobile', () => {
        expect(isValidTurkishMobile('05320563400')).toBe(true);
        expect(isValidTurkishMobile('0212456789')).toBe(false);
    });
});
