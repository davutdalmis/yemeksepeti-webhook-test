// ==================================================================================
// DelayedCallQueue Tests — Faz 1.1 + 1.2
// ==================================================================================
// RAILWAY_DELAYED_QUEUE_PLAN.md görev 1.7 (manuel test) için otomatik karşılığı.
//
// Kapsam:
//   1. enqueue ilk kez → status=pending, attempts=0
//   2. enqueue idempotent — aynı docId 2x → alreadyQueued=true, doc 1 tane
//   3. markProcessing → pending'den processing'e atomik geçiş
//   4. markProcessing race — zaten processing ise false döner
//   5. markCompleted → status=completed, completedAt set
//   6. markFailed attempts<max → backoff, status=pending
//   7. markFailed attempts=max → status=failed (retry yok)
//   8. cleanup → completed > 24h doc'lar silinir
//   9. Validation — invalid platform/action reject edilir
// ==================================================================================

jest.mock('firebase-admin', () => {
    const fakeTimestamp = {
        fromDate: jest.fn().mockImplementation((date) => ({
            toDate: () => date,
            _seconds: Math.floor(date.getTime() / 1000),
            _isFakeTimestamp: true
        })),
        now: jest.fn().mockImplementation(() => ({
            toDate: () => new Date(),
            _seconds: Math.floor(Date.now() / 1000),
            _isFakeTimestamp: true
        }))
    };
    return {
        firestore: {
            FieldValue: {
                serverTimestamp: jest.fn().mockReturnValue('SERVER_TIMESTAMP')
            },
            Timestamp: fakeTimestamp
        }
    };
});

const DelayedCallQueue = require('../services/queue/delayed-call-queue');

// ---------- Mock Firestore (deterministik doc + transaction) ----------

function createMockDb() {
    const docs = new Map(); // docId -> data
    const operationLog = []; // { op: 'set'|'update'|'delete', docId, data }

    const docRef = (docId) => ({
        id: docId,
        get: jest.fn().mockImplementation(() => {
            const exists = docs.has(docId);
            return Promise.resolve({
                exists,
                id: docId,
                data: () => docs.get(docId) || null,
                ref: docRef(docId)
            });
        }),
        set: jest.fn().mockImplementation((data) => {
            docs.set(docId, data);
            operationLog.push({ op: 'set', docId, data });
            return Promise.resolve();
        }),
        update: jest.fn().mockImplementation((patch) => {
            const existing = docs.get(docId) || {};
            docs.set(docId, { ...existing, ...patch });
            operationLog.push({ op: 'update', docId, patch });
            return Promise.resolve();
        }),
        delete: jest.fn().mockImplementation(() => {
            docs.delete(docId);
            operationLog.push({ op: 'delete', docId });
            return Promise.resolve();
        })
    });

    const collectionRef = {
        doc: jest.fn().mockImplementation((docId) => docRef(docId)),
        // Supports .where().where().orderBy().limit().get() chain
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockImplementation(() => {
            // Default: return all completed docs older than cutoff (overridable per-test)
            return Promise.resolve({ empty: docs.size === 0, size: 0, docs: [] });
        })
    };

    const db = {
        collection: jest.fn().mockReturnValue(collectionRef),

        runTransaction: jest.fn().mockImplementation(async (fn) => {
            // Simple mock: pass a tx object that delegates to the underlying docs map
            const tx = {
                get: (ref) => ref.get(),
                set: (ref, data) => {
                    docs.set(ref.id, data);
                    operationLog.push({ op: 'tx-set', docId: ref.id, data });
                },
                update: (ref, patch) => {
                    const existing = docs.get(ref.id) || {};
                    docs.set(ref.id, { ...existing, ...patch });
                    operationLog.push({ op: 'tx-update', docId: ref.id, patch });
                }
            };
            return await fn(tx);
        }),

        batch: jest.fn().mockImplementation(() => {
            const ops = [];
            return {
                delete: (ref) => {
                    ops.push({ op: 'batch-delete', docId: ref.id });
                },
                commit: jest.fn().mockImplementation(() => {
                    ops.forEach(({ docId }) => {
                        docs.delete(docId);
                        operationLog.push({ op: 'batch-delete', docId });
                    });
                    return Promise.resolve();
                })
            };
        }),

        _docs: docs,
        _operationLog: operationLog,
        _collectionRef: collectionRef,
        _size: () => docs.size
    };

    return db;
}

