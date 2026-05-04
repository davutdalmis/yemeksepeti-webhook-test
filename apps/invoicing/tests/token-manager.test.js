const TokenManager = require('../auth/TokenManager');
const { MemoryFallback } = require('@yemigo/shared/redis-client');
const MockInvoiceProvider = require('../providers/MockInvoiceProvider');

function fakeRedisWithSetSupport() {
    const r = new MemoryFallback();
    // ioredis-style SET key value PX ms NX
    r.set = async function (key, value, ...args) {
        const flags = args.map((a) => String(a).toUpperCase());
        const isNX = flags.includes('NX');
        if (isNX && this._strings.has(key)) return null;
        this._strings.set(key, value);
        return 'OK';
    };
    return r;
}

describe('TokenManager', () => {
    test('cache miss -> calls provider.authenticate, then cache hit returns same token', async () => {
        const redis = fakeRedisWithSetSupport();
        const mock = new MockInvoiceProvider();
        const tm = new TokenManager({ redis, providerFactory: async () => mock });

        const t1 = await tm.getValidToken('tenant-A');
        expect(t1).toBe('mock-access-token');
        expect(mock.calls.authenticate).toBe(1);

        const t2 = await tm.getValidToken('tenant-A');
        expect(t2).toBe('mock-access-token');
        expect(mock.calls.authenticate).toBe(1); // still 1 — cache hit
    });

    test('different tenants get separate tokens', async () => {
        const redis = fakeRedisWithSetSupport();
        const mock = new MockInvoiceProvider({ responses: { authenticate: { accessToken: 'TOK', expiresIn: 7200 } } });
        const tm = new TokenManager({ redis, providerFactory: async () => mock });

        await tm.getValidToken('tenant-A');
        await tm.getValidToken('tenant-B');
        expect(mock.calls.authenticate).toBe(2);
    });

    test('refreshToken bypasses cache and re-authenticates', async () => {
        const redis = fakeRedisWithSetSupport();
        const mock = new MockInvoiceProvider();
        const tm = new TokenManager({ redis, providerFactory: async () => mock });

        await tm.getValidToken('tenant-A');
        await tm.refreshToken('tenant-A');
        // Will try refresh first (since prev had refreshToken), then maybe auth
        expect(mock.calls.refresh + mock.calls.authenticate).toBeGreaterThanOrEqual(2);
    });

    test('invalidateToken forces fresh auth', async () => {
        const redis = fakeRedisWithSetSupport();
        const mock = new MockInvoiceProvider();
        const tm = new TokenManager({ redis, providerFactory: async () => mock });

        await tm.getValidToken('tenant-A');
        await tm.invalidateToken('tenant-A');
        await tm.getValidToken('tenant-A');
        expect(mock.calls.authenticate + mock.calls.refresh).toBeGreaterThanOrEqual(2);
    });

    test('expired entry triggers re-auth', async () => {
        const redis = fakeRedisWithSetSupport();
        const mock = new MockInvoiceProvider({ responses: { authenticate: { accessToken: 'TOK', expiresIn: 1 } } });
        const tm = new TokenManager({ redis, providerFactory: async () => mock });

        await tm.getValidToken('tenant-A');
        // SAFETY_MARGIN_SEC=200, ttlSec=max(60, 1-200)=60. Cache says fresh for 60s. Force expire by editing cache.
        const raw = await redis.get('invoicing:parasut:tenant:tenant-A:token');
        const entry = JSON.parse(raw);
        entry.expiresAt = Date.now() - 1000;
        await redis.setex('invoicing:parasut:tenant:tenant-A:token', 60, JSON.stringify(entry));

        await tm.getValidToken('tenant-A');
        expect(mock.calls.authenticate + mock.calls.refresh).toBeGreaterThanOrEqual(2);
    });

    test('constructor validates dependencies', () => {
        expect(() => new TokenManager({})).toThrow(/redis/);
        expect(() => new TokenManager({ redis: {} })).toThrow(/providerFactory/);
    });
});
