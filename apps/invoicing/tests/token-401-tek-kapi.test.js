// v0.4.9 — Parasut 401 tek kapisi (TokenManager.withToken) + inbox'in TokenManager'a baglanmasi.
// Canli olay 30.09: token Redis suresi dolmadan reddedildi, 401 sonrasi yalniz InvoiceWorker
// cache siliyordu -> ~2 saat her irsaliye cagrisi 401 (78/78, 80/80 hata).

const nock = require('nock');
const TokenManager = require('../auth/TokenManager');
const { runWithToken, isUnauthorizedError, FORCE_DEDUP_MS } = TokenManager;
const { MemoryFallback } = require('@yemigo/shared/redis-client');
const { InvoiceProviderError } = require('../providers/IInvoiceProvider');
const ParasutProvider = require('../providers/ParasutProvider');
const ParasutInboxProvider = require('../providers/ParasutInboxProvider');
const { ShipmentStatusSync } = require('../lib/ShipmentStatusSync');

const BASE = 'https://api.parasut.com';
const COMPANY = '692357';
const quietLog = { warn() {}, info() {}, error() {}, log() {} };

function fakeRedis() {
    const r = new MemoryFallback();
    r.set = async function (key, value, ...args) {
        const flags = args.map((a) => String(a).toUpperCase());
        if (flags.includes('NX') && this._strings.has(key)) return null;
        this._strings.set(key, value);
        return 'OK';
    };
    // MemoryFallback.setex unref'siz setTimeout kurar (7000 sn) -> jest acik kalir.
    // Sure kontrolunu TokenManager kendi expiresAt alaniyla yapiyor; timer gereksiz.
    r.setex = async function (key, _sec, value) { this._strings.set(key, value); return 'OK'; };
    return r;
}

/** Her authenticate yeni token (T1, T2, ...) verir; gecikme ile eszamanlilik penceresi acilir. */
function countingProvider({ delayMs = 20 } = {}) {
    const p = {
        providerName: 'parasut',
        authCount: 0,
        async authenticate() {
            p.authCount += 1;
            const n = p.authCount;
            await new Promise((r) => setTimeout(r, delayMs));
            return { accessToken: `T${n}`, expiresIn: 7200, refreshToken: `R${n}` };
        },
    };
    return p;
}

function make({ redis = fakeRedis(), provider = countingProvider() } = {}) {
    const tm = new TokenManager({ redis, providerFactory: async () => provider, log: quietLog });
    return { tm, provider, redis };
}

const e401 = () => new InvoiceProviderError('Unauthorized', { code: 'GET_FAILED', status: 401 });

afterAll(() => { nock.restore(); });

describe('isUnauthorizedError', () => {
    test('InvoiceProviderError.status, axios response.status ve statusCode 401 tanir; digerleri degil', () => {
        expect(isUnauthorizedError(e401())).toBe(true);
        expect(isUnauthorizedError({ response: { status: 401 } })).toBe(true);
        expect(isUnauthorizedError({ statusCode: 401 })).toBe(true);
        expect(isUnauthorizedError(new InvoiceProviderError('x', { status: 403 }))).toBe(false);
        expect(isUnauthorizedError(new InvoiceProviderError('x', { status: 500 }))).toBe(false);
        expect(isUnauthorizedError(null)).toBe(false);
    });
});

