// ==================================================================================
// Base Connector - assignCourier (atomic transaction + direct doc lookup) Tests
//
// NOT: assignCourier collectionGroup('couriers') sorgusundan doğrudan
// collection('couriers').doc(id) lookup'a geçti (composite index / 500 fix —
// memory: project_dispatch_collectionGroup_index_fix). Mock buna göre kuruludur:
// db.collection(name).doc(id) -> sabit docRef, db.runTransaction(fn) -> fn(transaction).
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
 * createMockDb — collection().doc().get()/update() + runTransaction destekli mock.
 *
 * options:
 *   noOrders          : sipariş dokümanı yok (order_not_found senaryosu)
 *   orderData         : sipariş dokümanı verisi (default { OrderId: 'TEST-001' })
 *   noCourier         : kurye dokümanı yok (counter atlanır senaryosu)
 *   courierData       : kurye dokümanı verisi (default { name:'Ahmet', activeOrderCount:0 })
 *   oldCourierId      : reassignment — eski kurye id'si
 *   oldCourierData    : eski kurye dokümanı verisi
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

    return {
        _store: store,
        _ref: (collection, id) => docRef(collection, id),
        collection: jest.fn().mockImplementation((collection) => ({
            doc: (id) => docRef(collection, id)
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

    describe('Atomic activeOrderCount increment', () => {
        test('increments courier activeOrderCount after assignment', async () => {
            const db = createMockDb({ courierData: { name: 'Ahmet', activeOrderCount: 2 } });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 'INCREMENT(1)' })
            );
            expect(admin.firestore.FieldValue.increment).toHaveBeenCalledWith(1);
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

        test('rejects assignment when courier at capacity', async () => {
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 5, maxCapacity: 5 }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('courier_at_capacity');
        });

        test('honours maxPackageCapacity field as capacity fallback', async () => {
            const db = createMockDb({
                courierData: { name: 'Ahmet', activeOrderCount: 3, maxPackageCapacity: 3 }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(false);
            expect(result.reason).toBe('courier_at_capacity');
        });
    });

    describe('Reassignment', () => {
        test('decrements old courier activeOrderCount on reassignment', async () => {
            const db = createMockDb({
                orderData: { OrderId: 'TEST-001', assignedCourierId: 'courier-old' },
                oldCourierId: 'courier-old',
                oldCourierData: { name: 'Mehmet', activeOrderCount: 3 }
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            expect(result.success).toBe(true);
            // Yeni kurye +1
            expect(db._ref('couriers', 'courier-1').update).toHaveBeenCalledWith(
                expect.objectContaining({ activeOrderCount: 'INCREMENT(1)' })
            );
            // Eski kurye -1
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
});
