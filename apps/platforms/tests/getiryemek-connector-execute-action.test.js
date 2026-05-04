// ==================================================================================
// GetirYemekConnector.executeAction — Faz 1.4
// ==================================================================================
// RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.4: connector queue worker tarafından bu metot
// üzerinden çağrılır. Mapping: verify→acceptOrder, prepare→markOrderReady,
// deliver→markOrderDelivered, handover→markOrderPickedUp, cancel→rejectOrder.
// ==================================================================================

jest.mock('firebase-admin', () => ({
    firestore: {
        FieldValue: {
            serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP'),
            increment: jest.fn().mockImplementation((n) => `INCREMENT(${n})`)
        }
    }
}));

// axios is used by the underlying methods — mock so we never hit network
jest.mock('axios');

const axios = require('axios');
const GetirYemekConnector = require('../services/platforms/connectors/getiryemek-connector');

function createMockRegistry(branchConfig = { restaurantSecretKey: 'TEST_SECRET' }) {
    return {
        getBranchPlatformConfig: jest.fn().mockReturnValue(branchConfig),
        getConnector: jest.fn()
    };
}

function createMockDb() {
    return {
        collection: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
            doc: jest.fn().mockReturnValue({
                set: jest.fn().mockResolvedValue(),
                update: jest.fn().mockResolvedValue(),
                get: jest.fn().mockResolvedValue({ exists: false })
            })
        }),
        collectionGroup: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnThis(),
            get: jest.fn().mockResolvedValue({ empty: true, docs: [] })
        })
    };
}

describe('GetirYemekConnector.executeAction — Faz 1.4 dispatch', () => {
    let connector;
    let registry;

    beforeEach(() => {
        jest.clearAllMocks();
        axios.post.mockResolvedValue({ data: { ok: true } });
        registry = createMockRegistry();
        connector = new GetirYemekConnector(createMockDb(), registry);
    });

    test('verify → acceptOrder çağrılır, branchConfig registry\'den alınır', async () => {
        const spy = jest.spyOn(connector, 'acceptOrder').mockResolvedValue({ success: true });

        await connector.executeAction('verify', 'ORDER-1', { branchId: 'BR-1' });

        expect(registry.getBranchPlatformConfig).toHaveBeenCalledWith('BR-1', 'getiryemek');
        expect(spy).toHaveBeenCalledWith('ORDER-1', { restaurantSecretKey: 'TEST_SECRET' });
    });

    test('prepare → markOrderReady çağrılır', async () => {
        const spy = jest.spyOn(connector, 'markOrderReady').mockResolvedValue({ success: true });

        await connector.executeAction('prepare', 'ORDER-2', { branchId: 'BR-1' });

        expect(spy).toHaveBeenCalledWith('ORDER-2', expect.any(Object));
    });

    test('deliver → markOrderDelivered çağrılır', async () => {
        const spy = jest.spyOn(connector, 'markOrderDelivered').mockResolvedValue({ success: true });

        await connector.executeAction('deliver', 'ORDER-3', { branchId: 'BR-1' });

        expect(spy).toHaveBeenCalledWith('ORDER-3', expect.any(Object));
    });

    test('handover → markOrderPickedUp çağrılır', async () => {
        const spy = jest.spyOn(connector, 'markOrderPickedUp').mockResolvedValue({ success: true });

        await connector.executeAction('handover', 'ORDER-4', { branchId: 'BR-1' });

        expect(spy).toHaveBeenCalledWith('ORDER-4', expect.any(Object));
    });

    test('cancel → rejectOrder çağrılır, payload.reason geçer', async () => {
        const spy = jest.spyOn(connector, 'rejectOrder').mockResolvedValue({ success: true });

        await connector.executeAction('cancel', 'ORDER-5', {
            branchId: 'BR-1',
            reason: 'OUT_OF_STOCK'
        });

        expect(spy).toHaveBeenCalledWith('ORDER-5', 'OUT_OF_STOCK', expect.any(Object));
    });

    test('cancel reason yoksa fallback "OTHER"', async () => {
        const spy = jest.spyOn(connector, 'rejectOrder').mockResolvedValue({ success: true });

        await connector.executeAction('cancel', 'ORDER-6', { branchId: 'BR-1' });

        expect(spy).toHaveBeenCalledWith('ORDER-6', 'OTHER', expect.any(Object));
    });

    test('invalid action → throw', async () => {
        await expect(connector.executeAction('foobar', 'O', { branchId: 'B' }))
            .rejects.toThrow(/unknown action: foobar/);
    });

    test('underlying method success:false → executeAction throw eder (worker markFailed alabilsin)', async () => {
        jest.spyOn(connector, 'acceptOrder')
            .mockResolvedValue({ success: false, reason: 'API timeout' });

        await expect(connector.executeAction('verify', 'O', { branchId: 'B' }))
            .rejects.toThrow(/API timeout/);
    });

    test('underlying method success:undefined → throw "unknown"', async () => {
        jest.spyOn(connector, 'markOrderReady').mockResolvedValue({});

        await expect(connector.executeAction('prepare', 'O', { branchId: 'B' }))
            .rejects.toThrow(/unknown/);
    });

    test('payload.branchId yoksa branchConfig boş objeyle çağrılır (defensive)', async () => {
        const spy = jest.spyOn(connector, 'acceptOrder').mockResolvedValue({ success: true });

        await connector.executeAction('verify', 'O', {}); // branchId yok

        expect(registry.getBranchPlatformConfig).not.toHaveBeenCalled();
        expect(spy).toHaveBeenCalledWith('O', {});
    });

    test('orderId yoksa throw', async () => {
        await expect(connector.executeAction('verify', '', { branchId: 'B' }))
            .rejects.toThrow(/orderId required/);
    });
});
