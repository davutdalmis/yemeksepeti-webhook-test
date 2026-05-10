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

    // Siparişe kurye ata (status değiştirmez - mevcut status korunur)
    // Firestore Transaction ile atomik atama — çift atama riskini önler
    async assignCourier(orderId, courierId, courierName) {
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

            try {
                const courierQuery = await this.db.collectionGroup('couriers')
                    .where('branchId', '==', orderData.branchId)
                    .where('isActive', '==', true)
                    .get();

                const newCourierDoc = courierQuery.docs.find(doc => doc.id === courierId);
                if (newCourierDoc) {
                    courierRef = newCourierDoc.ref;
                }

                // Resolve old courier ref for reassignment (decrement their count)
                if (oldCourierId && oldCourierId !== courierId) {
                    const oldCourierDoc = courierQuery.docs.find(doc => doc.id === oldCourierId);
                    if (oldCourierDoc) {
                        oldCourierRef = oldCourierDoc.ref;
                    }
                }
            } catch (lookupError) {
                console.warn(`[${this.platformId}] Courier lookup failed, proceeding without counter:`, lookupError.message);
            }

            // Step 2: Run transaction — atomically check guards + update
            const result = await this.db.runTransaction(async (transaction) => {
                // Read order inside transaction to check for concurrent assignment
                const orderDoc = await transaction.get(orderRefs[0]);
                if (!orderDoc.exists) {
                    throw new Error('order_not_found');
                }

                const orderData = orderDoc.data();

                // Reassignment: if already assigned to another courier, decrement old courier's count
                // (no longer a guard — allows reassignment atomically)

                // Guard: check courier capacity
                if (courierRef) {
                    const courierDoc = await transaction.get(courierRef);
                    if (courierDoc.exists) {
                        const courierData = courierDoc.data();
                        const maxCapacity = courierData.maxCapacity || 5;
                        const activeCount = courierData.activeOrderCount || 0;
                        if (activeCount >= maxCapacity) {
                            throw new Error(`courier_at_capacity:${activeCount}/${maxCapacity}`);
                        }
                    }
                }

                // All guards passed — write
                const updateData = {
                    assignedCourierId: courierId,
                    assignedCourierName: courierName,
                    assignedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                // Update all order docs (usually 1, but could be more)
                for (const ref of orderRefs) {
                    transaction.update(ref, updateData);
                }

                // Increment new courier's activeOrderCount + Plan 29 Faz 1.1 round-robin sinyali
                if (courierRef) {
                    transaction.update(courierRef, {
                        activeOrderCount: admin.firestore.FieldValue.increment(1),
                        lastAssignedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }

                // Decrement old courier's activeOrderCount (reassignment)
                if (oldCourierRef) {
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
