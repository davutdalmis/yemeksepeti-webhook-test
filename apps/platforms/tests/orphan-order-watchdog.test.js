// ==================================================================================
// ORPHAN ORDER WATCHDOG TESTS - OUTAGE_RESILIENCE_PLAN Faz 1
// ==================================================================================

const OrphanOrderWatchdog = require('../services/watchdog/orphan-order-watchdog');

const MIN = 60 * 1000;
const BASE_NOW = 1_750_000_000_000; // sabit referans (Date.now bağımsızlığı)

/**
 * Konfigüre edilebilir sahte Firestore.
 * state.orders / state.branches / state.devices test sırasında mutate edilebilir.
 */
function makeDb(state) {
    const alertWrites = [];
    const db = {
        collection: (name) => {
            if (name === 'yemekSepetiOrders') {
                return {
                    where: () => ({
                        get: async () => ({
                            empty: state.orders.length === 0,
                            docs: state.orders.map(o => ({ id: o.id, data: () => o.data }))
                        })
                    })
                };
            }
            if (name === 'branches') {
                return {
                    doc: (branchId) => ({
                        get: async () => ({
                            exists: !!state.branches[branchId],
                            data: () => state.branches[branchId]
                        }),
                        collection: () => ({
                            get: async () => ({
                                docs: (state.devices[branchId] || []).map(d => ({ data: () => d }))
                            })
                        })
                    })
                };
            }
            if (name === 'orphanAlerts') {
                return {
                    doc: (key) => ({
                        set: async (fields, opts) => { alertWrites.push({ key, fields, opts }); }
                    })
                };
            }
            throw new Error('unexpected collection ' + name);
        }
    };
    return { db, alertWrites };
}

function makeWatchdog(state, overrides = {}) {
    const clock = { now: BASE_NOW };
    const { db, alertWrites } = makeDb(state);
    const managerPush = {
        sendCriticalAlert: jest.fn(async () => ({ sent: 1, failed: 0, tokenCount: 1 }))
    };
    const watchdog = new OrphanOrderWatchdog(db, managerPush, {
        now: () => clock.now,
        ...overrides
    });
    return { watchdog, managerPush, alertWrites, clock };
}

/** Varsayılan: flag açık şube + 4 dk yaşında NEW sipariş (eşik 3 dk → aday) */
function defaultState() {
    return {
        orders: [{
            id: 'ORD-1',
            data: {
                Status: 'NEW', IsCancelled: false, IsAccepted: false,
                branchId: 'branch-1', ShortCode: '4711',
                CreatedAt: BASE_NOW - 4 * MIN
            }
        }],
        branches: {
            'branch-1': {
                orphanOrderAlertEnabled: true,
                tenantId: 'tenant-1',
                branchName: 'Test Şube'
            }
        },
        devices: { 'branch-1': [] } // cihaz yok → çevrimdışı varsayılır
    };
}

describe('OrphanOrderWatchdog — seçim matrisi', () => {
    test('eşiği aşmış NEW sipariş → CRITICAL bildirim + orphanAlerts kaydı', async () => {
        const state = defaultState();
        const { watchdog, managerPush, alertWrites } = makeWatchdog(state);

        await watchdog.processCycle();

        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);
        const call = managerPush.sendCriticalAlert.mock.calls[0][0];
        expect(call.tenantId).toBe('tenant-1');
        expect(call.branchId).toBe('branch-1');
        expect(call.title).toContain('YemekSepeti');
        expect(call.body).toContain('Test Şube');
        expect(call.body).toContain('#4711');

        expect(alertWrites).toHaveLength(1);
        expect(alertWrites[0].key).toBe('yemeksepeti_ORD-1');
        expect(alertWrites[0].fields).toMatchObject({ notifyCount: 1, branchId: 'branch-1' });
        expect(alertWrites[0].opts).toEqual({ merge: true });
    });

    test('eşikten genç sipariş → bildirim yok', async () => {
        const state = defaultState();
        state.orders[0].data.CreatedAt = BASE_NOW - 2 * MIN; // 2 dk < 3 dk eşik
        const { watchdog, managerPush } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).not.toHaveBeenCalled();
    });

    test.each([
        ['Status ACCEPTED', { Status: 'ACCEPTED' }],
        ['IsCancelled true', { IsCancelled: true }],
        ['IsAccepted true', { IsAccepted: true }],
        ['kurye atanmış', { assignedCourierId: 'courier-1' }]
    ])('%s → bildirim yok', async (_label, patch) => {
        const state = defaultState();
        Object.assign(state.orders[0].data, patch);
        const { watchdog, managerPush } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).not.toHaveBeenCalled();
    });

    test('şube flag\'i kapalı (default) → bildirim yok', async () => {
        const state = defaultState();
        delete state.branches['branch-1'].orphanOrderAlertEnabled;
        const { watchdog, managerPush } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).not.toHaveBeenCalled();
    });

    test('branch dokümanı yok → bildirim yok, hata fırlamaz', async () => {
        const state = defaultState();
        state.branches = {};
        const { watchdog, managerPush } = makeWatchdog(state);

        await expect(watchdog.processCycle()).resolves.toBeUndefined();
        expect(managerPush.sendCriticalAlert).not.toHaveBeenCalled();
    });

    test('şube bazlı özel eşik (orphanOrderAlertMinutes=10) uygulanır', async () => {
        const state = defaultState();
        state.branches['branch-1'].orphanOrderAlertMinutes = 10;
        state.orders[0].data.CreatedAt = BASE_NOW - 8 * MIN; // 8 dk < 10 dk
        const { watchdog, managerPush, clock } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).not.toHaveBeenCalled();

        clock.now += 3 * MIN; // yaş 11 dk
        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);
    });
});

