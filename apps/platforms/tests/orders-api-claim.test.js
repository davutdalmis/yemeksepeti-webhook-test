// ==================================================================================
// Orders API - claim-courier Endpoint Tests (QR self-claim)
//
// Kurye, WPF kurye fişindeki QR'ı Yemigo Express'te okutarak KENDİNİ siparişe atar.
// "Sahipsizlik" kuralı: sipariş atanmamışsa VEYA zaten bu kuryeye atanmışsa devam;
// BAŞKA kuryedeyse atama yapılmaz (409). Atama, manuel assign-courier ile aynı
// connector.assignCourier transaction'ını kullanır.
// ==================================================================================

// Set env before requiring module (auth middleware reads process.env)
process.env.UNIFIED_API_KEY = 'test-key';

const express = require('express');
const http = require('http');

const createOrdersApi = require('../services/api/orders-api');

// ==================== MOCK HELPERS ====================

function createMockRegistry(options = {}) {
    const mockConnector = {
        getOrder: jest.fn().mockResolvedValue({ OrderId: 'TEST-001' }),
        assignCourier: jest.fn().mockResolvedValue(
            options.assignResult || { success: true, orderId: 'TEST-001' }
        ),
    };

    // snapshotDocBefore connector.db üzerinden order doc'u okur.
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

    return {
        getConnector: jest.fn().mockReturnValue(options.noConnector ? null : mockConnector),
        _connector: mockConnector
    };
}

function createTestApp(registry, branchId = 'test-branch-1') {
    const app = express();
    app.use(express.json());

    const router = createOrdersApi(registry, null, {});
    app.use('/api/v2/orders', (req, res, next) => {
        req.branchId = branchId;
        next();
    }, router);

    return app;
}

// Simple request helper (no supertest dependency)
function makeRequest(app, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path,
                method: method.toUpperCase(),
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'test-key',
                    'x-branch-id': 'test-branch-1'
                }
            }, (res) => {
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
            req.on('error', (err) => { server.close(); reject(err); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    });
}

const CLAIM_PATH = '/api/v2/orders/yemeksepeti/TEST-001/claim-courier';

// ==================== TESTS ====================

describe('Orders API - claim-courier (QR self-claim)', () => {

    test('claims an unassigned order successfully', async () => {
        const registry = createMockRegistry({ docData: { Status: 'ACCEPTED' } });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.courierId).toBe('courier-1');
        expect(res.body.courierName).toBe('Ahmet');
        // Manuel atamayla aynı transaction — requireUnassigned guard'ı ile
        expect(registry._connector.assignCourier).toHaveBeenCalledWith(
            'TEST-001', 'courier-1', 'Ahmet', { requireUnassigned: true }
        );
    });

    test('falls back to courierId when courierName is missing', async () => {
        const registry = createMockRegistry({ docData: { Status: 'ACCEPTED' } });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, { courierId: 'courier-1' });

        expect(res.status).toBe(200);
        expect(registry._connector.assignCourier).toHaveBeenCalledWith(
            'TEST-001', 'courier-1', 'courier-1', { requireUnassigned: true }
        );
    });

    test('returns 409 ALREADY_ASSIGNED when order belongs to another courier', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED', assignedCourierId: 'courier-old', assignedCourierName: 'Mehmet' }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_ASSIGNED');
        expect(res.body.assignedCourierId).toBe('courier-old');
        expect(res.body.assignedCourierName).toBe('Mehmet');
        // Atama YAPILMAMALI
        expect(registry._connector.assignCourier).not.toHaveBeenCalled();
    });

    test('returns 200 alreadyAssigned (no-op) when order is already on this courier', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED', assignedCourierId: 'courier-1', assignedCourierName: 'Ahmet' }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alreadyAssigned).toBe(true);
        // Idempotent — tekrar atama çağrısı yapılmaz
        expect(registry._connector.assignCourier).not.toHaveBeenCalled();
    });

    test('returns 409 ORDER_CLOSED when order is delivered', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'DELIVERED', IsDelivered: true }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_CLOSED');
        expect(registry._connector.assignCourier).not.toHaveBeenCalled();
    });

    test('returns 409 ORDER_CLOSED when order is cancelled', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'CANCELLED' }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_CLOSED');
    });

    test('returns 403 BRANCH_MISMATCH when order belongs to a different branch', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED', branchId: 'other-branch' }
        });
        const app = createTestApp(registry, 'test-branch-1');

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BRANCH_MISMATCH');
        expect(registry._connector.assignCourier).not.toHaveBeenCalled();
    });

    test('returns 400 NO_COURIER when courierId is missing', async () => {
        const registry = createMockRegistry({ docData: { Status: 'ACCEPTED' } });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, { courierName: 'Ahmet' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NO_COURIER');
    });

    test('returns 404 PLATFORM_NOT_FOUND for unknown platform', async () => {
        const registry = createMockRegistry({ noConnector: true });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST',
            '/api/v2/orders/unknown/TEST-001/claim-courier',
            { courierId: 'courier-1', courierName: 'Ahmet' });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PLATFORM_NOT_FOUND');
    });

    test('returns 404 ORDER_NOT_FOUND when order document does not exist', async () => {
        const registry = createMockRegistry({ docExists: false });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ORDER_NOT_FOUND');
    });

    test('returns 422 AT_CAPACITY when courier is at capacity', async () => {
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED' },
            assignResult: { success: false, reason: 'courier_at_capacity' }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('AT_CAPACITY');
    });

    test('returns 409 ALREADY_ASSIGNED when transaction loses the race', async () => {
        // Ön-kontrol sahipsiz gördü ama transaction içinde başka kurye kapmış
        const registry = createMockRegistry({
            docData: { Status: 'ACCEPTED' },
            assignResult: { success: false, reason: 'already_assigned', assignedTo: 'courier-x' }
        });
        const app = createTestApp(registry);

        const res = await makeRequest(app, 'POST', CLAIM_PATH, {
            courierId: 'courier-1', courierName: 'Ahmet'
        });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_ASSIGNED');
        expect(res.body.assignedCourierId).toBe('courier-x');
    });
});
