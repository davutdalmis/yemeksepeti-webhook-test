// ProductionOrderCloser — irsaliyesi onaylanan imalat siparisini gecikmeli kapatma.
// 31.08.2026 canli teshisinin testi: onay ANINDA kapatmak isi imalatin ekranindan
// gun ortasinda siler (gercek yetkili ertesi sabah ~11:00'de onayliyor, uretimden
// once), o yuzden kapanis onaydan MIN_AGE_HOURS sonra yapiliyor.

const { closeOrder, runCloseCycle, MIN_AGE_HOURS } = require('../lib/ProductionOrderCloser');

const SAAT = 60 * 60 * 1000;
const SIMDI = Date.parse('2026-09-01T12:00:00+03:00');

function makeDb({ orders = {}, docs = {} } = {}) {
    const store = new Map();
    for (const [id, v] of Object.entries(orders)) store.set('productionOrders/' + id, v);
    for (const [id, v] of Object.entries(docs)) store.set('invoiceDocuments/' + id, v);

    const ref = (name, id) => ({
        _key: name + '/' + id,
        async get() {
            const d = store.get(name + '/' + id);
            return { exists: !!d, id, data: () => d };
        },
    });

    return {
        _store: store,
        collection(name) {
            return {
                doc(id) { return ref(name, id); },
                where(field, op, val) {
                    return {
                        limit() {
                            return {
                                async get() {
                                    const docs = [];
                                    for (const [k, v] of store.entries()) {
                                        if (!k.startsWith(name + '/')) continue;
                                        const ok = op === 'in' ? val.includes(v[field]) : v[field] === val;
                                        if (ok) docs.push({ id: k.split('/')[1], data: () => v });
                                    }
                                    return { size: docs.length, docs };
                                },
                            };
                        },
                    };
                },
            };
        },
        async runTransaction(fn) {
            let wrote = false;
            const txn = {
                async get(r) {
                    if (wrote) throw new Error('reads must come before writes');
                    return r.get();
                },
                update(r, patch) {
                    wrote = true;
                    const cur = store.get(r._key);
                    if (!cur) throw new Error('update on missing doc');
                    store.set(r._key, { ...cur, ...patch });
                },
                set(r, data) { wrote = true; store.set(r._key, data); },
            };
            return fn(txn);
        },
    };
}

const sessiz = { log() {}, warn() {} };

function siparis(extra = {}) {
    return {
        tenantId: 'T1', branchId: 'B1', branchName: 'Bafetto Kartal',
        orderNumber: 'IM-2026-181640', status: 'PENDING', version: 0,
        actualDeliveryDate: null, parasutShipmentDocumentId: 'D1', ...extra,
    };
}
function irsaliye(extra = {}) {
    return {
        tenantId: 'T1', documentKind: 'shipment', status: 'sent',
        sourceType: 'productionOrder', sourceId: 'ORD1', sourceTransferNumber: 'IM-2026-181640',
        approvalMeta: { approvedAt: SIMDI - 20 * SAAT, approvedBy: 'panel:yyaL' }, ...extra,
    };
}

describe('closeOrder', () => {
    test('PENDING siparis DELIVERED olur, version artar, olay yazilir', async () => {
        const db = makeDb({ orders: { ORD1: siparis() } });
        const r = await closeOrder(db, {
            orderId: 'ORD1', tenantId: 'T1', documentId: 'D1',
            sourceLabel: 'IM-2026-181640', approvedBy: 'panel:yyaL', tsMillis: SIMDI,
        });
        expect(r).toBe('closed');

        const o = db._store.get('productionOrders/ORD1');
        expect(o.status).toBe('DELIVERED');
        expect(o.version).toBe(1);
        expect(o.closedByShipmentDocumentId).toBe('D1');
        expect(o.actualDeliveryDate).toBeTruthy();

        const olay = [...db._store.entries()].filter(([k]) => k.startsWith('productionOrderEvents/'));
        expect(olay).toHaveLength(1);
        expect(olay[0][1]).toMatchObject({
            eventType: 'STATUS_CHANGED',
            actorChannel: 'panel',
            actorUserId: 'panel:yyaL',
            fromVersion: 0,
            toVersion: 1,
        });
        expect(olay[0][1].payload).toMatchObject({
            fromStatus: 'PENDING', toStatus: 'DELIVERED', reason: 'irsaliye_onayi',
        });
    });

    test('IN_PROGRESS siparis de kapanir', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ status: 'IN_PROGRESS', version: 2 }) } });
        expect(await closeOrder(db, { orderId: 'ORD1', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI })).toBe('closed');
        expect(db._store.get('productionOrders/ORD1').version).toBe(3);
    });

    test('zaten DELIVERED ise dokunulmaz', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ status: 'DELIVERED', version: 4 }) } });
        expect(await closeOrder(db, { orderId: 'ORD1', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI })).toBe('skipped_terminal');
        expect(db._store.get('productionOrders/ORD1').version).toBe(4);
    });

    test('CANCELLED siparis dirilmez', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ status: 'CANCELLED' }) } });
        expect(await closeOrder(db, { orderId: 'ORD1', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI })).toBe('skipped_terminal');
        expect(db._store.get('productionOrders/ORD1').status).toBe('CANCELLED');
    });

    test('baska firmanin siparisine DOKUNULMAZ', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ tenantId: 'BASKA' }) } });
        expect(await closeOrder(db, { orderId: 'ORD1', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI })).toBe('skipped_tenant');
        expect(db._store.get('productionOrders/ORD1').status).toBe('PENDING');
    });

    test('siparis silinmisse patlamaz', async () => {
        const db = makeDb({});
        expect(await closeOrder(db, { orderId: 'YOK', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI })).toBe('skipped_missing');
    });

    test('mevcut actualDeliveryDate uzerine YAZILMAZ', async () => {
        const eski = 'ESKI-TARIH';
        const db = makeDb({ orders: { ORD1: siparis({ status: 'READY', actualDeliveryDate: eski }) } });
        await closeOrder(db, { orderId: 'ORD1', tenantId: 'T1', documentId: 'D1', tsMillis: SIMDI });
        expect(db._store.get('productionOrders/ORD1').actualDeliveryDate).toBe(eski);
    });
});

