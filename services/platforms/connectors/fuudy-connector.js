// ==================================================================================
// FUUDY PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');

const API_TIMEOUT = 10000; // 10 seconds

class FuudyConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('fuudy', db, registry);

        // API configuration
        this.config = {
            baseUrl: process.env.FUUDY_API_URL || 'https://api.fuudy.com.tr'
        };
    }

    // ==================== ORDER TRANSFORMATION ====================

    transformOrder(rawOrder, branchId) {
        const now = new Date();

        return {
            OrderId: String(rawOrder.id || ''),
            OrderToken: String(rawOrder.id || ''),
            OrderDate: rawOrder.created_at || now.toISOString(),
            IsScheduled: false,
            branchId: branchId,

            // Customer info
            Customer: {
                FirstName: rawOrder.customer?.name || '',
                LastName: '',
                Phone: rawOrder.customer?.phone || '',
                Email: '',
                Address: {
                    FullAddress: rawOrder.address?.address || '',
                    City: rawOrder.address?.city_name || '',
                    District: rawOrder.address?.district_name || '',
                    Neighborhood: rawOrder.address?.neighborhood_name || '',
                    Street: '',
                    BuildingNo: '',
                    Floor: '',
                    DoorNo: '',
                    Directions: rawOrder.address?.directions || '',
                    Latitude: rawOrder.address?.latitude || 0,
                    Longitude: rawOrder.address?.longitude || 0
                }
            },

            // Items
            Items: (rawOrder.foods || []).map(f => ({
                Name: f.name || '',
                Quantity: f.quantity || 1,
                UnitPrice: f.price || 0,
                TotalPrice: f.total || ((f.price || 0) * (f.quantity || 1)),
                Note: f.note || '',
                Options: (f.option_groups || []).flatMap(group =>
                    (group.options || []).map(opt => ({
                        Name: group.name || '',
                        Value: opt.name || '',
                        Price: opt.price || 0
                    }))
                )
            })),

            // Amounts
            TotalAmount: rawOrder.total || 0,
            DeliveryFee: rawOrder.courier_fee || 0,
            DiscountAmount: rawOrder.discount || 0,

            // Delivery info
            PaymentMethod: rawOrder.payment_method || '',
            DeliveryType: 'DELIVERY',
            CourierType: rawOrder.courier_type || 'PLATFORM',
            Note: rawOrder.note || '',

            // Platform specific
            Status: 'NEW',
            EstimatedDeliveryTime: rawOrder.estimated_delivery_time || null,
            CourierInfo: rawOrder.courier ? {
                Name: rawOrder.courier.name || '',
                Phone: rawOrder.courier.phone || '',
                Latitude: rawOrder.courier.latitude || 0,
                Longitude: rawOrder.courier.longitude || 0
            } : null,

            // Flat customer fields (WPF/Android compatibility)
            CustomerName: rawOrder.customer?.name || '',
            CustomerPhone: rawOrder.customer?.phone || '',
            CustomerAddress: rawOrder.address?.address || '',
            CustomerCity: rawOrder.address?.city_name || '',
            CustomerDistrict: rawOrder.address?.district_name || '',
            CustomerLatitude: rawOrder.address?.latitude || 0,
            CustomerLongitude: rawOrder.address?.longitude || 0,
            CustomerDirections: rawOrder.address?.directions || '',

            // Status flags
            IsAccepted: false,
            IsPrepared: false,
            IsDelivered: false,

            // Counters
            ItemCount: (rawOrder.foods || []).length,
            TotalQuantity: (rawOrder.foods || []).reduce((sum, f) => sum + (parseInt(f.quantity) || 0), 0)
        };
    }

    // ==================== API METHODS ====================

    _getHeaders(branchConfig) {
        return {
            'Content-Type': 'application/json',
            'Access-Token': branchConfig.accessToken || ''
        };
    }

    async acceptOrder(orderId, branchConfig = {}) {
        if (!branchConfig.accessToken) {
            console.log('[Fuudy] No access token configured');
            return { success: false, reason: 'no_access_token' };
        }

        try {
            const response = await axios.put(
                `${this.config.baseUrl}/orders/accept/${orderId}`,
                {
                    preparing_time: branchConfig.preparingTime || 30
                },
                {
                    headers: this._getHeaders(branchConfig),
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'ACCEPTED');
            console.log(`[Fuudy] Order accepted: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[Fuudy] Accept error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        if (!branchConfig.accessToken) {
            return { success: false, reason: 'no_access_token' };
        }

        try {
            const response = await axios.put(
                `${this.config.baseUrl}/orders/cancel/${orderId}`,
                {
                    reason_id: reason || 'OTHER'
                },
                {
                    headers: this._getHeaders(branchConfig),
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'REJECTED', { rejectReason: reason });
            console.log(`[Fuudy] Order rejected: ${orderId} - ${reason}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[Fuudy] Reject error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderReady(orderId, branchConfig = {}) {
        // Fuudy doesn't have a "ready" state - no-op
        console.log(`[Fuudy] markOrderReady is a no-op for Fuudy (order: ${orderId})`);
        return { success: true, orderId, reason: 'no_op' };
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        if (!branchConfig.accessToken) {
            return { success: false, reason: 'no_access_token' };
        }

        try {
            const response = await axios.put(
                `${this.config.baseUrl}/orders/ontheway/${orderId}`,
                {},
                {
                    headers: this._getHeaders(branchConfig),
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'PICKED_UP');
            console.log(`[Fuudy] Order picked up: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[Fuudy] PickedUp error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        if (!branchConfig.accessToken) {
            return { success: false, reason: 'no_access_token' };
        }

        try {
            const response = await axios.put(
                `${this.config.baseUrl}/orders/complete/${orderId}`,
                {},
                {
                    headers: this._getHeaders(branchConfig),
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'DELIVERED');
            console.log(`[Fuudy] Order delivered: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[Fuudy] Delivered error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }
}

module.exports = FuudyConnector;
