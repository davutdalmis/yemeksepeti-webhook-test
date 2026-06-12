// ==================================================================================
// MANAGER PUSH TESTS - OUTAGE_RESILIENCE_PLAN Faz 1
// ==================================================================================

const ManagerPushService = require('../services/notifications/manager-push');

function makeDb(tenantUserDocs) {
    return {
        collection: jest.fn((name) => {
            if (name !== 'tenantUsers') throw new Error('unexpected collection ' + name);
            return {
                where: jest.fn(() => ({
                    get: jest.fn(async () => ({
                        docs: tenantUserDocs.map(d => ({ data: () => d }))
                    }))
                }))
            };
        })
    };
}

function makeMessaging(result = { successCount: 1, failureCount: 0 }) {
    const sendEachForMulticast = jest.fn(async () => result);
    return { messaging: { sendEachForMulticast }, sendEachForMulticast };
}

describe('ManagerPushService.collectTokens — şube filtresi', () => {
    test('branchId eşleşen kullanıcının token\'ları toplanır', async () => {
        const db = makeDb([
            { branchId: 'branch-1', devices: [{ fcmToken: 'tok-a' }] }
        ]);
        const svc = new ManagerPushService(db, () => ({}));
        const tokens = await svc.collectTokens('tenant-1', 'branch-1');
        expect(tokens).toEqual(['tok-a']);
    });

    test('branchId boş/undefined olan çoklu şube yöneticisi dahil edilir', async () => {
        const db = makeDb([
            { devices: [{ fcmToken: 'tok-multi' }] },
            { branchId: '', devices: [{ fcmToken: 'tok-empty' }] },
            { branchId: null, devices: [{ fcmToken: 'tok-null' }] }
        ]);
        const svc = new ManagerPushService(db, () => ({}));
        const tokens = await svc.collectTokens('tenant-1', 'branch-1');
        expect(tokens.sort()).toEqual(['tok-empty', 'tok-multi', 'tok-null']);
    });

    test('branches[] dizisi şubeyi içeren kullanıcı dahil edilir', async () => {
        const db = makeDb([
            { branchId: 'other', branches: ['branch-1', 'branch-2'], devices: [{ fcmToken: 'tok-arr' }] }
        ]);
        const svc = new ManagerPushService(db, () => ({}));
        const tokens = await svc.collectTokens('tenant-1', 'branch-1');
        expect(tokens).toEqual(['tok-arr']);
    });

    test('farklı şubeye atanmış kullanıcı dışarıda kalır', async () => {
        const db = makeDb([
            { branchId: 'branch-2', devices: [{ fcmToken: 'tok-other' }] }
        ]);
        const svc = new ManagerPushService(db, () => ({}));
        const tokens = await svc.collectTokens('tenant-1', 'branch-1');
        expect(tokens).toEqual([]);
    });

    test('aynı token tekrar eklenmez (dedup) ve geçersiz token atlanır', async () => {
        const db = makeDb([
            { branchId: 'branch-1', devices: [{ fcmToken: 'tok-dup' }, { fcmToken: 'tok-dup' }, { fcmToken: '' }, {}] },
            { branchId: 'branch-1', devices: [{ fcmToken: 'tok-dup' }] }
        ]);
        const svc = new ManagerPushService(db, () => ({}));
        const tokens = await svc.collectTokens('tenant-1', 'branch-1');
        expect(tokens).toEqual(['tok-dup']);
    });
});

describe('ManagerPushService.sendCriticalAlert', () => {
    test('CRITICAL tipli, high priority mesaj kurar; extraData string\'e çevrilir', async () => {
        const db = makeDb([{ branchId: 'branch-1', devices: [{ fcmToken: 'tok-a' }] }]);
        const { messaging, sendEachForMulticast } = makeMessaging({ successCount: 1, failureCount: 0 });
        const svc = new ManagerPushService(db, () => messaging);

        const result = await svc.sendCriticalAlert({
            tenantId: 'tenant-1',
            branchId: 'branch-1',
            title: 'Başlık',
            body: 'Gövde',
            extraData: { orderId: 'ORD-1', count: 5, skipMe: null }
        });

        expect(result).toEqual({ sent: 1, failed: 0, tokenCount: 1 });
        expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
        const message = sendEachForMulticast.mock.calls[0][0];
        expect(message.tokens).toEqual(['tok-a']);
        expect(message.android).toEqual({ priority: 'high' });
        expect(message.data).toMatchObject({
            type: 'CRITICAL',
            title: 'Başlık',
            body: 'Gövde',
            branchId: 'branch-1',
            tenantId: 'tenant-1',
            orderId: 'ORD-1',
            count: '5'
        });
        expect(message.data).not.toHaveProperty('skipMe');
    });

    test('token yoksa FCM çağrılmaz, sıfır döner', async () => {
        const db = makeDb([]);
        const { messaging, sendEachForMulticast } = makeMessaging();
        const svc = new ManagerPushService(db, () => messaging);

        const result = await svc.sendCriticalAlert({
            tenantId: 'tenant-1', branchId: 'branch-1', title: 't', body: 'b'
        });

        expect(result).toEqual({ sent: 0, failed: 0, tokenCount: 0 });
        expect(sendEachForMulticast).not.toHaveBeenCalled();
    });

    test('tenantId/branchId eksikse hiçbir şey yapmaz', async () => {
        const db = makeDb([{ branchId: 'branch-1', devices: [{ fcmToken: 'tok-a' }] }]);
        const svc = new ManagerPushService(db, () => ({}));

        expect(await svc.sendCriticalAlert({ branchId: 'branch-1', title: 't', body: 'b' }))
            .toEqual({ sent: 0, failed: 0, tokenCount: 0 });
        expect(await svc.sendCriticalAlert({ tenantId: 'tenant-1', title: 't', body: 'b' }))
            .toEqual({ sent: 0, failed: 0, tokenCount: 0 });
        expect(db.collection).not.toHaveBeenCalled();
    });

    test('FCM hatası yutulur — promise reject etmez', async () => {
        const db = makeDb([{ branchId: 'branch-1', devices: [{ fcmToken: 'tok-a' }] }]);
        const messaging = { sendEachForMulticast: jest.fn(async () => { throw new Error('fcm down'); }) };
        const svc = new ManagerPushService(db, () => messaging);

        const result = await svc.sendCriticalAlert({
            tenantId: 'tenant-1', branchId: 'branch-1', title: 't', body: 'b'
        });

        expect(result.sent).toBe(0);
        expect(result.tokenCount).toBe(1);
    });
});
