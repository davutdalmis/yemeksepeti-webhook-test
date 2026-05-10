// ==================================================================================
// PHONE PLATFORM CONNECTOR — Plan 30
// ==================================================================================
// Telefon siparişleri Yemigo'nun kendi kanalı (sabit hat, WhatsApp, sosyal medya).
// WPF PhoneOrderPage Firestore'a yazıyor (`tableOrders/{branchId}_Telefon_*`); Railway
// sadece dispatch tarafında devreye giriyor. Bu connector minimal:
//   - getCollectionName() → "tableOrders" (default 'phoneOrders' yerine)
//   - getOrder(orderId) → tableOrders doc'unu standart format'a çevirir (lat/lng dispatch için)
//   - assignCourier(orderId, courierId, courierName) → BasePlatformConnector'dan miras
//     (camelCase assignedCourierId/Name yazar, transaction + activeOrderCount + lastAssignedAt)
//   - acceptOrder/rejectOrder/markOrderReady/* → no-op (gerçek API yok, status WPF tarafı)
//
// Plan 29 dispatch (smartDispatchService.assignBestCourier) platform-agnostik tasarlandı,
// sadece connector kayıt + getCollectionName override yeterli.

const BasePlatformConnector = require('../base-connector');

class PhoneConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('phone', db, registry);
    }

    /**
     * tableOrders koleksiyonu — WPF PhoneOrderPage burada yazıyor.
     * BasePlatformConnector.getCollectionName() default switch'inde 'phone' yok,
     * override ederek doğru koleksiyonu işaret ediyoruz.
     */
    getCollectionName() {
        return 'tableOrders';
    }

    /**
     * Telefon siparişi WPF tarafından oluşturuluyor → Railway transformOrder akışına girmez.
     * Defensive olarak rawOrder'ı olduğu gibi döndür (orders-api yanlışlıkla çağırırsa kırılmasın).
     */
    transformOrder(rawOrder, branchId) {
        return rawOrder;
    }

    /**
     * orders-api auto-assign body'de coordinates yoksa connector.getOrder()'a düşer.
     * tableOrders doc'unu okuyup orders-api'nin beklediği şemaya (Customer.Address.Latitude/Longitude)
     * adapte ediyoruz. WPF camelCase yazdığı için (customerLatitude/customerLongitude) burada
     * map ediyoruz.
     */
    async getOrder(orderId) {
        if (!this.db) return null;
        try {
            const doc = await this.db.collection('tableOrders').doc(orderId).get();
            if (!doc.exists) return null;
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                // orders-api shape uyumu — auto-assign deliveryLocation çıkarımı için
                Customer: {
                    Address: {
                        Latitude: data.customerLatitude || 0,
                        Longitude: data.customerLongitude || 0
                    }
                },
                // Push notification için müşteri bilgisi
                CustomerName: data.customerName || '',
                CustomerPhone: data.customerPhone || '',
                CustomerAddress: data.customerAddress || ''
            };
        } catch (error) {
            console.error('[phone] getOrder error:', error.message);
            return null;
        }
    }

    // ==================== NO-OP API METHODS ====================
    // Telefon siparişi gerçek bir 3rd party API'ye sahip değil — status transition'larını
    // WPF yerel olarak yönetir. Connector lifecycle method'ları no-op (success döner ki
    // dispatch-queue retry akışı bunları "başarısız" diye yorumlamasın).

    async acceptOrder(orderId, branchConfig = {}) {
        return { success: true, orderId, reason: 'phone_no_external_api' };
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        return { success: true, orderId, reason: 'phone_no_external_api' };
    }

    async markOrderReady(orderId, branchConfig = {}) {
        return { success: true, orderId, reason: 'phone_no_external_api' };
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        return { success: true, orderId, reason: 'phone_no_external_api' };
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        return { success: true, orderId, reason: 'phone_no_external_api' };
    }
}

module.exports = PhoneConnector;
