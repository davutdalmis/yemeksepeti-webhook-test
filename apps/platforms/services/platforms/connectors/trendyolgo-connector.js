// ==================================================================================
// TRENDYOLGO PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');

const API_TIMEOUT = 10000; // 10 seconds

class TrendyolGoConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('trendyolgo', db, registry);

        // API configuration
        this.config = {
            baseUrl: process.env.TRENDYOLGO_API_URL || 'https://api.trendyol.com/sapigw/suppliers',
            supplierId: process.env.TRENDYOLGO_SUPPLIER_ID || ''
        };
    }

    // ==================== ORDER TRANSFORMATION ====================

    transformOrder(rawOrder, branchId) {
        const now = new Date();

        // Trendyol uses "lines" for order items
        const items = rawOrder.lines || rawOrder.items || [];

        return {
            OrderId: rawOrder.id || rawOrder.packageId || rawOrder.orderNumber || '',
            OrderToken: rawOrder.id || rawOrder.packageId || '',
            PackageId: rawOrder.packageId || rawOrder.id,
            OrderNumber: rawOrder.orderNumber || '',
            OrderDate: rawOrder.orderDate || rawOrder.createdAt || now.toISOString(),
            IsScheduled: false,
            branchId: branchId,

            // Customer info
            Customer: {
                FirstName: rawOrder.recipientName?.split(' ')[0] || rawOrder.customerFirstName || '',
                LastName: rawOrder.recipientName?.split(' ').slice(1).join(' ') || rawOrder.customerLastName || '',
                Phone: rawOrder.recipientPhone || rawOrder.customerPhone || '',
                Email: rawOrder.customerEmail || '',
                Address: {
                    FullAddress: rawOrder.deliveryAddress || rawOrder.shippingAddress?.fullAddress || '',
                    City: rawOrder.city || rawOrder.shippingAddress?.city || '',
                    District: rawOrder.district || rawOrder.shippingAddress?.district || '',
                    Neighborhood: rawOrder.neighborhood || rawOrder.shippingAddress?.neighborhood || '',
                    Street: '',
                    Directions: rawOrder.addressNote || rawOrder.shippingAddress?.addressNote || '',
                    Latitude: rawOrder.latitude || 0,
                    Longitude: rawOrder.longitude || 0
                }
            },

            // Items
            Items: items.map(line => ({
                Name: line.productName || line.name || '',
                Barcode: line.barcode || '',
                ProductCode: line.productCode || line.merchantSku || '',
                Quantity: line.quantity || 1,
                UnitPrice: line.price || line.amount || 0,
                TotalPrice: (line.price || line.amount || 0) * (line.quantity || 1),
                Note: line.note || '',
                Options: []
            })),

            // Amounts
            TotalAmount: rawOrder.totalPrice || rawOrder.grossAmount || this.calculateTotal(items),
            DeliveryFee: rawOrder.deliveryFee || 0,
            DiscountAmount: rawOrder.totalDiscount || 0,

            // Delivery info
            PaymentMethod: this.mapPaymentType(rawOrder.paymentType),
            DeliveryType: 'DELIVERY',
            CourierType: rawOrder.cargoProviderName ? 'PLATFORM' : 'VENDOR',
            Note: rawOrder.customerNote || rawOrder.note || '',

            // Platform specific
            Status: this.mapTrendyolStatus(rawOrder.status),
            isDelivered: false,
            CargoProvider: rawOrder.cargoProviderName || null,
            CargoTrackingNumber: rawOrder.cargoTrackingNumber || null,
            InvoiceLink: rawOrder.invoiceLink || null,

            // Flat customer fields (WPF/Android compatibility)
            CustomerName: [
                rawOrder.recipientName?.split(' ')[0] || rawOrder.customerFirstName || '',
                rawOrder.recipientName?.split(' ').slice(1).join(' ') || rawOrder.customerLastName || ''
            ].join(' ').trim() || rawOrder.recipientName || '',
            CustomerPhone: rawOrder.recipientPhone || rawOrder.customerPhone || '',
            CustomerAddress: rawOrder.deliveryAddress || rawOrder.shippingAddress?.fullAddress || '',
            CustomerCity: rawOrder.city || rawOrder.shippingAddress?.city || '',
            CustomerDistrict: rawOrder.district || rawOrder.shippingAddress?.district || '',
            CustomerLatitude: rawOrder.latitude || 0,
            CustomerLongitude: rawOrder.longitude || 0,
            CustomerDirections: rawOrder.addressNote || rawOrder.shippingAddress?.addressNote || '',

            // Status flags
            IsAccepted: false,
            IsPrepared: false,
            IsDelivered: false,

            // Counters
            ItemCount: items.length,
            TotalQuantity: items.reduce((sum, line) => sum + (parseInt(line.quantity) || 0), 0)
        };
    }

    calculateTotal(items) {
        return items.reduce((sum, item) => {
            return sum + ((item.price || item.amount || 0) * (item.quantity || 1));
        }, 0);
    }

    mapPaymentType(paymentType) {
        const paymentMap = {
            1: 'CREDIT_CARD',
            2: 'CASH',
            3: 'TRANSFER',
            4: 'ONLINE'
        };
        return paymentMap[paymentType] || 'ONLINE';
    }

    mapTrendyolStatus(status) {
        const statusMap = {
            'Created': 'NEW',
            'Picking': 'PREPARING',
            'Invoiced': 'READY',
            'Shipped': 'PICKED_UP',
            'Delivered': 'DELIVERED',
            'Cancelled': 'CANCELLED',
            'UnDelivered': 'FAILED_DELIVERY',
            'Returned': 'RETURNED'
        };
        return statusMap[status] || status || 'NEW';
    }

    // ==================== API METHODS ====================

    getAuthHeader(branchConfig = {}) {
        const apiKey = branchConfig.apiKey || process.env.TRENDYOLGO_API_KEY;
        const apiSecret = branchConfig.apiSecret || process.env.TRENDYOLGO_API_SECRET;

        if (!apiKey || !apiSecret) {
            return null;
        }

        const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
        return `Basic ${credentials}`;
    }

    async acceptOrder(orderId, branchConfig = {}) {
        const authHeader = this.getAuthHeader(branchConfig);
        const supplierId = branchConfig.supplierId || this.config.supplierId;

        if (!authHeader || !supplierId) {
            console.log('[TrendyolGo] Missing credentials');
            return { success: false, reason: 'missing_credentials' };
        }

        try {
            // TrendyolGo acceptance endpoint
            const response = await axios.put(
                `${this.config.baseUrl}/${supplierId}/orders/${orderId}/status`,
                { status: 'Picking' },
                {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'ACCEPTED');
            console.log(`[TrendyolGo] Order accepted: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[TrendyolGo] Accept error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        const authHeader = this.getAuthHeader(branchConfig);
        const supplierId = branchConfig.supplierId || this.config.supplierId;

        if (!authHeader || !supplierId) {
            return { success: false, reason: 'missing_credentials' };
        }

        // Map reason to TrendyolGo reason codes
        const reasonCodes = {
            'OUT_OF_STOCK': 1,
            'CUSTOMER_REQUEST': 2,
            'WRONG_PRICE': 3,
            'BUSY': 4,
            'OTHER': 5
        };

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/${supplierId}/orders/${orderId}/cancel`,
                {
                    params: [{
                        id: orderId,
                        reasonId: reasonCodes[reason] || 5,
                        reasonNote: reason
                    }]
                },
                {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'REJECTED', { rejectReason: reason });
            console.log(`[TrendyolGo] Order rejected: ${orderId} - ${reason}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[TrendyolGo] Reject error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderReady(orderId, branchConfig = {}) {
        const authHeader = this.getAuthHeader(branchConfig);
        const supplierId = branchConfig.supplierId || this.config.supplierId;

        if (!authHeader || !supplierId) {
            return { success: false, reason: 'missing_credentials' };
        }

        try {
            const response = await axios.put(
                `${this.config.baseUrl}/${supplierId}/orders/${orderId}/status`,
                { status: 'Invoiced' },
                {
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    timeout: API_TIMEOUT
                }
            );

            await this.updateOrderStatus(orderId, 'READY');
            console.log(`[TrendyolGo] Order ready: ${orderId}`);
            return { success: true, orderId, response: response.data };

        } catch (error) {
            console.error('[TrendyolGo] Ready error:', error.message);
            return { success: false, reason: error.response?.data?.message || error.message };
        }
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        // TrendyolGo handles pickup through cargo integration
        await this.updateOrderStatus(orderId, 'PICKED_UP');
        console.log(`[TrendyolGo] Order picked up: ${orderId}`);
        return { success: true, orderId };
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        await this.updateOrderStatus(orderId, 'DELIVERED');
        console.log(`[TrendyolGo] Order delivered: ${orderId}`);
        return { success: true, orderId };
    }

    // ==================== POLLING ====================

    async fetchNewOrders(branchConfig = {}) {
        const authHeader = this.getAuthHeader(branchConfig);
        const supplierId = branchConfig.supplierId || this.config.supplierId;

        if (!authHeader || !supplierId) {
            return { success: false, reason: 'missing_credentials', orders: [] };
        }

        try {
            // Get orders from last 24 hours
            const startDate = Date.now() - (24 * 60 * 60 * 1000);
            const endDate = Date.now();

            const response = await axios.get(
                `${this.config.baseUrl}/${supplierId}/orders`,
                {
                    params: {
                        startDate,
                        endDate,
                        status: 'Created',
                        page: 0,
                        size: 100
                    },
                    headers: {
                        'Authorization': authHeader,
                        'Content-Type': 'application/json'
                    },
                    timeout: API_TIMEOUT
                }
            );

            const orders = response.data?.content || [];
            console.log(`[TrendyolGo] Fetched ${orders.length} new orders`);

            return {
                success: true,
                orders: orders.map(o => this.transformOrder(o, branchConfig.branchId)),
                totalCount: response.data?.totalElements || orders.length
            };

        } catch (error) {
            console.error('[TrendyolGo] Fetch orders error:', error.message);
            return { success: false, reason: error.message, orders: [] };
        }
    }
}

module.exports = TrendyolGoConnector;
