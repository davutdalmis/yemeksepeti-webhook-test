// ==================================================================================
// GETIRYEMEK PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');

const API_TIMEOUT = 10000; // 10 seconds

class GetirYemekConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('getiryemek', db, registry);

        // API configuration
        this.config = {
            baseUrl: process.env.GETIRYEMEK_API_URL || 'https://food-external-api.getir.com',
            defaultRestaurantSecret: process.env.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET || null
        };
    }

    // ==================== ORDER TRANSFORMATION ====================

    transformOrder(rawOrder, branchId) {
        const now = new Date();

        return {
            OrderId: rawOrder.id || '',
            OrderToken: rawOrder.id || '',
            OrderDate: rawOrder.createdAt || now.toISOString(),
            IsScheduled: rawOrder.isScheduled || false,
            ScheduledDeliveryTime: rawOrder.scheduledDeliveryTime || null,
            branchId: branchId,

            // Customer info
            Customer: {
                FirstName: rawOrder.client?.name?.split(' ')[0] || '',
                LastName: rawOrder.client?.name?.split(' ').slice(1).join(' ') || '',
                Phone: rawOrder.client?.clientPhoneNumber || rawOrder.client?.maskedPhoneNumber || '',
                Email: '',
                Address: {
                    FullAddress: rawOrder.client?.deliveryAddress?.address || '',
                    City: rawOrder.client?.deliveryAddress?.city || '',
                    District: rawOrder.client?.deliveryAddress?.district || '',
                    Neighborhood: rawOrder.client?.deliveryAddress?.neighborhood || '',
                    Street: rawOrder.client?.deliveryAddress?.street || '',
                    BuildingNo: rawOrder.client?.deliveryAddress?.building || '',
                    Floor: rawOrder.client?.deliveryAddress?.floor || '',
                    DoorNo: rawOrder.client?.deliveryAddress?.door || '',
                    Directions: rawOrder.client?.deliveryAddress?.directions || '',
                    Latitude: rawOrder.client?.deliveryAddress?.latitude || 0,
                    Longitude: rawOrder.client?.deliveryAddress?.longitude || 0
                }
            },

            // Items
            Items: (rawOrder.products || []).map(p => ({
                Name: p.name || '',
                Quantity: p.count || 1,
                UnitPrice: p.price || 0,
                TotalPrice: (p.price || 0) * (p.count || 1),
                Note: p.note || '',
                Options: (p.optionCategories || []).flatMap(cat =>
                    (cat.options || []).map(opt => ({
                        Name: cat.name || '',
                        Value: opt.name || '',
                        Price: opt.price || 0
                    }))
                )
            })),

            // Amounts
            TotalAmount: rawOrder.totalPrice || 0,
            DeliveryFee: rawOrder.courierFee || 0,
            DiscountAmount: rawOrder.discountAmount || 0,

            // Delivery info
            PaymentMethod: rawOrder.paymentMethodText || (rawOrder.paymentMethod === 2 ? 'CASH' : 'ONLINE'),
            DeliveryType: rawOrder.isScheduled ? 'SCHEDULED' : 'DELIVERY',
            CourierType: 'PLATFORM', // Getir kendi kuryesini kullanır
            Note: rawOrder.clientNote || '',

            // Platform specific
            Status: this.mapGetirStatus(rawOrder.status),
            EstimatedDeliveryTime: rawOrder.estimatedDeliveryTime || null,
            CourierInfo: rawOrder.courier ? {
                Name: rawOrder.courier.name || '',
                Phone: rawOrder.courier.phoneNumber || '',
                Latitude: rawOrder.courier.location?.latitude || 0,
                Longitude: rawOrder.courier.location?.longitude || 0
            } : null
        };
    }

    mapGetirStatus(getirStatus) {
        const statusMap = {
            310: 'PENDING_APPROVAL',
            320: 'APPROVED',
            325: 'SCHEDULED',
            350: 'SCHEDULED_APPROVED',
            400: 'NEW',
            500: 'PREPARING',
            550: 'READY',
            600: 'COURIER_PICKED_UP',
            700: 'ON_THE_WAY',
            800: 'COURIER_ARRIVED',
            900: 'DELIVERED',
            1500: 'CANCELLED',
            1600: 'CANCELLED_BY_RESTAURANT'
        };
        return statusMap[getirStatus] || 'NEW';
    }

    // ==================== API METHODS ====================

    async acceptOrder(orderId, branchConfig = {}) {
        const restaurantSecret = branchConfig.restaurantSecretKey || this.config.defaultRestaurantSecret;

        if (!restaurantSecret) {
            console.log('[GetirYemek] No restaurant secret configured');
            return { success: false, reason: 'no_secret' };
        }

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/restaurants/orders/${orderId}/verify`,
                {},
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-restaurant-secret-key': restaurantSecret
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'ACCEPTED');
            console.log(`[GetirYemek] Order accepted: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[GetirYemek] Accept error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        const restaurantSecret = branchConfig.restaurantSecretKey || this.config.defaultRestaurantSecret;

        if (!restaurantSecret) {
            return { success: false, reason: 'no_secret' };
        }

        // Map reason to Getir reason codes
        const reasonCodes = {
            'BUSY': 1,
            'CLOSING_SOON': 2,
            'OUT_OF_STOCK': 3,
            'OTHER': 4
        };

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/restaurants/orders/${orderId}/reject`,
                {
                    rejectOptionId: reasonCodes[reason] || 4,
                    rejectNote: reason
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-restaurant-secret-key': restaurantSecret
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'REJECTED', { rejectReason: reason });
            console.log(`[GetirYemek] Order rejected: ${orderId} - ${reason}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[GetirYemek] Reject error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderReady(orderId, branchConfig = {}) {
        const restaurantSecret = branchConfig.restaurantSecretKey || this.config.defaultRestaurantSecret;

        if (!restaurantSecret) {
            return { success: false, reason: 'no_secret' };
        }

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/restaurants/orders/${orderId}/prepare`,
                {},
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-restaurant-secret-key': restaurantSecret
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'READY');
            console.log(`[GetirYemek] Order ready: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[GetirYemek] Ready error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        // Getir uses platform courier - pickup is automatic
        await this.updateOrderStatus(orderId, 'PICKED_UP');
        console.log(`[GetirYemek] Order picked up: ${orderId}`);
        return { success: true, orderId };
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        // Getir handles delivery confirmation
        await this.updateOrderStatus(orderId, 'DELIVERED');
        console.log(`[GetirYemek] Order delivered: ${orderId}`);
        return { success: true, orderId };
    }

    // ==================== RESTAURANT STATUS ====================

    async setRestaurantStatus(status, branchConfig = {}) {
        const restaurantSecret = branchConfig.restaurantSecretKey || this.config.defaultRestaurantSecret;

        if (!restaurantSecret) {
            return { success: false, reason: 'no_secret' };
        }

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/restaurants/status`,
                { status: status }, // 'open', 'closed', 'busy'
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-restaurant-secret-key': restaurantSecret
                    },
                    timeout: API_TIMEOUT
                }
            );

            console.log(`[GetirYemek] Restaurant status changed: ${status}`);
            return { success: true, status, response: response.data };

        } catch (error) {
            console.error('[GetirYemek] Status change error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }
}

module.exports = GetirYemekConnector;
