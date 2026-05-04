// ==================================================================================
// Base Connector - assignCourier with Atomic Increment Tests
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

function createMockDoc(data = {}, id = 'doc-1') {
    return {
        id,
        data: () => data,
        ref: {
            update: jest.fn().mockResolvedValue(true)
        }
    };
}

function createMockDb(options = {}) {
    const orderDocs = options.orderDocs || [createMockDoc({ OrderId: 'TEST-001' })];
    const courierDocs = options.courierDocs || [createMockDoc({ name: 'Ahmet' }, 'courier-1')];

    const orderSnapshot = {
        empty: options.noOrders ? true : false,
        docs: options.noOrders ? [] : orderDocs
    };

    const courierSnapshot = {
        empty: options.noCourier ? true : false,
        docs: options.noCourier ? [] : courierDocs
    };

    // Track which collection group was queried
    const queries = [];

    const mockQuery = (collectionName) => {
        return {
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
                queries.push(collectionName);
                // If querying couriers collection, return courier snapshot
                if (collectionName === 'couriers') {
                    return Promise.resolve(courierSnapshot);
                }
                return Promise.resolve(orderSnapshot);
            })
        };
    };

    return {
        collectionGroup: jest.fn().mockImplementation((name) => mockQuery(name)),
        _queries: queries,
        _orderDocs: orderDocs,
        _courierDocs: courierDocs
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

            // Verify order document was updated
            const orderDoc = db._orderDocs[0];
            expect(orderDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({
                assignedCourierId: 'courier-1',
                assignedCourierName: 'Ahmet',
                assignedAt: 'SERVER_TIMESTAMP'
            }));
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
    });

    describe('Atomic activeOrderCount increment', () => {
        test('increments courier activeOrderCount after assignment', async () => {
            const courierDoc = createMockDoc({ name: 'Ahmet', activeOrderCount: 2 }, 'courier-1');
            const db = createMockDb({ courierDocs: [courierDoc] });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Verify courier doc was updated with increment
            expect(courierDoc.ref.update).toHaveBeenCalledWith({
                activeOrderCount: 'INCREMENT(1)'
            });

            // Verify FieldValue.increment was called with 1
            expect(admin.firestore.FieldValue.increment).toHaveBeenCalledWith(1);
        });

        test('assignment succeeds even if counter update fails', async () => {
            const courierDoc = createMockDoc({ name: 'Ahmet' }, 'courier-1');
            courierDoc.ref.update = jest.fn()
                .mockRejectedValueOnce(new Error('Firestore timeout')); // First call fails (counter)

            const orderDoc = createMockDoc({ OrderId: 'TEST-001' });

            const db = createMockDb({
                orderDocs: [orderDoc],
                courierDocs: [courierDoc]
            });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            // The order update uses orderDoc.ref.update (which succeeds)
            // The courier counter uses courierDoc.ref.update (which fails)
            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Assignment itself should still succeed
            expect(result.success).toBe(true);
        });

        test('handles missing courier document gracefully', async () => {
            const db = createMockDb({ noCourier: true });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            const result = await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Assignment succeeds - courier not found for counter is non-fatal
            expect(result.success).toBe(true);
        });
    });

    describe('assignedAt timestamp', () => {
        test('sets assignedAt with server timestamp', async () => {
            const db = createMockDb();
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            const orderDoc = db._orderDocs[0];
            const updateCall = orderDoc.ref.update.mock.calls[0][0];
            expect(updateCall.assignedAt).toBe('SERVER_TIMESTAMP');
        });
    });

    describe('Multiple order documents', () => {
        test('updates all matching order documents', async () => {
            const doc1 = createMockDoc({ OrderId: 'TEST-001' });
            const doc2 = createMockDoc({ OrderId: 'TEST-001' });

            const db = createMockDb({ orderDocs: [doc1, doc2] });
            const connector = new BasePlatformConnector('yemeksepeti', db, {});

            await connector.assignCourier('TEST-001', 'courier-1', 'Ahmet');

            // Both docs should be updated
            expect(doc1.ref.update).toHaveBeenCalled();
            expect(doc2.ref.update).toHaveBeenCalled();
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
