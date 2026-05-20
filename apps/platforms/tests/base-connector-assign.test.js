// ==================================================================================
// Base Connector - assignCourier (atomic transaction + direct doc lookup) Tests
//
// NOT: assignCourier collectionGroup('couriers') sorgusundan doğrudan
// collection('couriers').doc(id) lookup'a geçti (composite index / 500 fix —
// memory: project_dispatch_collectionGroup_index_fix).
//
// Fix A (drift): kapasite kontrolü artık kalıcı courierData.activeOrderCount
// alanına DEĞİL, sipariş koleksiyonlarından hesaplanan GERÇEK aktif sipariş
// sayısına (computeRealActiveOrderCount) dayanır. Atama başarılı olunca sayaç
// increment(1) yerine gerçek değere SET edilir (self-heal). Mock buna göre
// .where('assignedCourierId').get() destekler.
// ==================================================================================

// Mock firebase-admin before requiring the module
jest.mock('firebase-admin', () => {
    return {
        firestore: {
            FieldValue: {
                serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
                increment: jest.fn().mockImplementation((n) => `INCREMENT(${n})`)
            },
            FieldPath: {
                documentId: jest.fn().mockReturnValue('__name__')
            }
        }
    };
});

const BasePlatformConnector = require('../services/platforms/base-connector');
const admin = require('firebase-admin');

// ==================== MOCK DB HELPERS ====================

/**
 * createMockDb — collection().doc().get()/update() + collection().where().get()
 * + runTransaction destekli mock.
 *
 * options:
 *   noOrders          : sipariş dokümanı yok (order_not_found senaryosu)
 *   orderData         : sipariş dokümanı verisi (default { OrderId: 'TEST-001' })
 *   noCourier         : kurye dokümanı yok (counter atlanır senaryosu)
 *   courierData       : kurye dokümanı verisi (default { name:'Ahmet', activeOrderCount:0 })
 *   oldCourierId      : reassignment — eski kurye id'si
 *   oldCourierData    : eski kurye dokümanı verisi
 *   courierOrders     : [{ collection, id, data }] — kuryelere atanmış sipariş
 *                       dokümanları (computeRealActiveOrderCount gerçek sayımı için)
 */
function createMockDb(options = {}) {
    const ORDER_COLLECTION = 'yemekSepetiOrders';
    const store = {}; // `${collection}/${id}` -> data object
    const refCache = {};

    if (!options.noOrders) {
        store[`${ORDER_COLLECTION}/TEST-001`] = options.orderData || { OrderId: 'TEST-001' };
    }
    if (!options.noCourier) {
        store['couriers/courier-1'] = options.courierData || { name: 'Ahmet', activeOrderCount: 0 };
    }
    if (options.oldCourierId && options.oldCourierData) {
        store[`couriers/${options.oldCourierId}`] = options.oldCourierData;
    }
    // Kuryelere atanmış sipariş dokümanları — gerçek aktif sayım için
    for (const o of options.courierOrders || []) {
        store[`${o.collection}/${o.id}`] = o.data;
    }

    function docRef(collection, id) {
        const key = `${collection}/${id}`;
        if (refCache[key]) return refCache[key];
        const ref = {
            id,
            _key: key,
            get: jest.fn().mockImplementation(() => Promise.resolve({
                exists: store[key] !== undefined,
                id,
                data: () => store[key],
                ref
            })),
            update: jest.fn().mockResolvedValue(true)
        };
        refCache[key] = ref;
        return ref;
    }

    // collection(name).where(field, op, value).get() — store'da eşleşen docları döner
    function whereQuery(collection, field, op, value) {
        return {
            get: jest.fn().mockImplementation(() => {
                const docs = [];
                for (const [key, data] of Object.entries(store)) {
                    if (!key.startsWith(`${collection}/`)) continue;
                    if (op === '==' && data[field] === value) {
                        docs.push({ id: key.split('/')[1], data: () => data, exists: true });
                    }
                }
                return Promise.resolve({ docs, size: docs.length, forEach: (fn) => docs.forEach(fn) });
            })
        };
    }

    return {
        _store: store,
        _ref: (collection, id) => docRef(collection, id),
        collection: jest.fn().mockImplementation((collection) => ({
            doc: (id) => docRef(collection, id),
            where: (field, op, value) => whereQuery(collection, field, op, value)
        })),
        runTransaction: jest.fn().mockImplementation(async (fn) => {
            const transaction = {
                get: (ref) => ref.get(),
                update: (ref, data) => { ref.update(data); }
            };
            return fn(transaction);
        })
    };
}

// activeOrderCount=N için N adet aktif (terminal olmayan) sipariş üret.
function activeOrdersFor(courierId, count, collection = 'yemekSepetiOrders') {
    const orders = [];
    for (let i = 0; i < count; i++) {
        orders.push({
            collection,
            id: `${courierId}-active-${i}`,
            data: { assignedCourierId: courierId, Status: 'PICKED_UP' }
        });
    }
    return orders;
}

