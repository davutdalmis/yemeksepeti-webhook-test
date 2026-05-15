const { phoneSigninHandler } = require('../services/api/auth-api');

// ---------- Fakes ----------
function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; }
    };
}

const otpService = {
    verifyToken(token) {
        if (token === 'VALID') {
            return { valid: true, phone: '+905320563400', payload: { purpose: 'phone_verification' } };
        }
        if (token === 'WRONG_PURPOSE') {
            return { valid: true, phone: '+905320563400', payload: { purpose: 'something_else' } };
        }
        return { valid: false, error: 'bad_signature' };
    }
};

function makeAuth({ existingUid, failCreateToken } = {}) {
    const calls = { getUser: 0, createUser: 0, createCustomToken: 0 };
    return {
        calls,
        async getUserByPhoneNumber() {
            calls.getUser++;
            if (existingUid) return { uid: existingUid };
            const err = new Error('user not found');
            err.code = 'auth/user-not-found';
            throw err;
        },
        async createUser({ phoneNumber }) {
            calls.createUser++;
            return { uid: `new-uid:${phoneNumber}` };
        },
        async createCustomToken(uid) {
            calls.createCustomToken++;
            if (failCreateToken) throw new Error('mint failed');
            return `CUSTOM_TOKEN:${uid}`;
        }
    };
}

describe('phoneSigninHandler', () => {
    test('verificationToken eksikse 400', async () => {
        const res = makeRes();
        await phoneSigninHandler(otpService, makeAuth())({ body: {} }, res);
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('MISSING_TOKEN');
    });

    test('geçersiz token 401', async () => {
        const res = makeRes();
        await phoneSigninHandler(otpService, makeAuth())({ body: { verificationToken: 'GARBAGE' } }, res);
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('INVALID_TOKEN');
    });

    test('yanlış purpose 401', async () => {
        const res = makeRes();
        await phoneSigninHandler(otpService, makeAuth())({ body: { verificationToken: 'WRONG_PURPOSE' } }, res);
        expect(res.statusCode).toBe(401);
    });

    test('mevcut kullanıcı → uid korunur, createUser çağrılmaz', async () => {
        const res = makeRes();
        const auth = makeAuth({ existingUid: 'existing-uid-123' });
        await phoneSigninHandler(otpService, auth)({ body: { verificationToken: 'VALID' } }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.customToken).toBe('CUSTOM_TOKEN:existing-uid-123');
        expect(auth.calls.createUser).toBe(0);
    });

    test('kullanıcı yoksa createUser ile oluşturulur', async () => {
        const res = makeRes();
        const auth = makeAuth();
        await phoneSigninHandler(otpService, auth)({ body: { verificationToken: 'VALID' } }, res);

        expect(res.statusCode).toBe(200);
        expect(auth.calls.createUser).toBe(1);
        expect(res.body.customToken).toBe('CUSTOM_TOKEN:new-uid:+905320563400');
    });

    test('custom token üretimi hata verirse 500', async () => {
        const res = makeRes();
        const auth = makeAuth({ existingUid: 'u1', failCreateToken: true });
        await phoneSigninHandler(otpService, auth)({ body: { verificationToken: 'VALID' } }, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.code).toBe('SIGNIN_FAILED');
    });
});