describe('runCloseCycle — hangi siparis kapanir', () => {
    const calistir = (db) => runCloseCycle(db, { now: SIMDI, log: sessiz });

    test(`irsaliye onaylanmis ve ${MIN_AGE_HOURS} saatten eski -> KAPANIR`, async () => {
        const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye() } });
        const r = await calistir(db);
        expect(r).toMatchObject({ scanned: 1, closed: 1, errors: 0 });
        expect(db._store.get('productionOrders/ORD1').status).toBe('DELIVERED');
    });

    test('onay TAZE ise (2 saat once) KAPANMAZ — imalat isi ekranda gorsun', async () => {
        const db = makeDb({
            orders: { ORD1: siparis() },
            docs: { D1: irsaliye({ approvalMeta: { approvedAt: SIMDI - 2 * SAAT, approvedBy: 'panel:yyaL' } }) },
        });
        const r = await calistir(db);
        expect(r.closed).toBe(0);
        expect(db._store.get('productionOrders/ORD1').status).toBe('PENDING');
    });

    test(`tam sinirda (${MIN_AGE_HOURS} saat 1 dk once) KAPANIR`, async () => {
        const db = makeDb({
            orders: { ORD1: siparis() },
            docs: { D1: irsaliye({ approvalMeta: { approvedAt: SIMDI - (MIN_AGE_HOURS * SAAT + 60000), approvedBy: 'x' } }) },
        });
        expect((await calistir(db)).closed).toBe(1);
    });

    test.each(['draft', 'pending_approval', 'cancelled', 'failed', 'approved', 'queued'])(
        "irsaliye durumu '%s' ise KAPANMAZ (yalniz 'sent' sayilir)",
        async (durum) => {
            const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye({ status: durum }) } });
            const r = await calistir(db);
            expect(r.closed).toBe(0);
            expect(db._store.get('productionOrders/ORD1').status).toBe('PENDING');
        },
    );

    test('iptal edilmis irsaliye siparisi kapatmaz — "mal cikti" demek degil', async () => {
        const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye({ status: 'cancelled' }) } });
        expect((await calistir(db)).closed).toBe(0);
    });

    test('onay zamani yoksa KAPANMAZ', async () => {
        const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye({ approvalMeta: {} }) } });
        expect((await calistir(db)).closed).toBe(0);
    });

    test('irsaliye belgesi baska firmaya aitse KAPANMAZ', async () => {
        const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye({ tenantId: 'BASKA' }) } });
        expect((await calistir(db)).closed).toBe(0);
    });

    test('irsaliye baglantisi olmayan siparis KAPANMAZ', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ parasutShipmentDocumentId: null }) } });
        const r = await calistir(db);
        expect(r).toMatchObject({ scanned: 1, closed: 0, skipped: 1 });
    });

    test('belge kaybolmussa patlamaz', async () => {
        const db = makeDb({ orders: { ORD1: siparis({ parasutShipmentDocumentId: 'YOK' }) } });
        const r = await calistir(db);
        expect(r).toMatchObject({ closed: 0, errors: 0 });
    });

    test('kapanmis siparisler hic taranmaz', async () => {
        const db = makeDb({
            orders: { ORD1: siparis({ status: 'DELIVERED' }), ORD2: siparis({ status: 'CANCELLED' }) },
            docs: { D1: irsaliye() },
        });
        expect((await calistir(db)).scanned).toBe(0);
    });

    test('ayni tur iki kez kosarsa ikinci sefer hicbir sey yapmaz (idempotent)', async () => {
        const db = makeDb({ orders: { ORD1: siparis() }, docs: { D1: irsaliye() } });
        expect((await calistir(db)).closed).toBe(1);
        const ikinci = await calistir(db);
        expect(ikinci).toMatchObject({ scanned: 0, closed: 0 });
    });

    test('karisik yigin: yalniz hak edeni kapatir', async () => {
        const db = makeDb({
            orders: {
                A: siparis({ orderNumber: 'A', parasutShipmentDocumentId: 'DA' }),
                B: siparis({ orderNumber: 'B', parasutShipmentDocumentId: 'DB' }),
                C: siparis({ orderNumber: 'C', parasutShipmentDocumentId: 'DC' }),
                D: siparis({ orderNumber: 'D', parasutShipmentDocumentId: 'DD' }),
            },
            docs: {
                DA: irsaliye({ sourceId: 'A' }),                                   // sent + eski -> kapanir
                DB: irsaliye({ sourceId: 'B', status: 'draft' }),                   // taslak
                DC: irsaliye({ sourceId: 'C', status: 'cancelled' }),               // iptal
                DD: irsaliye({ sourceId: 'D', approvalMeta: { approvedAt: SIMDI - SAAT } }), // taze
            },
        });
        const r = await calistir(db);
        expect(r).toMatchObject({ scanned: 4, closed: 1, errors: 0 });
        expect(db._store.get('productionOrders/A').status).toBe('DELIVERED');
        expect(db._store.get('productionOrders/B').status).toBe('PENDING');
        expect(db._store.get('productionOrders/C').status).toBe('PENDING');
        expect(db._store.get('productionOrders/D').status).toBe('PENDING');
    });
});
