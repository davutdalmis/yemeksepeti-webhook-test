const { classify, backoffMs, maxAttempts, BACKOFF_SCHEDULE_MS } = require('../lib/RetryPolicy');

describe('RetryPolicy.classify', () => {
    test('network error -> retryable', () => {
        const e = new Error('econnreset');
        e.code = 'ECONNRESET';
        expect(classify(e)).toMatchObject({ retryable: true, kind: 'network', authError: false });
    });

    test('401 -> retryable + authError', () => {
        expect(classify({ status: 401 })).toMatchObject({ retryable: true, kind: 'auth', authError: true });
    });

    test('403 -> auth', () => {
        expect(classify({ status: 403 })).toMatchObject({ retryable: true, kind: 'auth', authError: true });
    });

    test('429 -> retryable rate_limit', () => {
        expect(classify({ status: 429 })).toMatchObject({ retryable: true, kind: 'rate_limit' });
    });

    test('429 with Retry-After -> retryAfterMs', () => {
        const e = { status: 429, response: { headers: { 'retry-after': '5' } } };
        expect(classify(e).retryAfterMs).toBe(5000);
    });

    test('500 -> retryable server', () => {
        expect(classify({ status: 500 })).toMatchObject({ retryable: true, kind: 'server' });
    });

    test('400 -> permanent validation', () => {
        expect(classify({ status: 400 })).toMatchObject({ retryable: false, kind: 'validation' });
    });

    test('404 -> permanent', () => {
        expect(classify({ status: 404 })).toMatchObject({ retryable: false });
    });

    test('null err -> not retryable', () => {
        expect(classify(null)).toMatchObject({ retryable: false });
    });
});

describe('RetryPolicy.backoffMs', () => {
    test('returns schedule values', () => {
        expect(backoffMs(1)).toBe(BACKOFF_SCHEDULE_MS[0]);
        expect(backoffMs(2)).toBe(BACKOFF_SCHEDULE_MS[1]);
        expect(backoffMs(3)).toBe(BACKOFF_SCHEDULE_MS[2]);
    });

    test('clamps to last value', () => {
        expect(backoffMs(99)).toBe(BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]);
    });

    test('clamps to first value', () => {
        expect(backoffMs(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
    });

    test('maxAttempts matches schedule length', () => {
        expect(maxAttempts()).toBe(BACKOFF_SCHEDULE_MS.length);
    });
});
