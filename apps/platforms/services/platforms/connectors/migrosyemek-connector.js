// ==================================================================================
// MIGROS YEMEK PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');
const migrosCrypto = require('../migros-crypto');

const API_TIMEOUT = 15000; // 15 seconds

class MigrosYemekConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('migrosyemek', db, registry);

        this.config = {
            baseUrl: process.env.MIGROS_YEMEK_API_URL || 'https://gourmet.migrosonline.com'
        };
    }

    // ==================== ORDER TRANSFORMATION ====================

    /**
     * Migros Yemek Order Created webhook payload'ını standart PlatformOrder formatına dönüştürür.
     * Kritik: Fiyatlar kuruş (penny) cinsinden gelir → TL'ye çevirilir.
     */
    transformOrder(rawOrder, branchId) {
        const now = new Date();
        const createdAt = rawOrder.log?.createdAsMs
            ? new Date(rawOrder.log.createdAsMs).toISOString()
            : now.toISOString();

        // WPF (MigrosYemekOrdersFirestoreService.GetMigrosYemekOrdersAsync) restart sonrası
        // sipariş yüklerken `orderJson` alanından MigrosYemekOrder deserialize ediyor.
        // Migros webhook payload field isimleri (id, customer, items, payment, prices,
        // extendedProperties, log) WPF'deki [JsonPropertyName] attribute'larıyla bire bir
        // eşleşiyor → raw payload direkt serialize edilebilir.
        const orderJson = JSON.stringify(rawOrder);

        // Penny → TL dönüşümü
        const totalPenny = rawOrder.prices?.total?.amountAsPenny || 0;
        const discountedPenny = rawOrder.prices?.discounted?.amountAsPenny || 0;
        const totalTL = totalPenny / 100;
        const discountedTL = discountedPenny / 100;
        const finalAmount = discountedTL > 0 ? discountedTL : totalTL;

        const customer = rawOrder.customer || {};
        const address = customer.deliveryAddress || {};
        const geo = address.geoLocation || {};
        const extended = rawOrder.extendedProperties || {};
        const payment = rawOrder.payment?.type || {};

        return {
            // WPF restart için full-fidelity raw payload (deserialize edilebilir)
            orderJson: orderJson,

            OrderId: String(rawOrder.id || ''),
            OrderToken: String(rawOrder.id || ''),
            OrderDate: createdAt,
            IsScheduled: false,
            branchId: branchId,

            // Customer info
            Customer: {
                FirstName: customer.firstName || '',
                LastName: customer.lastName || '',
                Phone: customer.phoneNumber || '',
                Email: '',
                Address: {
                    FullAddress: this._buildFullAddress(address),
                    City: address.city?.name || '',
                    District: address.district?.name || '',
                    Neighborhood: address.town?.name || '',
                    Street: '',
                    BuildingNo: '',
                    Floor: '',
                    DoorNo: '',
                    Directions: address.direction || address.detail || '',
                    Latitude: geo.latitude || 0,
                    Longitude: geo.longitude || 0
                }
            },

            // Items — penny → TL
            Items: (rawOrder.items || []).map(item => ({
                Name: item.name || '',
                Quantity: item.amount || 1,
                UnitPrice: (item.unitPrice || 0) / 100,
                TotalPrice: (item.price || 0) / 100,
                Note: item.note || '',
                Options: this._flattenOptions(item.options || [])
            })),

            // Amounts (TL)
            TotalAmount: finalAmount,
            DeliveryFee: 0,
            DiscountAmount: totalTL > discountedTL && discountedTL > 0 ? totalTL - discountedTL : 0,

            // Delivery info
            PaymentMethod: payment.simplifiedName || payment.name || '',
            DeliveryType: rawOrder.deliveryProvider === 'RESTAURANT' ? 'RESTAURANT_DELIVERY' : 'PLATFORM_DELIVERY',
            CourierType: rawOrder.deliveryProvider || 'MIGROS',
            Note: extended.orderNote || '',

            // Platform specific
            Status: 'NEW',
            EstimatedDeliveryTime: null,
            CourierInfo: null,
            DeliveryProvider: rawOrder.deliveryProvider || '',
            ShortCode: extended.shortCode || '',

            // Extended properties
            SaveGreen: extended.saveGreen || false,
            ContactlessDelivery: extended.contactlessDelivery || false,
            RingDoorBell: extended.ringDoorBell !== false,

            // Flat customer fields (WPF/Android compatibility)
            CustomerName: customer.fullName || `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
            CustomerPhone: customer.phoneNumber || '',
            CustomerAddress: this._buildFullAddress(address),
            CustomerCity: address.city?.name || '',
            CustomerDistrict: address.district?.name || '',
            CustomerLatitude: geo.latitude || 0,
            CustomerLongitude: geo.longitude || 0,
            CustomerDirections: address.direction || address.detail || '',

            // Status flags
            IsAccepted: false,
            IsPrepared: false,
            IsDelivered: false,

            // Counters
            ItemCount: (rawOrder.items || []).length,
            TotalQuantity: (rawOrder.items || []).reduce((sum, i) => sum + (parseInt(i.amount) || 0), 0)
        };
    }

    /**
     * Adres parçalarını birleştirir.
     */
    _buildFullAddress(address) {
        const parts = [];
        if (address.direction) parts.push(address.direction);
        if (address.detail) parts.push(address.detail);
        if (address.district?.name) parts.push(address.district.name);
        if (address.town?.name) parts.push(address.town.name);
        if (address.city?.name) parts.push(address.city.name);
        return parts.filter(Boolean).join(', ');
    }

    /**
     * Migros opsiyonlarını düzleştirir (sonsuz derinlik subOptions → flat list).
     * Hiyerarşi bilgisi Id/ParentId/IsMainHeader alanlarıyla korunur — WPF
     * tarafında parent-by-id map ile tree yeniden kurulabilir.
     * `orderJson` yazılamazsa (Firestore 1MB limit vb.) bu field'lar yedek.
     */
    _flattenOptions(options, parentId = null) {
        const result = [];
        for (const opt of options) {
            const optId = opt.objectOptionItemId || opt.optionItemId || 0;
            result.push({
                Name: opt.headerName || '',
                Value: opt.itemNames || '',
                Price: (opt.primaryPrice || 0) / 100,
                IsExcluded: opt.excluded || false,
                OptionType: opt.optionType || 'NONE',
                Quantity: opt.quantity || 0,
                // Hiyerarşi bilgisi (WPF tree reconstruction için)
                Id: optId,
                ParentId: parentId || opt.parentObjectOptionItemId || null,
                IsMainHeader: opt.objectOptionHeaderIsMainHeader === true
            });
            // Recursive: alt opsiyonları da ekle, parentId olarak bu opsiyonun id'si
            if (opt.subOptions && opt.subOptions.length > 0) {
                result.push(...this._flattenOptions(opt.subOptions, optId));
            }
        }
        return result;
    }

    // ==================== API METHODS ====================

    /**
     * Migros API header'larını oluşturur — XApiKey + şifrelenmiş body gerekir.
     */
    _getHeaders(branchConfig) {
        return {
            'Content-Type': 'application/json',
            'XApiKey': branchConfig.apiKey || ''
        };
    }

    /**
     * Şifreli POST isteği gönderir.
     */
    async _postEncrypted(endpoint, body, branchConfig) {
        const secretKey = branchConfig.secretKey || process.env.MIGROS_YEMEK_SECRET_KEY;
        if (!secretKey) {
            console.log('[MigrosYemek] No secret key configured');
            return null;
        }

        const jsonBody = JSON.stringify(body);
        const encryptedPayload = migrosCrypto.wrapForPost(jsonBody, secretKey);

        const response = await axios.post(
            `${this.config.baseUrl}${endpoint}`,
            encryptedPayload,
            {
                headers: this._getHeaders(branchConfig),
                timeout: API_TIMEOUT
            }
        );

        return response.data;
    }

    async acceptOrder(orderId, branchConfig = {}) {
        if (!branchConfig.apiKey) {
            console.log('[MigrosYemek] No API key configured');
            return { success: false, reason: 'no_api_key' };
        }

        try {
            const result = await this._postEncrypted('/Order/v2/UpdateOrderStatus', {
                orderId: parseInt(orderId),
                orderStatus: 'Approved',
                storeId: branchConfig.storeId || 0
            }, branchConfig);

            if (result?.success) {
                await this.updateOrderStatus(orderId, 'ACCEPTED');
                console.log(`[MigrosYemek] Order accepted: ${orderId}`);
                return { success: true, orderId, response: result };
            }

            console.log(`[MigrosYemek] Accept failed: ${result?.errorMessage?.errorDetail || 'unknown'}`);
            return { success: false, reason: result?.errorMessage?.errorDetail || 'api_error' };

        } catch (error) {
            console.error('[MigrosYemek] Accept error:', error.message);
            return { success: false, reason: error.response?.data?.errorMessage?.errorDetail || error.message };
        }
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        if (!branchConfig.apiKey) {
            return { success: false, reason: 'no_api_key' };
        }

        try {
            const result = await this._postEncrypted('/Order/v2/UpdateOrderStatus', {
                orderId: parseInt(orderId),
                orderStatus: 'Rejected',
                storeId: branchConfig.storeId || 0,
                cancelReasonId: parseInt(reason) || 0
            }, branchConfig);

            if (result?.success) {
                await this.updateOrderStatus(orderId, 'REJECTED', { rejectReason: reason });
                console.log(`[MigrosYemek] Order rejected: ${orderId} - reason: ${reason}`);
                return { success: true, orderId, response: result };
            }

            return { success: false, reason: result?.errorMessage?.errorDetail || 'api_error' };

        } catch (error) {
            console.error('[MigrosYemek] Reject error:', error.message);
            return { success: false, reason: error.response?.data?.errorMessage?.errorDetail || error.message };
        }
    }

    async markOrderReady(orderId, branchConfig = {}) {
        if (!branchConfig.apiKey) {
            return { success: false, reason: 'no_api_key' };
        }

        try {
            const result = await this._postEncrypted('/Order/v2/UpdateOrderStatus', {
                orderId: parseInt(orderId),
                orderStatus: 'Prepared',
                storeId: branchConfig.storeId || 0
            }, branchConfig);

            if (result?.success) {
                await this.updateOrderStatus(orderId, 'PREPARED');
                console.log(`[MigrosYemek] Order prepared: ${orderId}`);
                return { success: true, orderId, response: result };
            }

            return { success: false, reason: result?.errorMessage?.errorDetail || 'api_error' };

        } catch (error) {
            console.error('[MigrosYemek] Prepared error:', error.message);
            return { success: false, reason: error.response?.data?.errorMessage?.errorDetail || error.message };
        }
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        if (!branchConfig.apiKey) {
            return { success: false, reason: 'no_api_key' };
        }

        try {
            // Delivery = kurye yola çıktı (sadece RESTAURANT delivery provider için)
            const result = await this._postEncrypted('/Order/v2/UpdateOrderStatus', {
                orderId: parseInt(orderId),
                orderStatus: 'Delivery',
                storeId: branchConfig.storeId || 0
            }, branchConfig);

            if (result?.success) {
                await this.updateOrderStatus(orderId, 'PICKED_UP');
                console.log(`[MigrosYemek] Order picked up: ${orderId}`);
                return { success: true, orderId, response: result };
            }

            return { success: false, reason: result?.errorMessage?.errorDetail || 'api_error' };

        } catch (error) {
            console.error('[MigrosYemek] PickedUp error:', error.message);
            return { success: false, reason: error.response?.data?.errorMessage?.errorDetail || error.message };
        }
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        if (!branchConfig.apiKey) {
            return { success: false, reason: 'no_api_key' };
        }

        try {
            const result = await this._postEncrypted('/Order/v2/UpdateOrderStatus', {
                orderId: parseInt(orderId),
                orderStatus: 'Completed',
                storeId: branchConfig.storeId || 0
            }, branchConfig);

            if (result?.success) {
                await this.updateOrderStatus(orderId, 'DELIVERED');
                console.log(`[MigrosYemek] Order delivered: ${orderId}`);
                return { success: true, orderId, response: result };
            }

            return { success: false, reason: result?.errorMessage?.errorDetail || 'api_error' };

        } catch (error) {
            console.error('[MigrosYemek] Delivered error:', error.message);
            return { success: false, reason: error.response?.data?.errorMessage?.errorDetail || error.message };
        }
    }
}

module.exports = MigrosYemekConnector;