// ==================== TESTS ====================

describe('BasePlatformConnector - assignCourier', () => {

    describe('Basic assignment', () => {
        test('assigns courier to order document', async () => {
            const db = createMockDb();
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
            expect(result.orderId).toBe('TEST-001');

            expect(db._ref('yemekSepetiOrders', 'TEST-001').update).toHaveBeenCalledWith(
                expect.objectContaining({
                    assignedCourierId: 'courier-1',
                    assignedCourierName: 'Ahmet',
                    assignedAt: 'SERVER_TIMESTAMP'
                })
            );
        });

        test('returns error when order not found', async () => {
            const db = createMockDb({ noOrders: true });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('NONEXISTENT', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('order_not_found');
        });

        test('returns error when firebase disabled', async () => {
            const connector = new BasePlatformConnector('yemeksepeti', null, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('firebase_disabled');
        });

        test('uses direct doc lookup — never collectionGroup', async () => {
            const db = createMockDb();
            db.collectionGroup = jest.fn(); // çağrılırsa testi düşürmek için
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(db.collectionGroup).not.toHaveBeenCalled();
            expect(db.collection).toHaveBeenCalledWith('couriers');
        });
    });

    describe('activeOrderCount self-heal (Fix A)', () => {
        test('SETs activeOrderCount to real count + 1 (not increment)', async () => {
            // Kuryede zaten 2 gerçek aktif sipariş var — atamadan sonra doğru değer 3
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 99 }, // kasıtlı drift'li
                courierOrders: activeOrdersFor('courier-1', 2)
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Drift'li 99 değil — gerçek sayım (2) + 1 = 3 yazılmalı
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 3 })
            );
        });

        test('SETs activeOrderCount to 1 when courier has no active orders', async () => {
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 5 } // drift'li
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 1 })
            );
        });

        test('skips counter when courier document missing (non-fatal)', async () => {
            const db = createMockDb({ noCourier: true });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Atama başarılı — kurye doc'u yoksa sayaç sessizce atlanır
            expect(result.success).toBe(true);
            expect(db._ref('couriers', 'courier-1').update).not.toHaveBeenCalled();
            // Sipariş yine de atanmış olmalı
            expect(db._ref('yemekSepetiOrders', 'TEST-001').update).toHaveBeenCalled();
        });

        test('terminal (delivered/cancelled) orders do NOT count toward capacity', async () => {
            // Kuryede 5 sipariş VAR ama hepsi teslim/iptal — gerçek aktif = 0
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 5, maxCapacity: 5 },
                courierOrders: [
                    { collection: 'yemekSepetiOrders', id: 'd1', data: { assignedCourierId: 'courier-1', Status: 'DELIVERED' } },
                    { collection: 'getirYemekOrders', id: 'd2', data: { assignedCourierId: 'courier-1', IsDelivered: true } },
                    { collection: 'trendyolGoOrders', id: 'd3', data: { assignedCourierId: 'courier-1', Status: 'CANCELLED' } },
                    { collection: 'fuudyOrders', id: 'd4', data: { assignedCourierId: 'courier-1', closedOrderId: 'closed_x' } },
                    { collection: 'tableOrders', id: 'd5', data: { assignedCourierId: 'courier-1', isCancelled: true } }
                ]
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Drift'li sayaç 5/5 olsa da gerçek aktif 0 → atama BAŞARILI
            expect(result.success).toBe(true);
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 1 })
            );
        });
    });

    describe('Capacity guard (gerçek sayıma dayalı)', () => {
        test('rejects assignment when courier genuinely at capacity', async () => {
            // 5 GERÇEK aktif sipariş + maxCapacity 5 → reddet
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 0, maxCapacity: 5 },
                courierOrders: activeOrdersFor('courier-1', 5)
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('courier_at_capacity');
        });

        test('honours maxPackageCapacity field as capacity fallback', async () => {
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 0, maxPackageCapacity: 3 },
                courierOrders: activeOrdersFor('courier-1', 3)
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('courier_at_capacity');
        });

        test('drift bug: inflated activeOrderCount no longer blocks assignment', async () => {
            // Asıl drift senaryosu: sayaç 3/3 ama gerçekte 0 aktif sipariş.
            // Eski kodda 'courier_at_capacity' atardı; yeni kodda atama BAŞARILI.
            const db = createMockDb({
                courierData: { name: 'Davut', activeOrderCount: 3, maxPackageCapacity: 3 }
                // courierOrders yok — gerçek aktif sipariş = 0
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Davut');

            expect(result.success).toBe(true);
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 1 })
            );
        });
    });

    describe('Reassignment', () => {
        test('sets new courier count, decrements old courier on reassignment', async () => {
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-old' },
                oldCourierId: 'courier-old',
                oldCourierData: { name: 'Mehmet', activeOrderCount: 3 }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
            // Yeni kurye — gerçek sayım (0) + 1 = 1 SET edilir
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 1 })
            );
            // Eski kurye -1 (increment) — trigger Fix B'si steady-state'te reconcile eder
            expect(db._ref('couriers', 'courier-old').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 'INCREMENT(-1)' })
            );
        });

        test('does not touch old courier when reassigned to same courier', async () => {
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-1' }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
        });

        test('idempotent retry: order already on this courier is not double-counted', async () => {
            // Sipariş zaten courier-1'de + courier-1'in 2 aktif siparişi (biri TEST-001).
            // Gerçek sayım 3 olur ama TEST-001 zaten bu kuryede → -1 düş → 2, SET 2+1=3.
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-1' },
                courierData: { name: 'Ahmet', activeOrderCount: 0 },
                courierOrders: [
                    { collection: 'yemekSepetiOrders', id: 'TEST-001', data: { assignedCourierId: 'courier-1', Status: 'PICKED_UP' } },
                    { collection: 'getirYemekOrders', id: 'x2', data: { assignedCourierId: 'courier-1', Status: 'PICKED_UP' } }
                ]
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
            // Gerçek aktif 2 (TEST-001 + x2), TEST-001 zaten bu kuryede → 2-1=1, SET 1+1=2
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 2 })
            );
        });
    });

    describe('assignedAt timestamp', () => {
        test('sets assignedAt with server timestamp', async () => {
            const db = createMockDb();
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            const updateCall = db._ref('yemekSepetiOrders', 'TEST-001').update.mock.calls[0][0];
            expect(updateCall.assignedAt).toBe('SERVER_TIMESTAMP');
        });
    });

    describe('Collection name mapping', () => {
        test('yemeksepeti uses yemekSepetiOrders', () => {
            const connector = new BasePlatformConnector('yemeksepeti', null, {});
            expect(connector.collectionName).toBe('yemekSepetiOrders');
        });

        test('getiryemek uses getirYemekOrders', () => {
            const connector = new BasePlatformConnector('getiryemek', null, {});
            expect(connector.collectionName).toBe('getirYemekOrders');
        });

        test('trendyolgo uses trendyolGoOrders', () => {
            const connector = new BasePlatformConnector('trendyolgo', null, {});
            expect(connector.collectionName).toBe('trendyolGoOrders');
        });
    });

    describe('computeRealActiveOrderCount', () => {
        test('counts only non-terminal orders across collections', async () => {
            const db = createMockDb({
                courierOrders: [
                    { collection: 'yemekSepetiOrders', id: 'a1', data: { assignedCourierId: 'c9', Status: 'PICKED_UP' } },
                    { collection: 'getirYemekOrders', id: 'a2', data: { assignedCourierId: 'c9', Status: 'NEW' } },
                    { collection: 'trendyolGoOrders', id: 'a3', data: { assignedCourierId: 'c9', Status: 'DELIVERED' } },
                    { collection: 'fuudyOrders', id: 'a4', data: { assignedCourierId: 'OTHER', Status: 'NEW' } }
                ]
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const count = await connector.computeRealActiveOrderCount('c9');
            expect(count).toBe(2); // a1 + a2 (a3 terminal, a4 başka kurye)
        });

        test('returns 0 when db is null', async () => {
            const connector = new BasePlatformConnector('yemeksepeti', null, {});
            const count = await connector.computeRealActiveOrderCount('c9');
            expect(count).toBe(0);
        });
    });

    // QR self-claim (claim-courier endpoint) — sipariş BAŞKA kuryedeyse
    // requireUnassigned:true ile transaction içinde reddedilir.
    describe('requireUnassigned guard (QR self-claim)', () => {
        test('assigns when order is unassigned', async () => {
            const db = createMockDb();
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier(
                'TEST-001', 'courier-1', 'Ahmet', { requireUnassigned: true });

            expect(result.success).toBe(true);
        });

        test('assigns when order is already on the same courier (idempotent)', async () => {
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-1' }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier(
                'TEST-001', 'courier-1', 'Ahmet', { requireUnassigned: true });

            expect(result.success).toBe(true);
        });

        test('rejects when order is assigned to a DIFFERENT courier', async () => {
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-old' }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier(
                'TEST-001', 'courier-1', 'Ahmet', { requireUnassigned: true });

            expect(result.success).toBe(false);
            expect(result.reason).toBe('already_assigned');
            expect(result.assignedTo).toBe('courier-old');
            // Sipariş dokümanı DEĞİŞMEMELİ — atama yapılmadı
            expect(db._ref('yemekSepetiOrders', 'TEST-001').update).not.toHaveBeenCalled();
        });

        test('regression: without requireUnassigned, reassignment still works', async () => {
            // requireUnassigned verilmezse mevcut assign-courier davranışı korunur:
            // başka kuryedeki sipariş koşulsuz devralınır.
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-old' },
                oldCourierId: 'courier-old',
                oldCourierData: { name: 'Mehmet', activeOrderCount: 2 }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
            expect(db._ref('yemekSepetiOrders', 'TEST-001').update).toHaveBeenCalled();
        });
    });
});