// ==================== TESTS ====================

describe('DelayedCallQueue — Faz 1.1 + 1.2', () => {

    describe('enqueue', () => {
        test('ilk enqueue → status=pending, attempts=0, doc oluşturuldu', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            const result = await queue.enqueue({
                platform: 'GetirYemek',
                orderId: 'ORDER-1',
                branchId: 'BRANCH-1',
                action: 'prepare',
                earliestAt: new Date(Date.now() + 60_000)
            });

            expect(result.success).toBe(true);
            expect(result.alreadyQueued).toBe(false);
            expect(result.queueId).toBe('GetirYemek_ORDER-1_prepare');
            expect(db._size()).toBe(1);

            const doc = db._docs.get('GetirYemek_ORDER-1_prepare');
            expect(doc.status).toBe('pending');
            expect(doc.attempts).toBe(0);
            expect(doc.maxAttempts).toBe(5);
            expect(doc.platform).toBe('GetirYemek');
            expect(doc.action).toBe('prepare');
        });

        test('idempotent — aynı docId 2x → ikincisi alreadyQueued=true, doc 1 tane', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            const earliestAt = new Date(Date.now() + 60_000);
            const args = {
                platform: 'GetirYemek',
                orderId: 'ORDER-2',
                branchId: 'BRANCH-1',
                action: 'deliver',
                earliestAt
            };

            const r1 = await queue.enqueue(args);
            const r2 = await queue.enqueue(args);

            expect(r1.alreadyQueued).toBe(false);
            expect(r2.alreadyQueued).toBe(true);
            expect(r2.queueId).toBe('GetirYemek_ORDER-2_deliver');
            expect(db._size()).toBe(1); // tek doc
        });

        test('invalid platform reject', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await expect(queue.enqueue({
                platform: 'YemekSepeti',
                orderId: 'X',
                branchId: 'B',
                action: 'prepare',
                earliestAt: new Date()
            })).rejects.toThrow(/invalid platform/);
        });

        test('invalid action reject', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await expect(queue.enqueue({
                platform: 'GetirYemek',
                orderId: 'X',
                branchId: 'B',
                action: 'foobar',
                earliestAt: new Date()
            })).rejects.toThrow(/invalid action/);
        });

        test('eksik orderId reject', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await expect(queue.enqueue({
                platform: 'GetirYemek',
                orderId: '',
                branchId: 'B',
                action: 'prepare',
                earliestAt: new Date()
            })).rejects.toThrow();
        });
    });

    describe('markProcessing', () => {
        test('pending → processing geçişi başarılı', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O3', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });

            const claimed = await queue.markProcessing('GetirYemek_O3_prepare');
            expect(claimed).toBe(true);

            const doc = db._docs.get('GetirYemek_O3_prepare');
            expect(doc.status).toBe('processing');
        });

        test('zaten processing ise false döner (race protection)', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O4', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });

            const r1 = await queue.markProcessing('GetirYemek_O4_prepare');
            const r2 = await queue.markProcessing('GetirYemek_O4_prepare');

            expect(r1).toBe(true);
            expect(r2).toBe(false);
        });

        test('var olmayan doc → false', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            const claimed = await queue.markProcessing('NONEXISTENT');
            expect(claimed).toBe(false);
        });
    });

    describe('markCompleted', () => {
        test('status=completed, completedAt set', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O5', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });
            await queue.markProcessing('GetirYemek_O5_prepare');

            const ok = await queue.markCompleted('GetirYemek_O5_prepare');
            expect(ok).toBe(true);

            const doc = db._docs.get('GetirYemek_O5_prepare');
            expect(doc.status).toBe('completed');
            expect(doc.completedAt).toBe('SERVER_TIMESTAMP');
        });
    });

    describe('markFailed — exponential backoff', () => {
        test('attempts<max → backoff, status=pending kalır', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O6', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });

            const result = await queue.markFailed('GetirYemek_O6_prepare', 'API 500');
            expect(result.success).toBe(true);
            expect(result.finalState).toBe('pending');
            expect(result.attempts).toBe(1);
            expect(result.backoffSeconds).toBe(30); // 2^0 * 30 = 30

            const doc = db._docs.get('GetirYemek_O6_prepare');
            expect(doc.status).toBe('pending');
            expect(doc.attempts).toBe(1);
            expect(doc.lastError).toBe('API 500');
        });

        test('backoff exponential — 2. fail = 60sn, 3. fail = 120sn', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O7', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });

            const r1 = await queue.markFailed('GetirYemek_O7_prepare', 'err1');
            expect(r1.backoffSeconds).toBe(30);

            const r2 = await queue.markFailed('GetirYemek_O7_prepare', 'err2');
            expect(r2.backoffSeconds).toBe(60);

            const r3 = await queue.markFailed('GetirYemek_O7_prepare', 'err3');
            expect(r3.backoffSeconds).toBe(120);
        });

        test('attempts=max → status=failed, retry yok', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'O8', branchId: 'B', action: 'prepare',
                earliestAt: new Date(),
                maxAttempts: 2
            });

            await queue.markFailed('GetirYemek_O8_prepare', 'err1');
            const r2 = await queue.markFailed('GetirYemek_O8_prepare', 'err2');

            expect(r2.finalState).toBe('failed');
            expect(r2.attempts).toBe(2);

            const doc = db._docs.get('GetirYemek_O8_prepare');
            expect(doc.status).toBe('failed');
        });

        test('var olmayan doc → success=false', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            const result = await queue.markFailed('NONEXISTENT', 'err');
            expect(result.success).toBe(false);
        });
    });

    describe('cleanup', () => {
        test('completed > 24h → silinir', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            // Pre-populate one completed doc and one pending doc
            db._docs.set('GetirYemek_OLD_prepare', {
                status: 'completed',
                completedAt: { toDate: () => new Date(Date.now() - 48 * 3600 * 1000) }
            });
            db._docs.set('GetirYemek_NEW_prepare', { status: 'pending' });

            // Override get to return the completed doc as the cleanup target
            db._collectionRef.get.mockResolvedValueOnce({
                empty: false,
                size: 1,
                docs: [
                    {
                        ref: { id: 'GetirYemek_OLD_prepare' },
                        id: 'GetirYemek_OLD_prepare',
                        data: () => db._docs.get('GetirYemek_OLD_prepare')
                    }
                ]
            });

            const result = await queue.cleanup();

            expect(result.deleted).toBe(1);
            expect(db._docs.has('GetirYemek_OLD_prepare')).toBe(false);
            expect(db._docs.has('GetirYemek_NEW_prepare')).toBe(true);
        });

        test('hiç completed yoksa deleted=0', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db);

            db._collectionRef.get.mockResolvedValueOnce({ empty: true, size: 0, docs: [] });

            const result = await queue.cleanup();
            expect(result.deleted).toBe(0);
        });
    });

    describe('static helpers', () => {
        test('buildDocId formatı', () => {
            expect(DelayedCallQueue.buildDocId('GetirYemek', 'ORD-1', 'prepare'))
                .toBe('GetirYemek_ORD-1_prepare');
        });

        test('buildDocId — eksik param throw', () => {
            expect(() => DelayedCallQueue.buildDocId('', 'O', 'a')).toThrow();
            expect(() => DelayedCallQueue.buildDocId('P', '', 'a')).toThrow();
            expect(() => DelayedCallQueue.buildDocId('P', 'O', '')).toThrow();
        });
    });

    describe('constructor', () => {
        test('db olmadan throw', () => {
            expect(() => new DelayedCallQueue()).toThrow(/db handle required/);
            expect(() => new DelayedCallQueue(null)).toThrow();
        });

        test('registry opsiyonel (CRUD-only mode)', () => {
            const db = createMockDb();
            const q = new DelayedCallQueue(db);
            expect(q.registry).toBe(null);
        });
    });

    describe('Worker — start/stop yaşam döngüsü', () => {
        test('registry yoksa start() no-op (worker disabled)', () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db, null);
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            queue.start();
            expect(queue._intervalId).toBe(null);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/worker disabled/i));

            warnSpy.mockRestore();
        });

        test('start() interval kurar, stop() temizler', () => {
            jest.useFakeTimers();
            const db = createMockDb();
            const registry = { getConnector: jest.fn().mockReturnValue(null) };
            const queue = new DelayedCallQueue(db, registry);

            queue.start(5000);
            expect(queue._intervalId).not.toBe(null);

            queue.stop();
            expect(queue._intervalId).toBe(null);

            jest.useRealTimers();
        });

        test('start() iki kez → tek interval', () => {
            jest.useFakeTimers();
            const db = createMockDb();
            const registry = { getConnector: jest.fn().mockReturnValue(null) };
            const queue = new DelayedCallQueue(db, registry);

            queue.start();
            const firstId = queue._intervalId;
            queue.start();
            expect(queue._intervalId).toBe(firstId);

            queue.stop();
            jest.useRealTimers();
        });
    });

    describe('Worker — processQueue', () => {
        function setupReady(db, docId, data) {
            db._docs.set(docId, data);
            db._collectionRef.get.mockResolvedValueOnce({
                empty: false,
                size: 1,
                docs: [{
                    id: docId,
                    data: () => db._docs.get(docId),
                    ref: { id: docId }
                }]
            });
        }

        test('pending+ready doc → connector.executeAction → markCompleted', async () => {
            const db = createMockDb();
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            const registry = {
                getConnector: jest.fn().mockReturnValue({ executeAction })
            };
            const queue = new DelayedCallQueue(db, registry);

            const docId = 'GetirYemek_W1_prepare';
            setupReady(db, docId, {
                platform: 'GetirYemek',
                orderId: 'W1',
                action: 'prepare',
                payload: { foo: 'bar' },
                status: 'pending',
                attempts: 0,
                maxAttempts: 5
            });

            await queue.processQueue();

            expect(registry.getConnector).toHaveBeenCalledWith('getiryemek');
            expect(executeAction).toHaveBeenCalledWith('prepare', 'W1', { foo: 'bar' });
            expect(db._docs.get(docId).status).toBe('completed');
        });

        test('connector executeAction yoksa skip — status pending kalır, attempts 0', async () => {
            const db = createMockDb();
            const registry = {
                // executeAction implement edilmemiş bir connector (Faz 1.4 öncesi)
                getConnector: jest.fn().mockReturnValue({})
            };
            const queue = new DelayedCallQueue(db, registry);

            const docId = 'GetirYemek_W2_prepare';
            setupReady(db, docId, {
                platform: 'GetirYemek',
                orderId: 'W2',
                action: 'prepare',
                payload: {},
                status: 'pending',
                attempts: 0,
                maxAttempts: 5
            });

            await queue.processQueue();

            expect(db._docs.get(docId).status).toBe('pending');
            expect(db._docs.get(docId).attempts).toBe(0); // retry sayacı yenilmedi
        });

        test('executeAction throw → markFailed (backoff)', async () => {
            const db = createMockDb();
            const executeAction = jest.fn().mockRejectedValue(new Error('Getir API 500'));
            const registry = {
                getConnector: jest.fn().mockReturnValue({ executeAction })
            };
            const queue = new DelayedCallQueue(db, registry);

            const docId = 'GetirYemek_W3_prepare';
            setupReady(db, docId, {
                platform: 'GetirYemek',
                orderId: 'W3',
                action: 'prepare',
                payload: {},
                status: 'pending',
                attempts: 0,
                maxAttempts: 5
            });

            await queue.processQueue();

            const after = db._docs.get(docId);
            expect(after.status).toBe('pending');     // henüz max'a varmadı
            expect(after.attempts).toBe(1);
            expect(after.lastError).toMatch(/Getir API 500/);
        });

        test('queue empty → no-op', async () => {
            const db = createMockDb();
            const executeAction = jest.fn();
            const registry = { getConnector: jest.fn().mockReturnValue({ executeAction }) };
            const queue = new DelayedCallQueue(db, registry);

            db._collectionRef.get.mockResolvedValueOnce({ empty: true, size: 0, docs: [] });
            await queue.processQueue();

            expect(executeAction).not.toHaveBeenCalled();
        });

        test('registry yoksa processQueue no-op', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db, null);
            // Should not throw, should not call collection
            await queue.processQueue();
            // collection mock çağrılmamalı
            expect(db.collection).not.toHaveBeenCalled();
        });
    });

    describe('Metrics — Faz 1.6', () => {
        function createMockMetrics() {
            const calls = [];
            return {
                increment: jest.fn().mockImplementation((name, labels) => {
                    calls.push({ name, labels });
                }),
                _calls: calls
            };
        }

        test('enqueue başarılı → enqueue_total artar (already_queued=false)', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const queue = new DelayedCallQueue(db, null, metrics);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'M1', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            });

            expect(metrics.increment).toHaveBeenCalledWith(
                'delayed_call_enqueue_total',
                expect.objectContaining({
                    platform: 'GetirYemek',
                    action: 'prepare',
                    already_queued: 'false'
                })
            );
        });

        test('enqueue idempotent (alreadyQueued=true) → counter already_queued=true label', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const queue = new DelayedCallQueue(db, null, metrics);

            const args = {
                platform: 'GetirYemek', orderId: 'M2', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            };
            await queue.enqueue(args);
            await queue.enqueue(args);

            const idempotent = metrics._calls.find(c =>
                c.name === 'delayed_call_enqueue_total' && c.labels.already_queued === 'true'
            );
            expect(idempotent).toBeDefined();
        });

        test('processQueue → executeAction success → processed_total artar', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const executeAction = jest.fn().mockResolvedValue({ ok: true });
            const registry = { getConnector: jest.fn().mockReturnValue({ executeAction }) };
            const queue = new DelayedCallQueue(db, registry, metrics);

            const docId = 'GetirYemek_MP1_prepare';
            db._docs.set(docId, {
                platform: 'GetirYemek', orderId: 'MP1', action: 'prepare',
                payload: {}, status: 'pending', attempts: 0, maxAttempts: 5
            });
            db._collectionRef.get.mockResolvedValueOnce({
                empty: false, size: 1,
                docs: [{ id: docId, data: () => db._docs.get(docId), ref: { id: docId } }]
            });

            await queue.processQueue();

            const processed = metrics._calls.find(c => c.name === 'delayed_call_processed_total');
            expect(processed).toBeDefined();
            expect(processed.labels).toEqual({ platform: 'GetirYemek', action: 'prepare' });
        });

        test('executeAction fail (retry, max dolmadı) → failed_total ARTMAZ', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const executeAction = jest.fn().mockRejectedValue(new Error('Getir 500'));
            const registry = { getConnector: jest.fn().mockReturnValue({ executeAction }) };
            const queue = new DelayedCallQueue(db, registry, metrics);

            const docId = 'GetirYemek_MF1_prepare';
            db._docs.set(docId, {
                platform: 'GetirYemek', orderId: 'MF1', action: 'prepare',
                payload: {}, status: 'pending', attempts: 0, maxAttempts: 5
            });
            db._collectionRef.get.mockResolvedValueOnce({
                empty: false, size: 1,
                docs: [{ id: docId, data: () => db._docs.get(docId), ref: { id: docId } }]
            });

            await queue.processQueue();

            const failed = metrics._calls.find(c => c.name === 'delayed_call_failed_total');
            expect(failed).toBeUndefined();
        });

        test('executeAction fail (final attempt) → failed_total artar', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const executeAction = jest.fn().mockRejectedValue(new Error('terminal'));
            const registry = { getConnector: jest.fn().mockReturnValue({ executeAction }) };
            const queue = new DelayedCallQueue(db, registry, metrics);

            const docId = 'GetirYemek_MF2_prepare';
            db._docs.set(docId, {
                platform: 'GetirYemek', orderId: 'MF2', action: 'prepare',
                payload: {}, status: 'pending', attempts: 4, maxAttempts: 5  // 5. fail final olacak
            });
            db._collectionRef.get.mockResolvedValueOnce({
                empty: false, size: 1,
                docs: [{ id: docId, data: () => db._docs.get(docId), ref: { id: docId } }]
            });

            await queue.processQueue();

            const failed = metrics._calls.find(c => c.name === 'delayed_call_failed_total');
            expect(failed).toBeDefined();
            expect(failed.labels).toEqual({ platform: 'GetirYemek', action: 'prepare' });
        });

        test('metrics null geçirilirse no-op (eski test paterni bozulmaz)', async () => {
            const db = createMockDb();
            const queue = new DelayedCallQueue(db); // metrics yok
            await expect(queue.enqueue({
                platform: 'GetirYemek', orderId: 'NM', branchId: 'B', action: 'prepare',
                earliestAt: new Date()
            })).resolves.toBeDefined();
        });

        test('setMetrics ile late-bind çalışır', async () => {
            const db = createMockDb();
            const metrics = createMockMetrics();
            const queue = new DelayedCallQueue(db);
            queue.setMetrics(metrics);

            await queue.enqueue({
                platform: 'GetirYemek', orderId: 'LB', branchId: 'B', action: 'verify',
                earliestAt: new Date()
            });

            expect(metrics.increment).toHaveBeenCalled();
        });
    });

    describe('Worker — in-memory lock', () => {
        test('aynı doc paralel iki processOne → ikincisi skip', async () => {
            const db = createMockDb();
            let resolveExecute;
            const executeAction = jest.fn().mockImplementation(() =>
                new Promise(res => { resolveExecute = res; })
            );
            const registry = { getConnector: jest.fn().mockReturnValue({ executeAction }) };
            const queue = new DelayedCallQueue(db, registry);

            const docId = 'GetirYemek_W4_prepare';
            db._docs.set(docId, {
                platform: 'GetirYemek',
                orderId: 'W4',
                action: 'prepare',
                payload: {},
                status: 'pending',
                attempts: 0,
                maxAttempts: 5
            });

            const fakeDoc = { id: docId, data: () => db._docs.get(docId), ref: { id: docId } };

            // İlk çağrıyı başlat (executeAction promise'i pending)
            const p1 = queue._processOne(fakeDoc);

            // Mikrotask kuyruğunu drain et: markProcessing tamamlansın, executeAction çağrılsın
            await new Promise(resolve => setImmediate(resolve));

            expect(executeAction).toHaveBeenCalledTimes(1);
            expect(queue._inMemoryLocks.has(docId)).toBe(true);

            // İkinci çağrıyı başlat — lock var, hemen return etmeli
            const p2 = queue._processOne(fakeDoc);
            await p2;

            // p2 lock yüzünden return etti, executeAction sayısı hâlâ 1
            expect(executeAction).toHaveBeenCalledTimes(1);

            // İlk çağrıyı bitir
            resolveExecute({ ok: true });
            await p1;

            expect(queue._inMemoryLocks.has(docId)).toBe(false);
        });
    });
});
