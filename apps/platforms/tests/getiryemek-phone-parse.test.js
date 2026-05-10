// GY müşteri telefonu santral + extension parse testleri
// Express APK auto-dial DTMF için CustomerPhoneClean + CustomerPhoneExtension yazılıyor

const GetirYemekConnector = require('../services/platforms/connectors/getiryemek-connector');

// Mock db ve registry — connector base class transformOrder için bunlara ihtiyaç duymuyor
const mockDb = {};
const mockRegistry = {};

function makeConnector() {
    return new GetirYemekConnector(mockDb, mockRegistry);
}

function build(rawClient) {
    const conn = makeConnector();
    return conn.transformOrder({ id: 'order-1', client: rawClient }, 'branch-1');
}

describe('GetirYemek phone parse — santral + extension', () => {
    test('GY standart format: "+90 (850) 000-00000 / 1234"', () => {
        const out = build({
            name: 'Ahmet Yilmaz',
            clientPhoneNumber: '+90 (850) 000-00000 / 1234'
        });
        expect(out.CustomerPhoneClean).toBe('+9085000000000');
        expect(out.CustomerPhoneExtension).toBe('1234');
        expect(out.CustomerPhoneRaw).toBe('+90 (850) 000-00000 / 1234');
        expect(out.CustomerPhone).toBe('+90 (850) 000-00000 / 1234');
    });

    test('Sadece santral, extension yok', () => {
        const out = build({
            name: 'Ayse',
            clientPhoneNumber: '08504559050'
        });
        expect(out.CustomerPhoneClean).toBe('08504559050');
        expect(out.CustomerPhoneExtension).toBe('');
        expect(out.CustomerPhoneRaw).toBe('08504559050');
    });

    test('Bos string', () => {
        const out = build({ name: 'Mehmet', clientPhoneNumber: '' });
        expect(out.CustomerPhoneClean).toBe('');
        expect(out.CustomerPhoneExtension).toBe('');
        expect(out.CustomerPhoneRaw).toBe('');
    });

    test('Whitespace ve fazla bosluklar', () => {
        const out = build({
            name: 'Test',
            clientPhoneNumber: '  +90 (850) 000-00000   /   555111  '
        });
        expect(out.CustomerPhoneClean).toBe('+9085000000000');
        expect(out.CustomerPhoneExtension).toBe('555111');
    });

    test('clientPhoneNumber yoksa maskedPhoneNumber fallback', () => {
        const out = build({
            name: 'Fallback',
            maskedPhoneNumber: '08504559050 / 9999'
        });
        expect(out.CustomerPhoneClean).toBe('08504559050');
        expect(out.CustomerPhoneExtension).toBe('9999');
        expect(out.CustomerPhoneRaw).toBe('08504559050 / 9999');
    });

    test('Hicbir field yoksa hepsi bos', () => {
        const out = build({ name: 'Empty' });
        expect(out.CustomerPhoneClean).toBe('');
        expect(out.CustomerPhoneExtension).toBe('');
        expect(out.CustomerPhoneRaw).toBe('');
    });

    test('Garip karakterler (harfler) — extension regex eslesmez, fallback', () => {
        const out = build({
            name: 'Weird',
            clientPhoneNumber: '0850abc / 1234'
        });
        // Santral kisminda harf var → ilk regex eslesmez, fallback main = cleanPhone(raw)
        // cleanPhone tum non-digit/+ atar → "0850" + "1234" birlesir? Hayir, raw "0850abc / 1234" olarak kalir
        // Beklenti: regex ile "0850abc" santral kismi eslesmez (harfli), "/" var ama regex acceptetmez
        // → fallback: main = cleanPhone("0850abc / 1234") = "08501234"
        expect(out.CustomerPhoneClean).toBe('08501234');
        expect(out.CustomerPhoneExtension).toBe('');
    });

    test('Multi-slash (extension olarak son rakam grubu degil — regex sade tut)', () => {
        const out = build({
            name: 'MultiSlash',
            clientPhoneNumber: '0850/123/456'
        });
        // Regex tek "/" beklediginden eslesmez → fallback cleanPhone
        expect(out.CustomerPhoneClean).toBe('0850123456');
        expect(out.CustomerPhoneExtension).toBe('');
    });
});
