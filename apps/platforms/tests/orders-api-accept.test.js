// ==================================================================================
// Orders API - Accept Endpoint with Auto-Assign Tests
// ==================================================================================

// Set env before requiring module (auth middleware reads process.env)
process.env.UNIFIED_API_KEY = 'test-key';

const express = require('express');
const http = require('http');

// We need to test the actual orders-api module
const createOrdersApi = require('../services/api/orders-api');

// ==================== MOCK HELPERS ====================

function createMockRegistry(options = {}) {
    const mockConnector = {
        acceptOrder: jest.fn().mockResolvedValue({ success: true }),
        rejectOrder: jest.fn().mockResolvedValue({ success: true }),
        getOrder: jest.fn().mockResolvedValue(options.order || {
            OrderId: 'TEST-001',
            Customer: {
                Address: {
                    Latitude: 41.02,
                    Longitude: 28.99,
                    FullAddress: 'Test Adres'
                },
                FirstName: 'Ahmet'
            },
            Status: 'ACCEPTED'
        }),
        assignCourier: jest.fn().mockResolvedValue({ success: true, orderId: 'TEST-001' }),
    };

    // snapshotDocBefore (assign-courier / pickup / deliver) connector.db üzerinden okur.
    // docData.assignedCourierId verilirse "sipariş zaten atanmış" senaryosu kurulur.
    mockConnector.collectionName = 'yemekSepetiOrders';
    mockConnector.db = {
        collection: jest.fn().mockReturnValue({
            doc: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({
                    exists: options.docExists !== false,
                    data: () => options.docData || { Status: 'ACCEPTED' }
                })
            })
        })
    };

    if (options.acceptFails) {
        mockConnector.acceptOrder.mockResolvedValue({ success: false, reason: 'Platform error' });
    }

    return {
        getConnector: jest.fn().mockReturnValue(options.noConnector ? null : mockConnector),
        getBranchPlatformConfig: jest.fn().mockReturnValue({}),
        _connector: mockConnector
    };
}

function createMockSmartDispatch(options = {}) {
    const courier = options.courier || {
        id: 'courier-1',
        name: 'Ahmet',
        fcmToken: 'fcm-token-123'
    };

    return {
        assignBestCourier: jest.fn().mockResolvedValue(options.noCourier ? null : courier)
    };
}

function createTestApp(registry, smartDispatch, notifyFns = {}) {
    const app = express();
    app.use(express.json());

    // Skip auth for tests
    const router = createOrdersApi(registry, smartDispatch, notifyFns);
    app.use('/api/v2/orders', (req, res, next) => {
        req.branchId = 'test-branch-1';
        next();
    }, router);

    return app;
}

// Simple request helper (no supertest dependency)
function makeRequest(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const options = {
                hostname: '127.0.0.1',
                port,
                path,
                method: method.toUpperCase(),
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'test-key',
                    'x-branch-id': 'test-branch-1'
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode, body: data });
                    }
                });
            });

            req.on('error', (err) => {
                server.close();
                reject(err);
            });

            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

// ==================== TESTS ====================

