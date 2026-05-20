// ==================================================================================
// BASE PLATFORM CONNECTOR - Tüm platform connector'ları için base class
// ==================================================================================

const admin = require('firebase-admin');

class BasePlatformConnector {
    constructor(platformId, db, registry) {
        this.platformId = platformId;
        this.db = db;
        this.registry = registry;
        this.collectionName = this.getCollectionName();
    }

    // ==================== ABSTRACT METHODS (Override edilmeli) ====================

    getCollectionName() {
        const collections = {
            'yemeksepeti': 'yemekSepetiOrders',
            'getiryemek': 'getirYemekOrders',
            'trendyolgo': 'trendyolGoOrders',
            'qrmenu': 'qrMenuOrders',
            'migrosyemek': 'migrosYemekOrders'
        };
        return collections[this.platformId] || `${this.platformId}Orders`;
    }

    // Ham sipariş verisini standart formata dönüştür
    transformOrder(rawOrder, branchId) {
        throw new Error('transformOrder() must be implemented by subclass');
    }

    // Platform API'sine sipariş kabul bildirimi gönder
    async acceptOrder(orderId, branchConfig) {
        throw new Error('acceptOrder() must be implemented by subclass');
    }

    // Platform API'sine sipariş reddetme bildirimi gönder
    async rejectOrder(orderId, reason, branchConfig) {
        throw new Error('rejectOrder() must be implemented by subclass');
    }

    // Platform API'sine sipariş hazır bildirimi gönder
    async markOrderReady(orderId, branchConfig) {
        throw new Error('markOrderReady() must be implemented by subclass');
    }

    // Platform API'sine kurye yola çıktı bildirimi gönder
    async markOrderPickedUp(orderId, branchConfig) {
        throw new Error('markOrderPickedUp() must be implemented by subclass');
    }

    // Platform API'sine sipariş teslim edildi bildirimi gönder
    async markOrderDelivered(orderId, branchConfig) {
        throw new Error('markOrderDelivered() must be implemented by subclass');
    }

    // ==================== COMMON METHODS ====================

