const OtpService = require('../services/otp/otp-service');

// ---------- Fakes ----------
function makeFakeDb() {
    const store = {};
    return {
        _store: store,
        collection(col) {
            return {
                doc(id) {
                    const key = `${col}/${id}`;
                    return {
                        async get() {
                            return { exists: key in store, data: () => store[key] };
                        },
                        async set(data) { store[key] = { ...data }; },
                        async update(patch) { store[key] = { ...(store[key] || {}), ...patch }; }
                    };
                }
            };
        }
    };
}

function makeFakeSms(opts = {}) {
    const sent = [];
    return {
        name: 'fake',
        sent,
        async sendSms(to, body) {
            if (opts.fail) throw new Error('SMS provider down');
            sent.push({ to, body });
            return { sid: 'SMfake', status: 'queued' };
        }
    };
}

function codeFromLastSms(sms) {
    const body = sms.sent[sms.sent.length - 1].body;
    return body.match(/(\d{6})/)[1];
}

const PHONE = '+905320563400';
const SECRET = 'test-secret-key';

function makeService({ sms, clock, config, testNumbers } = {}) {
    const db = makeFakeDb();
    const smsProvider = sms || makeFakeSms();
    let t = clock || { ms: 1_700_000_000_000 };
    const service = new OtpService({
        db, smsProvider, tokenSecret: SECRET, config, testNumbers,
        now: () => t.ms
    });
    return { db, smsProvider, service, clock: t };
}

// ---------- Constructor ----------
describe('OtpService constructor', () => {
    test('eksik bağımlılıkta hata fırlatır', () => {
        expect(() => new OtpService({})).toThrow();
        expect(() => new OtpService({ db: {}, smsProvider: {} })).toThrow(/tokenSecret/);
    });
});