describe('OrphanOrderWatchdog — cooldown ve hatırlatma', () => {
    test('aynı döngüde/5 dk içinde ikinci bildirim atılmaz; 5 dk sonra 1 HATIRLATMA; üçüncüsü ASLA', async () => {
        const state = defaultState();
        const { watchdog, managerPush, clock } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);

        clock.now += 1 * MIN; // 1 dk sonra: cooldown içinde
        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);

        clock.now += 4 * MIN; // ilk bildirimden 5 dk sonra: hatırlatma
        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(2);
        expect(managerPush.sendCriticalAlert.mock.calls[1][0].body).toContain('HATIRLATMA');

        clock.now += 10 * MIN; // max 2'ye ulaşıldı: bir daha asla
        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(2);
    });

    test('alarm sonrası sipariş kabul edilirse resolvedAt yazılır', async () => {
        const state = defaultState();
        const { watchdog, managerPush, alertWrites, clock } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);

        state.orders[0].data.Status = 'ACCEPTED';
        state.orders[0].data.IsAccepted = true;
        clock.now += 1 * MIN;
        await watchdog.processCycle();

        const resolveWrite = alertWrites.find(w => w.fields.resolvedStatus);
        expect(resolveWrite).toBeDefined();
        expect(resolveWrite.key).toBe('yemeksepeti_ORD-1');
        expect(resolveWrite.fields.resolvedStatus).toBe('ACCEPTED');

        // Çözülen sipariş tekrar alarm üretmez
        expect(managerPush.sendCriticalAlert).toHaveBeenCalledTimes(1);
    });

    test('hiç alarm verilmemiş işlenmiş sipariş için resolved yazılmaz', async () => {
        const state = defaultState();
        state.orders[0].data.Status = 'ACCEPTED';
        const { watchdog, alertWrites } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(alertWrites).toHaveLength(0);
    });
});

describe('OrphanOrderWatchdog — heartbeat metni', () => {
    test('taze heartbeat → "cihaz açık ama" metni', async () => {
        const state = defaultState();
        state.devices['branch-1'] = [{ lastSeenAt: BASE_NOW - 1 * MIN }];
        const { watchdog, managerPush } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert.mock.calls[0][0].body).toContain('cihaz açık ama');
    });

    test('bayat heartbeat (5+ dk) → "ÇEVRİMDIŞI" metni', async () => {
        const state = defaultState();
        state.devices['branch-1'] = [{ lastSeenAt: BASE_NOW - 9 * MIN }];
        const { watchdog, managerPush } = makeWatchdog(state);

        await watchdog.processCycle();
        expect(managerPush.sendCriticalAlert.mock.calls[0][0].body).toContain('ÇEVRİMDIŞI');
    });
});

describe('OrphanOrderWatchdog — dayanıklılık ve kill-switch', () => {
    test('push hatası döngüyü düşürmez', async () => {
        const state = defaultState();
        const { watchdog, managerPush } = makeWatchdog(state);
        managerPush.sendCriticalAlert.mockRejectedValue(new Error('push down'));

        await expect(watchdog.processCycle()).resolves.toBeUndefined();
    });

    test('ORPHAN_WATCHDOG_ENABLED=false → start() bekçiyi başlatmaz', () => {
        const prev = process.env.ORPHAN_WATCHDOG_ENABLED;
        process.env.ORPHAN_WATCHDOG_ENABLED = 'false';
        try {
            const state = defaultState();
            const { watchdog } = makeWatchdog(state);
            const cycleSpy = jest.spyOn(watchdog, 'processCycle');

            watchdog.start();

            expect(watchdog._intervalId).toBeNull();
            expect(cycleSpy).not.toHaveBeenCalled();
        } finally {
            if (prev === undefined) delete process.env.ORPHAN_WATCHDOG_ENABLED;
            else process.env.ORPHAN_WATCHDOG_ENABLED = prev;
        }
    });

    test('start/stop interval yaşam döngüsü', () => {
        jest.useFakeTimers();
        try {
            const state = defaultState();
            state.orders = []; // boş tarama
            const { watchdog } = makeWatchdog(state);

            watchdog.start();
            expect(watchdog._intervalId).not.toBeNull();

            watchdog.stop();
            expect(watchdog._intervalId).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });
});