    // Siparişi Firebase'e yaz
    async writeOrderToFirebase(order, branchId) {
        if (!this.db) {
            console.log(`[${this.platformId}] Firebase disabled - skipping write`);
            return { success: false, reason: 'firebase_disabled' };
        }

        try {
            const orderId = order.OrderId || order.id || `${this.platformId}_${Date.now()}`;

            // Duplicate check (direct doc lookup — faster than query)
            const existingDoc = await this.db.collection(this.collectionName).doc(orderId).get();

            if (existingDoc.exists) {
                console.log(`[${this.platformId}] Order already exists: ${orderId}`);
                return { success: true, reason: 'duplicate_skipped', orderId };
            }

            // Firebase document
            const firebaseOrder = {
                ...order,
                Platform: this.platformId.toUpperCase(),
                Status: 'NEW',
                IsCancelled: false,
                branchId: branchId || null,
                source: 'railway_webhook',
                updatedBy: 'railway_server',
                // DIAG: hangi Railway service/host yazdığını izle
                _railwayServiceName: process.env.RAILWAY_SERVICE_NAME || null,
                _railwayPublicDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
                _railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
                _railwayGitCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
                CreatedAt: admin.firestore.FieldValue.serverTimestamp(),
                ReceivedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Flat collection'a yaz (branchId field ile filtrelenir)
            await this.db.collection(this.collectionName).doc(orderId).set(firebaseOrder);

            console.log(`[${this.platformId}] Order written to Firebase: ${orderId}`);
            return { success: true, orderId };

        } catch (error) {
            console.error(`[${this.platformId}] Firebase write error:`, error.message);
            return { success: false, reason: error.message };
        }
    }

    // Sipariş durumunu güncelle
    async updateOrderStatus(orderId, status, additionalData = {}) {
        if (!this.db) return { success: false, reason: 'firebase_disabled' };

        try {
            const orderRef = this.db.collection(this.collectionName).doc(orderId);
            const orderDoc = await orderRef.get();

            if (!orderDoc.exists) {
                console.warn(`[${this.platformId}] updateOrderStatus: order_not_found ${orderId}`);
                return { success: false, reason: 'order_not_found' };
            }

            // BEFORE state — flicker analizi için (project_dispatch_disappear_investigation.md)
            // Express'in beklediği alan adlarını birleştirilmiş şekilde dump et.
            const beforeData = orderDoc.data() || {};
            const beforeSummary = {
                Status: beforeData.Status, packageStatus: beforeData.packageStatus,
                rawStatus: beforeData.rawStatus, orderStatus: beforeData.orderStatus,
                IsDelivered: beforeData.IsDelivered, isDelivered: beforeData.isDelivered,
                IsPrepared: beforeData.IsPrepared, isPrepared: beforeData.isPrepared,
                assignedCourierId: beforeData.assignedCourierId || beforeData.AssignedCourierId,
                updatedBy: beforeData.updatedBy
            };

            const updateData = {
                Status: status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...additionalData
            };

            // YemigoSync: Express mapper'ları platform-spesifik field'lara bakar (TG packageStatus,
            // GY rawStatus). Burada Status yazıldığında ama platform field değişmediğinde flicker olur.
            // additionalData içinde packageStatus/rawStatus var mı kontrol etmek için log.
            const additionalKeys = Object.keys(additionalData).join(',');
            console.log(`[${this.platformId}] STATUS-WRITE | orderId=${orderId} | newStatus=${status} | beforeStatus=${beforeData.Status} | beforePackageStatus=${beforeData.packageStatus || '<n/a>'} | beforeRawStatus=${beforeData.rawStatus || '<n/a>'} | additionalKeys=[${additionalKeys}] | before=${JSON.stringify(beforeSummary)}`);

            await orderRef.update(updateData);

            console.log(`[${this.platformId}] Order status updated: ${orderId} -> ${status}`);
            return { success: true, orderId, status, beforeStatus: beforeData.Status };

        } catch (error) {
            console.error(`[${this.platformId}] Status update error:`, error.message);
            return { success: false, reason: error.message };
        }
    }

    // Siparişi iptal et
    async cancelOrder(orderId, reason = 'UNKNOWN') {
        return await this.updateOrderStatus(orderId, 'CANCELLED', {
            IsCancelled: true,
            cancelReason: reason,
            cancelledAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    // ==================================================================
    // KURYE KAPASITE — DRIFT'E BAĞIŞIK GERÇEK SAYIM
    // ==================================================================
    // couriers/{id}.activeOrderCount alanı +1/-1 incremental tutuluyordu.
    // Teslim azaltması SADECE Railway POST /deliver çağrılınca işliyordu;
    // sipariş WPF'ten doğrudan Firestore'a yazılarak kapatılınca azaltma
    // hiç tetiklenmiyor → sayaç sonsuza dek şişiyor → activeCount >= maxCapacity
    // → her atama 'courier_at_capacity' ile reddediliyor (drift bug'ı).
    //
    // Çözüm: kapasite kararını kalıcı (şişebilen) alana göre değil, sipariş
    // koleksiyonlarından hesaplanan GERÇEK aktif sipariş sayısına göre ver.

    // Kuryenin sipariş taşıyabileceği koleksiyonlar.
    static get COURIER_ORDER_COLLECTIONS() {
        return [
            'yemekSepetiOrders',
            'getirYemekOrders',
            'trendyolGoOrders',
            'migrosYemekOrders',
            'fuudyOrders',
            'tableOrders',
            'qrOrders',
        ];
    }

    // Bir sipariş dokümanı terminal (teslim/iptal/kapalı) mı? Capacity DIŞI sayılır.
    static isOrderTerminal(data) {
        if (!data) return true;
        if (data.IsDelivered === true || data.isDelivered === true) return true;
        if (data.IsCancelled === true || data.isCancelled === true) return true;
        // Kapatılmış sipariş referansı varsa POS sipariş akışını bitirmiş demek.
        if (typeof data.closedOrderId === 'string' && data.closedOrderId.length > 0) return true;
        if (typeof data.ClosedOrderId === 'string' && data.ClosedOrderId.length > 0) return true;
        const TERMINAL = new Set([
            'DELIVERED', 'CANCELLED', 'CANCELED', 'REJECTED', 'COMPLETED', 'CLOSED',
        ]);
        const status = String(data.Status || data.status || data.packageStatus || '')
            .trim().toUpperCase();
        return TERMINAL.has(status);
    }

    // Bir kuryenin GERÇEK aktif (terminal olmayan) sipariş sayısını hesapla.
    // Tek-alan sorgusu (assignedCourierId) — composite index gerektirmez;
    // terminal filtresi client-side yapılır (bu codebase'de index'siz tasarım tercih).
    async computeRealActiveOrderCount(courierId) {
        if (!this.db || !courierId) return 0;
        let total = 0;
        for (const collection of BasePlatformConnector.COURIER_ORDER_COLLECTIONS) {
            try {
                const snap = await this.db.collection(collection)
                    .where('assignedCourierId', '==', courierId)
                    .get();
                for (const doc of snap.docs) {
                    if (!BasePlatformConnector.isOrderTerminal(doc.data())) total++;
                }
            } catch (err) {
                // Bir koleksiyon fail olursa diğerleri devam — sayım eksik kalmaktansa
                // devam etmek daha güvenli (capacity guard yine de maxCapacity ile sınırlı).
                console.error(`[${this.platformId}] computeRealActiveOrderCount ${collection} hata:`, err.message);
            }
        }
        return total;
    }

    // Siparişe kurye ata (status değiştirmez - mevcut status korunur)
    // Firestore Transaction ile atomik atama — çift atama riskini önler
    //
    // options.requireUnassigned (default false): true ise transaction içinde sipariş
    // zaten BAŞKA bir kuryedeyse atama reddedilir (`already_assigned` reason). QR
    // self-claim akışı (claim-courier endpoint) bunu kullanır — ön-kontrol ile atama
    // arasındaki TOCTOU yarışını transaction seviyesinde kapatır. Verilmezse mevcut
    // assign-courier davranışı (koşulsuz yeniden atama) aynen korunur.
    async assignCourier(orderId, courierId, courierName, options = {}) {
        if (!this.db) return { success: false, reason: 'firebase_disabled' };

        try {
            // Step 1: Resolve doc ref directly (flat collection)
            const orderRef = this.db.collection(this.collectionName).doc(orderId);
            const orderDoc = await orderRef.get();

            if (!orderDoc.exists) {
                return { success: false, reason: 'order_not_found' };
            }

            const orderRefs = [orderRef];

            // Resolve courier refs (new + old if reassignment)
            let courierRef = null;
            let oldCourierRef = null;
            const orderData = orderDoc.data();
            const oldCourierId = orderData.assignedCourierId;

            // YemigoSync: reassignment teşhisi — kurye değişikliği "geri atıyor" şikayetinin
            // ana sebeplerinden biri (Plan 29 Faz 3 batching, Hungarian global matcher).
            if (oldCourierId && oldCourierId !== courierId) {
                console.warn(`[${this.platformId}] REASSIGN-DETECTED | orderId=${orderId} | oldCourier=${oldCourierId} | newCourier=${courierId} (${courierName}) | currentStatus=${orderData.Status} | isDelivered=${orderData.IsDelivered || orderData.isDelivered}`);
            } else if (!oldCourierId) {
                console.log(`[${this.platformId}] FIRST-ASSIGN | orderId=${orderId} | newCourier=${courierId} (${courierName}) | currentStatus=${orderData.Status}`);
            }

            // Courier doc ref'leri doğrudan couriers root koleksiyonundan çözülür.
            // Eski collectionGroup('couriers').where('branchId').where('isActive') sorgusu
            // composite index istiyordu; index yoksa FAILED_PRECONDITION -> circuit breaker -> 500,
            // ve courier counter sessizce atlanıp activeOrderCount drift ederdi.
            // (memory: project_dispatch_collectionGroup_index_fix — server-v4.js bu fix'i almıştı,
            //  base-connector + orders-api atlanmıştı.) Doğrudan doc lookup hiçbir index gerektirmez.
            courierRef = this.db.collection('couriers').doc(courierId);
            if (oldCourierId && oldCourierId !== courierId) {
                oldCourierRef = this.db.collection('couriers').doc(oldCourierId);
            }

            // Kapasite kararı için GERÇEK aktif sipariş sayısını transaction'dan
            // once hesapla (sipariş koleksiyonu sorguları transaction içinde index
            // ister; ayrıca drift'e bağışık tek doğru kaynak budur).
            // Zaten bu siparişe atanmışsa (idempotent retry) çift saymamak için 1 düş.
            let realActiveCount = await this.computeRealActiveOrderCount(courierId);
            if (orderData.assignedCourierId === courierId && realActiveCount > 0) {
                realActiveCount -= 1;
            }

            // Step 2: Run transaction — atomically check guards + update
            const result = await this.db.runTransaction(async (transaction) => {
                // ÖNEMLI: Firestore transaction'da tüm read'ler write'lardan ÖNCE yapılmalı.
                // Read order inside transaction to check for concurrent assignment
                const orderDoc = await transaction.get(orderRefs[0]);
                if (!orderDoc.exists) {
                    throw new Error('order_not_found');
                }

                // Sahipsizlik guard'ı (QR self-claim) — sipariş zaten BAŞKA kuryedeyse
                // reddet. Ön-kontrol ile bu transaction arasında başka bir atama olmuş
                // olabilir (yarış); bu kontrol kesin kararı transaction içinde verir.
                if (options.requireUnassigned) {
                    const txOrderData = orderDoc.data();
                    if (txOrderData.assignedCourierId
                        && txOrderData.assignedCourierId !== courierId) {
                        throw new Error('already_assigned:' + txOrderData.assignedCourierId);
                    }
                }

                // Guard: check courier capacity + kurye doc'unun var olup olmadığı
                let newCourierExists = false;
                if (courierRef) {
                    const courierDoc = await transaction.get(courierRef);
                    newCourierExists = courierDoc.exists;
                    if (courierDoc.exists) {
                        const courierData = courierDoc.data();
                        // maxPackageCapacity fallback — kurye doc'unda field adı bu olabilir
                        const maxCapacity = courierData.maxCapacity || courierData.maxPackageCapacity || 5;
                        // Kapasite kontrolü kalıcı (drift eden) activeOrderCount alanına
                        // DEĞİL, sipariş koleksiyonlarından hesaplanan gerçek sayıma göre.
                        if (realActiveCount >= maxCapacity) {
                            throw new Error(`courier_at_capacity:${realActiveCount}/${maxCapacity}`);
                        }
                    }
                }

                // Reassignment: eski kurye doc'u var mı — transaction.update yok olan doc'ta fail eder
                let oldCourierExists = false;
                if (oldCourierRef) {
                    const oldCourierDoc = await transaction.get(oldCourierRef);
                    oldCourierExists = oldCourierDoc.exists;
                }

                // All reads done — write
                const updateData = {
                    assignedCourierId: courierId,
                    assignedCourierName: courierName,
                    assignedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                // Update all order docs (usually 1, but could be more)
                for (const ref of orderRefs) {
                    transaction.update(ref, updateData);
                }

                // Yeni kuryenin activeOrderCount'unu GERÇEK değere SET et (increment değil)
                // — bu atamayla birlikte doğru sayı realActiveCount + 1'dir. Böylece
                // sayaç her atamada kendiliğinden gerçeğe sıfırlanır (self-heal).
                // + Plan 29 Faz 1.1 round-robin sinyali (lastAssignedAt).
                if (courierRef && newCourierExists) {
                    transaction.update(courierRef, {
                        activeOrderCount: realActiveCount + 1,
                        lastAssignedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // Decrement old courier's activeOrderCount (reassignment)
                if (oldCourierRef && oldCourierExists) {
                    transaction.update(oldCourierRef, {
                        activeOrderCount: admin.firestore.FieldValue.increment(-1)
                    });
                }

                return { success: true, orderId };
            });

            console.log(`[${this.platformId}] Courier assigned (atomic): ${courierName} -> ${orderId}`);
            return result;
        } catch (error) {
            const reason = error.message || 'unknown_error';

            if (reason.startsWith('already_assigned:')) {
                console.warn(`[${this.platformId}] Order ${orderId} already assigned to ${reason.split(':')[1]}`);
                return { success: false, reason: 'already_assigned', assignedTo: reason.split(':')[1] };
            }
            if (reason.startsWith('courier_at_capacity:')) {
                console.warn(`[${this.platformId}] Courier ${courierName} at capacity: ${reason.split(':')[1]}`);
                return { success: false, reason: 'courier_at_capacity' };
            }

            console.error(`[${this.platformId}] Assign courier error:`, reason);
            return { success: false, reason };
        }
    }

    // Siparişi getir
    async getOrder(orderId) {
        if (!this.db) return null;

        try {
            const ordersSnapshot = await this.db.collectionGroup(this.collectionName)
                .where('OrderId', '==', orderId)
                .get();

            if (ordersSnapshot.empty) return null;

            const doc = ordersSnapshot.docs[0];
            return { id: doc.id, ...doc.data() };

        } catch (error) {
            console.error(`[${this.platformId}] Get order error:`, error.message);
            return null;
        }
    }

    // Branch için aktif siparişleri getir
    async getActiveOrders(branchId) {
        if (!this.db) return [];

        try {
            let query = this.db.collectionGroup(this.collectionName)
                .where('Status', 'in', ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'ASSIGNED', 'PICKED_UP']);

            if (branchId) {
                query = query.where('branchId', '==', branchId);
            }

            const snapshot = await query.get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        } catch (error) {
            console.error(`[${this.platformId}] Get active orders error:`, error.message);
            return [];
        }
    }

    // ==================== WEBHOOK HANDLING ====================

    // Webhook'u işle (override edilebilir)
    async handleWebhook(req, res) {
        const branchId = req.headers['x-branch-id'] || req.query.branchId;

        try {
            // Ham veriyi dönüştür
            const transformedOrder = this.transformOrder(req.body, branchId);

            // Firebase'e yaz
            const result = await this.writeOrderToFirebase(transformedOrder, branchId);

            console.log(`[${this.platformId}] Webhook processed: ${transformedOrder.OrderId}`);

            return {
                success: true,
                orderId: transformedOrder.OrderId,
                firebaseResult: result
            };

        } catch (error) {
            console.error(`[${this.platformId}] Webhook error:`, error.message);
            throw error;
        }
    }
}

module.exports = BasePlatformConnector;