describe('Orders API - Accept with Auto-Assign', () => {

    describe('Basic accept (no auto-assign)', () => {
        test('accepts order successfully', async () => {
            const registry = createMockRegistry();
            const app = createTestApp(registry, null);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status).toBe('ACCEPTED');
            expect(res.body.orderId).toBe('TEST-001');
        });

        test('returns 404 for unknown platform', async () => {
            const registry = createMockRegistry({ noConnector: true });
            const app = createTestApp(registry, null);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/unknown/TEST-001/accept', {});

            expect(res.status).toBe(404);
            expect(res.body.code).toBe('PLATFORM_NOT_FOUND');
        });

        test('returns 400 when platform rejects accept', async () => {
            const registry = createMockRegistry({ acceptFails: true });
            const app = createTestApp(registry, null);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('ACCEPT_FAILED');
        });
    });

    describe('Auto-assign courier on accept', () => {
        test('auto-assigns courier when autoAssign=true (default)', async () => {
            const registry = createMockRegistry();
            const smartDispatch = createMockSmartDispatch();
            const app = createTestApp(registry, smartDispatch);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.courierId).toBe('courier-1');
            expect(res.body.courierName).toBe('Ahmet');
            expect(res.body.autoAssigned).toBe(true);

            // Verify assignBestCourier was called
            expect(smartDispatch.assignBestCourier).toHaveBeenCalledWith(
                'test-branch-1',
                expect.objectContaining({ latitude: 41.02, longitude: 28.99 })
            );

            // Verify assignCourier was called on connector
            expect(registry._connector.assignCourier).toHaveBeenCalledWith(
                'TEST-001', 'courier-1', 'Ahmet'
            );
        });

        test('skips auto-assign when autoAssign=false', async () => {
            const registry = createMockRegistry();
            const smartDispatch = createMockSmartDispatch();
            const app = createTestApp(registry, smartDispatch);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {
                autoAssign: false
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.courierId).toBeUndefined();
            expect(res.body.autoAssigned).toBeUndefined();

            // assignBestCourier should NOT be called
            expect(smartDispatch.assignBestCourier).not.toHaveBeenCalled();
        });

        test('succeeds even when no courier available', async () => {
            const registry = createMockRegistry();
            const smartDispatch = createMockSmartDispatch({ noCourier: true });
            const app = createTestApp(registry, smartDispatch);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status).toBe('ACCEPTED');
            expect(res.body.courierId).toBeUndefined();
        });

        test('succeeds even when auto-assign throws error', async () => {
            const registry = createMockRegistry();
            const smartDispatch = {
                assignBestCourier: jest.fn().mockRejectedValue(new Error('DB connection lost'))
            };
            const app = createTestApp(registry, smartDispatch);

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            // Accept still succeeds
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status).toBe('ACCEPTED');
            expect(res.body.courierId).toBeUndefined();
        });

        test('sends push notification to assigned courier', async () => {
            const registry = createMockRegistry();
            const smartDispatch = createMockSmartDispatch();
            const notifyCourierNewOrder = jest.fn().mockResolvedValue(true);
            const app = createTestApp(registry, smartDispatch, { notifyCourierNewOrder });

            const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/accept', {});

            expect(res.status).toBe(200);
            expect(notifyCourierNewOrder).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'courier-1', name: 'Ahmet' }),
                expect.any(Object),
                'yemeksepeti'
            );
        });

        test('extracts delivery coordinates from order', async () => {
            const registry = createMockRegistry({
                order: {
                    OrderId: 'GY-001',
                    Latitude: 41.05,
                    Longitude: 29.01
                }
            });
            const smartDispatch = createMockSmartDispatch();
            const app = createTestApp(registry, smartDispatch);

            await makeRequest(app, 'POST', '/api/v2/orders/getiryemek/GY-001/accept', {});

            expect(smartDispatch.assignBestCourier).toHaveBeenCalledWith(
                'test-branch-1',
                { latitude: 41.05, longitude: 29.01 }
            );
        });
    });
});

// ==================================================================================
// assign-courier IDEMPOTENCY — "sipariş kuryeye düşüp anında kayboluyor" fix.
// Sipariş zaten bir kuryeye atanmışsa OTOMATİK atama isteği onu yeniden atamamalı;
// aksi halde webhook auto-assign + WPF assign-courier + retry kuryeyi A->B->C diye
// değiştirir. Manuel atama (body.courierId dolu) bu kuraldan muaftır.
// ==================================================================================

describe('Orders API - assign-courier idempotency', () => {

    test('skips re-assignment when order already has a courier (auto mode)', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED', assignedCourierId: 'courier-old', assignedCourierName: 'Mehmet' }
        });
        const smartDispatch = createMockSmartDispatch();
        const app = createTestApp(registry, smartDispatch);

        const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/assign-courier', {});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alreadyAssigned).toBe(true);
        expect(res.body.courierId).toBe('courier-old');
        // Yeniden atama YAPILMAMALI
        expect(smartDispatch.assignBestCourier).not.toHaveBeenCalled();
        expect(registry._connector.assignCourier).not.toHaveBeenCalled();
    });

    test('manual re-assignment still works even when already assigned', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED', assignedCourierId: 'courier-old', assignedCourierName: 'Mehmet' }
        });
        const smartDispatch = createMockSmartDispatch();
        const app = createTestApp(registry, smartDispatch);

        const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/assign-courier', {
            courierId: 'courier-new', courierName: 'Veli'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alreadyAssigned).toBeUndefined();
        // Manuel atama kasıtlı reassign — connector.assignCourier çağrılmalı
        expect(registry._connector.assignCourier).toHaveBeenCalledWith(
            'TEST-001', 'courier-new', 'Veli'
        );
    });

    test('auto-assigns normally when order has no courier yet', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED' } // assignedCourierId yok
        });
        const smartDispatch = createMockSmartDispatch();
        const app = createTestApp(registry, smartDispatch);

        const res = await makeRequest(app, 'POST', '/api/v2/orders/yemeksepeti/TEST-001/assign-courier', {});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alreadyAssigned).toBeUndefined();
        expect(smartDispatch.assignBestCourier).toHaveBeenCalled();
        expect(registry._connector.assignCourier).toHaveBeenCalledWith(
            'TEST-001', 'courier-1', 'Ahmet'
        );
    });
});