describe('TokenManager.withToken', () => {
    test('401 -> tek zorunlu yenileme -> ayni cagri basarili', async () => {
        const { tm, provider } = make();
        const seen = [];
        const r = await tm.withToken('A', async (t) => {
            seen.push(t);
            if (t === 'T1') throw e401();
            return 'ok';
        });
        expect(r).toBe('ok');
        expect(seen).toEqual(['T1', 'T2']);
        expect(provider.authCount).toBe(2); // ilk alma + tek zorunlu yenileme
        // Yeni token cache'te: sonraki cagri ek grant uretmez
        expect(await tm.getValidToken('A')).toBe('T2');
        expect(provider.authCount).toBe(2);
    });

    test('duz axios hata sekli (response.status 401) de yenilemeyi tetikler', async () => {
        const { tm } = make();
        const r = await tm.withToken('A', async (t) => {
            if (t === 'T1') { const e = new Error('Request failed with status code 401'); e.response = { status: 401 }; throw e; }
            return t;
        });
        expect(r).toBe('T2');
    });

    test('iki kez 401 -> hata yukari cikar, fn tam 2 kez cagrilir (dongu yok)', async () => {
        const { tm, provider } = make();
        let calls = 0;
        await expect(tm.withToken('A', async () => { calls += 1; throw e401(); }))
            .rejects.toMatchObject({ status: 401 });
        expect(calls).toBe(2);
        expect(provider.authCount).toBe(2);
    });

    test('401 disi hata yenileme yapmadan aynen cikar', async () => {
        const { tm, provider } = make();
        let calls = 0;
        await expect(tm.withToken('A', async () => { calls += 1; throw new InvoiceProviderError('boom', { status: 500 }); }))
            .rejects.toMatchObject({ status: 500 });
        expect(calls).toBe(1);
        expect(provider.authCount).toBe(1);
    });

    test('retryUnsafe isaretli 401 tekrar DENENMEZ (yazma sonrasi -> cift belge yok)', async () => {
        const { tm, provider } = make();
        let calls = 0;
        await expect(tm.withToken('A', async () => {
            calls += 1;
            const e = e401(); e.retryUnsafe = true; throw e;
        })).rejects.toMatchObject({ status: 401, retryUnsafe: true });
        expect(calls).toBe(1);
        expect(provider.authCount).toBe(1);
    });

    test('50 eszamanli 401 -> tek zorunlu password grant (toplam authenticate = 2)', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('A'); // T1 cache'te (canli durum: eski token)
        expect(provider.authCount).toBe(1);
        let rejected = 0;
        const results = await Promise.all(Array.from({ length: 50 }, (_, i) => tm.withToken('A', async (t) => {
            if (t === 'T1') { rejected += 1; throw e401(); }
            return `${i}:${t}`;
        })));
        expect(rejected).toBe(50);
        expect(results.every((r) => r.endsWith(':T2'))).toBe(true);
        expect(provider.authCount).toBe(2);
    });

    test('iki ayri surec (ayni Redis, ayri TokenManager) 25+25 eszamanli 401 -> yine tek grant', async () => {
        const redis = fakeRedis();
        const provider = countingProvider({ delayMs: 50 });
        const a = new TokenManager({ redis, providerFactory: async () => provider, log: quietLog });
        const b = new TokenManager({ redis, providerFactory: async () => provider, log: quietLog });
        await a.getValidToken('A'); // T1
        const fn = async (t) => { if (t === 'T1') throw e401(); return t; };
        const all = await Promise.all([
            ...Array.from({ length: 25 }, () => a.withToken('A', fn)),
            ...Array.from({ length: 25 }, () => b.withToken('A', fn)),
        ]);
        expect(new Set(all)).toEqual(new Set(['T2']));
        expect(provider.authCount).toBe(2); // kilidi alamayan surec cache'teki yeni token'i bekledi
    });
});

describe('TokenManager.refreshToken tekillestirme', () => {
    test('cache\'teki token reddedilenden farkliysa (baskasi yeniledi) yeni grant ACILMAZ', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('A');            // T1
        await tm.refreshToken('A', { rejectedToken: 'T1' }); // T2
        expect(provider.authCount).toBe(2);
        const t = await tm.refreshToken('A', { rejectedToken: 'T1' }); // gec kalan cagiran
        expect(t).toBe('T2');
        expect(provider.authCount).toBe(2);
    });

    test(`reddedilen token belirtilmezse son zorunlu yenilemeden ${FORCE_DEDUP_MS} ms icinde tekrar zorlanmaz`, async () => {
        const { tm, provider } = make();
        await tm.refreshToken('A');
        await tm.refreshToken('A');
        expect(provider.authCount).toBe(1);
    });

    test('yeni zorunlu yenilenmis token da reddedilirse (penceredeyken) grant tekrarlanmaz, hata cikar', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('A');                              // T1
        const t2 = await tm.refreshToken('A', { rejectedToken: 'T1' }); // T2
        const again = await tm.refreshToken('A', { rejectedToken: 'T2' });
        expect(again).toBe(t2);
        expect(provider.authCount).toBe(2);
    });

    test('zorunlu yenileme refresh_token DEGIL password grant kullanir', async () => {
        const redis = fakeRedis();
        let refreshCalls = 0;
        let authCalls = 0;
        const provider = {
            providerName: 'parasut',
            async authenticate() { authCalls += 1; return { accessToken: `P${authCalls}`, expiresIn: 7200, refreshToken: 'r' }; },
            async refresh() { refreshCalls += 1; return { accessToken: 'RF', expiresIn: 7200 }; },
        };
        const tm = new TokenManager({ redis, providerFactory: async () => provider, log: quietLog });
        await tm.getValidToken('A');
        const t = await tm.refreshToken('A', { rejectedToken: 'P1' });
        expect(t).toBe('P2');
        expect(refreshCalls).toBe(0);
    });
});

describe('runWithToken', () => {
    test('withToken olmayan eski/sahte tokenManager ile getValidToken + fn', async () => {
        const r = await runWithToken({ getValidToken: async () => 'tok' }, 'A', async (t) => `x:${t}`);
        expect(r).toBe('x:tok');
    });
});

describe('ShipmentStatusSync — 401 sonrasi senkron durmaz', () => {
    test('eski token reddedilince tek yenileme ile belge senkronlanir', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('T'); // T1
        const store = new Map([['a', { tenantId: 'T', documentKind: 'shipment', status: 'sent', parasutShipmentId: 'L1' }]]);
        const db = { collection: () => ({ doc: (id) => ({
            get: async () => ({ exists: store.has(id), data: () => store.get(id) }),
            update: async (u) => { store.set(id, { ...store.get(id), ...u }); },
        }) }) };
        const statusProvider = {
            getShipmentDocumentStatus: async (token) => {
                if (token === 'T1') throw e401();
                return { found: true, deleted: false, legalized: true, despatchNo: 'BR9' };
            },
        };
        const s = new ShipmentStatusSync({ db, tokenManager: tm, providerFactory: async () => statusProvider, log: quietLog, now: () => 1 });
        const r = await s.syncDocument('a', { tenantId: 'T' });
        expect(r.sync.despatchNo).toBe('BR9');
        expect(provider.authCount).toBe(2);
    });
});

