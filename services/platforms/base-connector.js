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
            'qrmenu': 'qrMenuOrders'
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

            // Duplicate check
            const existingOrder = await this.db.collectionGroup(this.collectionName)
                .where('OrderId', '==', orderId)
                .get();

            if (!existingOrder.empty) {
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
                CreatedAt: admin.firestore.FieldValue.serverTimestamp(),
                ReceivedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Branch path'i bul ve yaz
            if (branchId) {
                const branchQuery = await this.db.collectionGroup('branches')
                    .where('id', '==', branchId)
                    .limit(1)
                    .get();

                if (!branchQuery.empty) {
                    const branchRef = branchQuery.docs[0].ref;
                    await branchRef.collection(this.collectionName).doc(orderId).set(firebaseOrder);
                } else {
                    await this.db.collection(this.collectionName).doc(orderId).set(firebaseOrder);
                }
            } else {
                await this.db.collection(this.collectionName).doc(orderId).set(firebaseOrder);
            }

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
            const ordersSnapshot = await this.db.collectionGroup(this.collectionName)
                .where('OrderId', '==', orderId)
                .get();

            if (ordersSnapshot.empty) {
                return { success: false, reason: 'order_not_found' };
            }

            const updateData = {
                Status: status,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                ...additionalData
            };

            await Promise.all(ordersSnapshot.docs.map(doc => doc.ref.update(updateData)));

            console.log(`[${this.platformId}] Order status updated: ${orderId} -> ${status}`);
            return { success: true, orderId, status };

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
    // Atomically increments courier's activeOrderCount
    async assignCourier(orderId, courierId, courierName) {
        if (!this.db) return { success: false, reason: 'firebase_disabled' };

        try {
            const ordersSnapshot = await this.db.collectionGroup(this.collectionName)
                .where('OrderId', '==', orderId)
                .get();

            if (ordersSnapshot.empty) {
                return { success: false, reason: 'order_not_found' };
            }

            const updateData = {
                assignedCourierId: courierId,
                assignedCourierName: courierName,
                assignedAt: admin.firestore.FieldValue.serverTimestamp()
            };

            // Update order document(s)
            await Promise.all(ordersSnapshot.docs.map(doc => doc.ref.update(updateData)));

            // Atomically increment courier's activeOrderCount
            try {
                const courierQuery = await this.db.collectionGroup('couriers')
                    .where(admin.firestore.FieldPath.documentId(), '==', courierId)
                    .limit(1)
                    .get();

                if (!courierQuery.empty) {
                    await courierQuery.docs[0].ref.update({
                        activeOrderCount: admin.firestore.FieldValue.increment(1)
                    });
                    console.log(`[${this.platformId}] Courier activeOrderCount incremented: ${courierName}`);
                }
            } catch (counterError) {
                // Non-fatal: order is still assigned even if counter update fails
                console.warn(`[${this.platformId}] Failed to increment activeOrderCount for ${courierName}:`, counterError.message);
            }

            console.log(`[${this.platformId}] Courier assigned: ${courierName} -> ${orderId}`);
            return { success: true, orderId };
        } catch (error) {
            console.error(`[${this.platformId}] Assign courier error:`, error.message);
            return { success: false, reason: error.message };
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
