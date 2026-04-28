// ==================================================================================
// DelayedCallApi — POST /api/v2/delayed-call/enqueue handler tests
// ==================================================================================
// RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.5
//
// Handler logic'i unit test ediyor — supertest yok, mock req/res ile.
// ==================================================================================

jest.mock('firebase-admin', () => ({
    firestore: {
        FieldValue: {
            serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP')
        },
        Timestamp: {
            fromDate: jest.fn().mockImplementation(d => ({ toDate: () => d }))
        }
    }
}));

const { enqueueHandler } = require('../services/api/delayed-call-api');

function createMockRes() {
    return {
        statusCode: 200,
        body: null,
        status: jest.fn().mockImplementation(function (code) { this.statusCode = code; return this; }),
        json: jest.fn().mockImplementation(function (body) { this.body = body; return this; })
    };
}

function createReq(body = {}, headers = {}) {
    return {
        body,
        headers,
        branchIdHeader: headers['x-branch-id'] || null
    };
}

function createMockQueue(behavior = {}) {
    return {
        enqueue: jest.fn().mockImplementation(async (args) => {
            if (behavior.throw) throw new Error(behavior.throw);
            return behavior.result || {
                success: true,
                queueId: `${args.platform}_${args.orderId}_${args.action}`,
                alreadyQueued: false,
                scheduledAt: { toDate: () => new Date(args.earliestAt) }
            };
        })
    };
}

describe('DelayedCallApi — enqueueHandler', () => {

    test('valid body → 200 + queueId', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const earliestAt = new Date(Date.now() + 60_000).toISOString();
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'ORD-1',
            branchId: 'BR-1',
            action: 'prepare',
            earliestAt
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.queueId).toBe('GetirYemek_ORD-1_prepare');
        expect(res.body.alreadyQueued).toBe(false);
        expect(res.body.scheduledAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    test('idempotent — alreadyQueued=true geçer', async () => {
        const queue = createMockQueue({
            result: {
                success: true,
                queueId: 'GetirYemek_X_prepare',
                alreadyQueued: true,
                scheduledAt: { toDate: () => new Date() }
            }
        });
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'BR',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.alreadyQueued).toBe(true);
    });

    test('invalid platform → 400 VALIDATION_FAILED', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'YemekSepeti',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.error).toMatch(/platform/);
        expect(queue.enqueue).not.toHaveBeenCalled();
    });

    test('invalid action → 400', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'foobar',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/action/);
    });

    test('eksik orderId → 400', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            branchId: 'B',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/orderId/);
    });

    test('eksik branchId → 400', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/branchId/);
    });

    test('eksik earliestAt → 400', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare'
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/earliestAt/);
    });

    test('invalid earliestAt → 400', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare',
            earliestAt: 'not-a-date'
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/earliestAt/);
    });

    test('queue.enqueue throw → 500 ENQUEUE_FAILED', async () => {
        const queue = createMockQueue({ throw: 'firestore down' });
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.code).toBe('ENQUEUE_FAILED');
    });

    test('queue.enqueue success:false → 500 ENQUEUE_FAILED', async () => {
        const queue = createMockQueue({
            result: { success: false, error: 'tx conflict' }
        });
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare',
            earliestAt: new Date().toISOString()
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.code).toBe('ENQUEUE_FAILED');
    });

    test('opsiyonel scheduledAt iletilir', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const earliestAt = new Date(Date.now() + 60_000).toISOString();
        const scheduledAt = new Date(Date.now() + 90_000).toISOString();
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'prepare',
            earliestAt,
            scheduledAt
        });
        const res = createMockRes();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            scheduledAt: expect.any(Date)
        }));
    });

    test('payload alanı queue.enqueue\'e geçer', async () => {
        const queue = createMockQueue();
        const handler = enqueueHandler(queue);
        const req = createReq({
            platform: 'GetirYemek',
            orderId: 'X',
            branchId: 'B',
            action: 'cancel',
            earliestAt: new Date().toISOString(),
            payload: { reason: 'OUT_OF_STOCK' }
        });
        const res = createMockRes();

        await handler(req, res);

        expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            payload: { reason: 'OUT_OF_STOCK' }
        }));
    });
});
