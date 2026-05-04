const RateLimiter = require('../lib/RateLimiter');

// Minimal ZSET-supporting in-memory Redis mock
function makeFakeRedis() {
    const sets = new Map(); // key -> Map(member -> score)
    const ensure = (k) => {
        if (!sets.has(k)) sets.set(k, new Map());
        return sets.get(k);
    };
    return {
        async zadd(key, score, member) {
            ensure(key).set(member, score);
            return 1;
        },
        async zcard(key) {
            return ensure(key).size;
        },
        async zremrangebyscore(key, min, max) {
            const z = ensure(key);
            let count = 0;
            for (const [m, s] of [...z.entries()]) {
                const lo = min === '-inf' ? -Infinity : Number(min);
                const hi = max === '+inf' ? Infinity : Number(max);
                if (s >= lo && s <= hi) {
                    z.delete(m);
                    count++;
                }
            }
            return count;
        },
        async zrange(key, start, end, withScores) {
            const z = ensure(key);
            const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]);
            const slice = sorted.slice(start, end + 1);
            if (withScores === 'WITHSCORES') {
                const out = [];
                for (const [m, s] of slice) out.push(m, String(s));
                return out;
            }
            return slice.map(([m]) => m);
        },
        async expire() {
            return 1;
        },
        _sets: sets,
    };
}

describe('RateLimiter', () => {
    test('allows up to limit, then blocks', async () => {
        const redis = makeFakeRedis();
        const rl = new RateLimiter({ redis, limit: 3, windowSec: 60 });
        const r1 = await rl.tryAcquire('t1');
        const r2 = await rl.tryAcquire('t1');
        const r3 = await rl.tryAcquire('t1');
        const r4 = await rl.tryAcquire('t1');
        expect(r1.allowed).toBe(true);
        expect(r2.allowed).toBe(true);
        expect(r3.allowed).toBe(true);
        expect(r4.allowed).toBe(false);
        expect(r4.remaining).toBe(0);
        expect(r4.retryAfterMs).toBeGreaterThan(0);
    });

    test('different tenants have independent buckets', async () => {
        const redis = makeFakeRedis();
        const rl = new RateLimiter({ redis, limit: 2 });
        await rl.tryAcquire('t1');
        await rl.tryAcquire('t1');
        const blocked = await rl.tryAcquire('t1');
        const allowed = await rl.tryAcquire('t2');
        expect(blocked.allowed).toBe(false);
        expect(allowed.allowed).toBe(true);
    });

    test('expired entries get removed (window slide)', async () => {
        const redis = makeFakeRedis();
        const rl = new RateLimiter({ redis, limit: 2, windowSec: 1 });
        await rl.tryAcquire('t1');
        await rl.tryAcquire('t1');
        // Manually age out entries
        const key = 'invoicing:parasut:ratelimit:tenant:t1';
        const z = redis._sets.get(key);
        const old = Date.now() - 10000;
        for (const [m] of z) z.set(m, old);
        const after = await rl.tryAcquire('t1');
        expect(after.allowed).toBe(true);
    });

    test('constructor validates redis', () => {
        expect(() => new RateLimiter({})).toThrow(/redis/);
    });
});