// ---------- sendOtp ----------
describe('sendOtp', () => {
    test('kod üretir, SMS gönderir, Firestore yazar', async () => {
        const { service, smsProvider, db } = makeService();
        const result = await service.sendOtp(PHONE, { ip: '1.2.3.4' });

        expect(result.success).toBe(true);
        expect(result.expiresInSeconds).toBe(300);
        expect(smsProvider.sent).toHaveLength(1);
        expect(smsProvider.sent[0].to).toBe(PHONE);

        const doc = db._store[`otpVerifications/${PHONE}`];
        expect(doc).toBeDefined();
        expect(doc.consumed).toBe(false);
        expect(doc.attempts).toBe(0);
        // düz metin kod saklanmaz
        expect(JSON.stringify(doc)).not.toContain(codeFromLastSms(smsProvider));
    });

    test('cooldown süresi içinde ikinci gönderim reddedilir', async () => {
        const { service, clock } = makeService();
        await service.sendOtp(PHONE);
        clock.ms += 30 * 1000; // 30 sn < 60 sn cooldown
        const result = await service.sendOtp(PHONE);

        expect(result.success).toBe(false);
        expect(result.code).toBe('COOLDOWN');
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    test('cooldown sonrası yeni gönderim kabul edilir', async () => {
        const { service, clock, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        clock.ms += 61 * 1000;
        const result = await service.sendOtp(PHONE);

        expect(result.success).toBe(true);
        expect(smsProvider.sent).toHaveLength(2);
    });

    test('pencere içinde max gönderim aşılınca RATE_LIMITED', async () => {
        const { service, clock } = makeService();
        for (let i = 0; i < 5; i++) {
            const r = await service.sendOtp(PHONE);
            expect(r.success).toBe(true);
            clock.ms += 61 * 1000;
        }
        const result = await service.sendOtp(PHONE);
        expect(result.success).toBe(false);
        expect(result.code).toBe('RATE_LIMITED');
    });

    test('SMS gönderimi başarısızsa Firestore yazılmaz', async () => {
        const sms = makeFakeSms({ fail: true });
        const { service, db } = makeService({ sms });
        await expect(service.sendOtp(PHONE)).rejects.toThrow();
        expect(db._store[`otpVerifications/${PHONE}`]).toBeUndefined();
    });
});

// ---------- verifyOtp ----------
describe('verifyOtp', () => {
    test('doğru kod → verificationToken döner ve geçerli', async () => {
        const { service, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        const code = codeFromLastSms(smsProvider);

        const result = await service.verifyOtp(PHONE, code);
        expect(result.success).toBe(true);
        expect(typeof result.verificationToken).toBe('string');

        const tok = service.verifyToken(result.verificationToken);
        expect(tok.valid).toBe(true);
        expect(tok.phone).toBe(PHONE);
    });

    test('aktif kod yoksa NOT_FOUND', async () => {
        const { service } = makeService();
        const result = await service.verifyOtp(PHONE, '123456');
        expect(result.success).toBe(false);
        expect(result.code).toBe('NOT_FOUND');
    });

    test('yanlış kod → INVALID_CODE ve attempts artar', async () => {
        const { service, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        const realCode = codeFromLastSms(smsProvider);
        const wrong = realCode === '000000' ? '111111' : '000000';

        const r1 = await service.verifyOtp(PHONE, wrong);
        expect(r1.success).toBe(false);
        expect(r1.code).toBe('INVALID_CODE');
        expect(r1.attemptsRemaining).toBe(4);
    });

    test('max yanlış deneme sonrası TOO_MANY_ATTEMPTS', async () => {
        const { service, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        const realCode = codeFromLastSms(smsProvider);
        const wrong = realCode === '000000' ? '111111' : '000000';

        for (let i = 0; i < 5; i++) {
            await service.verifyOtp(PHONE, wrong);
        }
        const result = await service.verifyOtp(PHONE, realCode);
        expect(result.success).toBe(false);
        expect(result.code).toBe('TOO_MANY_ATTEMPTS');
    });

    test('süresi dolmuş kod → EXPIRED', async () => {
        const { service, smsProvider, clock } = makeService();
        await service.sendOtp(PHONE);
        const code = codeFromLastSms(smsProvider);
        clock.ms += 6 * 60 * 1000; // 6 dk > 5 dk expiry

        const result = await service.verifyOtp(PHONE, code);
        expect(result.success).toBe(false);
        expect(result.code).toBe('EXPIRED');
    });

    test('kullanılmış kod tekrar doğrulanamaz → ALREADY_USED', async () => {
        const { service, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        const code = codeFromLastSms(smsProvider);

        await service.verifyOtp(PHONE, code);
        const result = await service.verifyOtp(PHONE, code);
        expect(result.success).toBe(false);
        expect(result.code).toBe('ALREADY_USED');
    });
});

// ---------- test numaraları (App/Play review) ----------
describe('test numbers', () => {
    const TEST_PHONE = '+905324691077';
    const TEST_CODE = '400273';

    test('test numarasına gerçek SMS gönderilmez', async () => {
        const { service, smsProvider } = makeService({ testNumbers: { [TEST_PHONE]: TEST_CODE } });
        const result = await service.sendOtp(TEST_PHONE);
        expect(result.success).toBe(true);
        expect(smsProvider.sent).toHaveLength(0);
    });

    test('test numarası sabit kod ile doğrulanır', async () => {
        const { service } = makeService({ testNumbers: { [TEST_PHONE]: TEST_CODE } });
        await service.sendOtp(TEST_PHONE);
        const result = await service.verifyOtp(TEST_PHONE, TEST_CODE);
        expect(result.success).toBe(true);
        expect(typeof result.verificationToken).toBe('string');
    });

    test('test numarası yanlış kodu reddeder', async () => {
        const { service } = makeService({ testNumbers: { [TEST_PHONE]: TEST_CODE } });
        await service.sendOtp(TEST_PHONE);
        const result = await service.verifyOtp(TEST_PHONE, '000000');
        expect(result.success).toBe(false);
        expect(result.code).toBe('INVALID_CODE');
    });

    test('test numarası cooldown muaf — arka arkaya gönderim', async () => {
        const { service } = makeService({ testNumbers: { [TEST_PHONE]: TEST_CODE } });
        await service.sendOtp(TEST_PHONE);
        const second = await service.sendOtp(TEST_PHONE);
        expect(second.success).toBe(true);
    });

    test('normal numara test listesinde değilse SMS gider', async () => {
        const { service, smsProvider } = makeService({ testNumbers: { [TEST_PHONE]: TEST_CODE } });
        await service.sendOtp(PHONE);
        expect(smsProvider.sent).toHaveLength(1);
    });
});

// ---------- verifyToken ----------
describe('verifyToken', () => {
    test('bozuk/eksik token reddedilir', () => {
        const { service } = makeService();
        expect(service.verifyToken('').valid).toBe(false);
        expect(service.verifyToken('abc').valid).toBe(false);
        expect(service.verifyToken('a.b.c').valid).toBe(false);
    });

    test('imzası değiştirilmiş token reddedilir', async () => {
        const { service, smsProvider } = makeService();
        await service.sendOtp(PHONE);
        const { verificationToken } = await service.verifyOtp(PHONE, codeFromLastSms(smsProvider));

        const [body] = verificationToken.split('.');
        const tampered = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
        expect(service.verifyToken(tampered).valid).toBe(false);
    });

    test('süresi dolmuş token reddedilir', async () => {
        const { service, smsProvider, clock } = makeService();
        await service.sendOtp(PHONE);
        const { verificationToken } = await service.verifyOtp(PHONE, codeFromLastSms(smsProvider));

        clock.ms += 11 * 60 * 1000; // 11 dk > 10 dk TTL
        const tok = service.verifyToken(verificationToken);
        expect(tok.valid).toBe(false);
        expect(tok.error).toBe('expired');
    });
});