describe('ParasutProvider — yazma sonrasi 401 retryUnsafe', () => {
    beforeEach(() => { nock.cleanAll(); });

    function makeParasut() {
        return new ParasutProvider({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p', companyId: COMPANY });
    }

    test('createInvoice: fatura olustu, e_archives 401 -> retryUnsafe; withToken faturayi TEKRAR olusturmaz', async () => {
        let invoicePosts = 0;
        nock(BASE).post(`/v4/${COMPANY}/sales_invoices`).query(true).times(5).reply(() => {
            invoicePosts += 1;
            return [201, { data: { id: '555', type: 'sales_invoices', attributes: { invoice_no: 'A1' } } }];
        });
        nock(BASE).post(`/v4/${COMPANY}/e_archives`).times(5).reply(401, { errors: [{ title: 'Unauthorized' }] });

        const { tm } = make();
        const p = makeParasut();
        await expect(tm.withToken('A', (token) => p.createInvoice(token, {
            contactId: '1', items: [{ productId: '9', quantity: 1, unitPrice: 10, vatRate: 20 }],
            issueDate: '2026-10-01', documentType: 'e_archive',
        }))).rejects.toMatchObject({ status: 401, retryUnsafe: true });
        expect(invoicePosts).toBe(1);
    });

    test('createInvoice: ilk POST 401 -> retryUnsafe YOK (withToken tekrar dener)', async () => {
        nock(BASE).post(`/v4/${COMPANY}/sales_invoices`).query(true).reply(401, {});
        const p = makeParasut();
        const err = await p.createInvoice('bad', { contactId: '1', items: [{ productId: '9', quantity: 1, unitPrice: 10 }] }).catch((e) => e);
        expect(err.status).toBe(401);
        expect(err.retryUnsafe).toBeUndefined();
    });

    test('ping 401 -> {ok:false, status:401} (cagiran throwIfUnauthorizedResult ile tekrar dener)', async () => {
        nock(BASE).get('/v4/me').reply(401, {});
        nock(BASE).get('/v4/companies').reply(401, {});
        const r = await makeParasut().ping('bad');
        expect(r).toMatchObject({ ok: false, status: 401 });
    });
});

describe('ParasutInboxProvider — firma basina tek token kaynagi (TokenManager)', () => {
    beforeEach(() => { nock.cleanAll(); });

    function makeInbox(tm) {
        return new ParasutInboxProvider({
            clientId: 'cid', clientSecret: 'csec', username: 'u@example.com', password: 'p',
            companyId: COMPANY, minRequestIntervalMs: 0, logger: quietLog,
            tokenManager: tm, tenantId: 'A',
            // TokenManager varken kendi grant'i CAGRILMAMALI:
            authClient: { authenticate: async () => { throw new Error('inbox kendi password grant almamali'); } },
        });
    }
    const listBody = { data: [], meta: { current_page: 1, total_pages: 1, total_count: 0, per_page: 25 } };

    test('token TokenManager\'dan alinir, /oauth/token cagrilmaz', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('A'); // T1
        let auth;
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).reply(function () {
            auth = this.req.headers.authorization;
            return [200, listBody];
        });
        await makeInbox(tm).listInboxInvoices({ pageIndex: 0, pageSize: 25 });
        expect(auth).toBe('Bearer T1');
        expect(provider.authCount).toBe(1);
    });

    test('401 -> TokenManager.refreshToken(rejectedToken) ile yenilenir, istek yeni token ile tekrarlanir', async () => {
        const { tm, provider } = make();
        await tm.getValidToken('A'); // T1
        const auths = [];
        nock(BASE).get(`/v4/${COMPANY}/e_invoices`).query(true).times(2).reply(function () {
            auths.push(this.req.headers.authorization);
            return this.req.headers.authorization === 'Bearer T1' ? [401, {}] : [200, listBody];
        });
        const spy = jest.spyOn(tm, 'refreshToken');
        await makeInbox(tm).listInboxInvoices({ pageIndex: 0, pageSize: 25 });
        expect(auths).toEqual(['Bearer T1', 'Bearer T2']);
        expect(spy).toHaveBeenCalledWith('A', { rejectedToken: 'T1' });
        expect(provider.authCount).toBe(2);
        // Inbox'un yeniledigi token ana akisla ortak: irsaliye tarafi ek grant acmaz
        expect(await tm.getValidToken('A')).toBe('T2');
    });

    test('tokenManager verilip tenantId verilmezse kurulum hatasi', () => {
        const { tm } = make();
        expect(() => new ParasutInboxProvider({
            clientId: 'c', clientSecret: 's', username: 'u', password: 'p', companyId: COMPANY, tokenManager: tm,
        })).toThrow(/tenantId/);
    });
});
