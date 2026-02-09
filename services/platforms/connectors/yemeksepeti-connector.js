// ==================================================================================
// YEMEKSEPETI PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');

class YemekSepetiConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('yemeksepeti', db, registry);

        // API configuration
        this.config = {
            baseUrl: process.env.YEMEKSEPETI_BASE_URL || 'https://integration-middleware.stg.restaurant-partners.com',
            chainCode: process.env.YEMEKSEPETI_CHAIN_CODE || '',
            username: process.env.YEMEKSEPETI_USERNAME || '',
            password: process.env.YEMEKSEPETI_PASSWORD || ''
        };

        // Token cache
        this.token = null;
        this.tokenExpiry = null;
    }

    // ==================== ORDER TRANSFORMATION ====================

    transformOrder(rawOrder, branchId) {
        const now = new Date();
        const deliveryAddress = rawOrder.delivery?.address || rawOrder.customer?.address || null;

        // Address building
        const latitude = rawOrder.latitude || deliveryAddress?.latitude || 0;
        const longitude = rawOrder.longitude || deliveryAddress?.longitude || 0;
        const deliveryMainArea = rawOrder.deliveryMainArea || '';
        const deliveryInstructions = rawOrder.deliveryInstructions || deliveryAddress?.deliveryInstructions || '';

        const street = deliveryAddress?.street || rawOrder.street || '';
        const streetNumber = deliveryAddress?.number || rawOrder.number || '';
        const city = deliveryAddress?.city || rawOrder.city || '';
        const district = deliveryAddress?.district || rawOrder.district || '';
        const building = deliveryAddress?.building || rawOrder.building || '';
        const entrance = deliveryAddress?.entrance || rawOrder.entrance || '';
        const floor = deliveryAddress?.floor || rawOrder.floor || '';
        const flatNumber = deliveryAddress?.flatNumber || rawOrder.flatNumber || '';
        const intercom = deliveryAddress?.intercom || rawOrder.intercom || '';

        // Build full address
        const addressParts = [];
        if (street) {
            let streetPart = street;
            if (streetNumber) streetPart += ' ' + streetNumber;
            addressParts.push(streetPart);
        }
        if (deliveryMainArea) addressParts.push(deliveryMainArea);
        if (district) addressParts.push(district);
        if (city) addressParts.push(city);

        let fullAddress = addressParts.join(', ');

        const buildingDetails = [];
        if (building) buildingDetails.push(`Bina: ${building}`);
        if (entrance) buildingDetails.push(`Giriş: ${entrance}`);
        if (floor) buildingDetails.push(`Kat: ${floor}`);
        if (flatNumber) buildingDetails.push(`Daire: ${flatNumber}`);
        if (intercom) buildingDetails.push(`Zil: ${intercom}`);

        if (buildingDetails.length > 0) {
            fullAddress += ' - ' + buildingDetails.join(', ');
        }
        if (deliveryInstructions) {
            fullAddress += ` (${deliveryInstructions})`;
        }

        return {
            OrderId: rawOrder.code || rawOrder.token || '',
            OrderToken: rawOrder.token || '',
            VendorId: rawOrder.vendorId || '',
            ChainCode: this.config.chainCode,
            OrderDate: rawOrder.createdAt || now.toISOString(),
            ScheduledDeliveryTime: rawOrder.scheduledDeliveryTime || null,
            IsScheduled: rawOrder.isScheduled || false,
            branchId: branchId,

            // Customer info
            Customer: rawOrder.customer ? {
                FirstName: rawOrder.customer.firstName || rawOrder.customer.name?.split(' ')[0] || '',
                LastName: rawOrder.customer.lastName || rawOrder.customer.name?.split(' ').slice(1).join(' ') || '',
                Phone: rawOrder.customer.mobilePhone || rawOrder.customer.phone || rawOrder.customer.phoneNumber || '',
                Email: rawOrder.customer.email || '',
                Address: {
                    FullAddress: fullAddress,
                    City: city,
                    District: district || deliveryMainArea || '',
                    Neighborhood: deliveryMainArea || '',
                    Street: street,
                    StreetNumber: streetNumber,
                    BuildingNo: building,
                    Entrance: entrance,
                    Floor: floor,
                    DoorNo: flatNumber,
                    Intercom: intercom,
                    Postcode: deliveryAddress?.deliveryAreaPostcode || deliveryAddress?.postcode || '',
                    Directions: deliveryInstructions,
                    Latitude: latitude,
                    Longitude: longitude
                }
            } : null,

            // Items
            Items: (rawOrder.products || []).map(p => ({
                Name: p.name || '',
                Quantity: parseInt(p.quantity) || 0,
                UnitPrice: parseFloat(p.unitPrice) || 0,
                TotalPrice: parseFloat(p.paidPrice) || 0,
                Note: p.description || '',
                Options: (p.selectedToppings || []).map(o => ({
                    Name: o.name || '',
                    Value: o.value || '',
                    Price: parseFloat(o.price) || 0
                }))
            })),

            // Amounts
            TotalAmount: parseFloat(rawOrder.price?.grandTotal) || 0,
            DeliveryFee: parseFloat(rawOrder.price?.deliveryFee) || 0,
            DiscountAmount: parseFloat(rawOrder.price?.discount) || 0,

            // Delivery info
            PaymentMethod: rawOrder.payment?.type || 'ONLINE',
            DeliveryType: rawOrder.expeditionType === 'pickup' ? 'PICKUP' : 'DELIVERY',
            CourierType: 'VENDOR',
            Note: rawOrder.comments?.customerComment || '',

            // Platform specific
            PlatformOrderId: rawOrder.id || null,
            CallbackUrls: rawOrder.callbackUrls || null,

            // Flat customer fields (WPF/Android compatibility)
            CustomerName: rawOrder.customer
                ? [rawOrder.customer.firstName || rawOrder.customer.name?.split(' ')[0] || '',
                   rawOrder.customer.lastName || rawOrder.customer.name?.split(' ').slice(1).join(' ') || ''].join(' ').trim()
                : '',
            CustomerPhone: rawOrder.customer?.mobilePhone || rawOrder.customer?.phone || rawOrder.customer?.phoneNumber || '',
            CustomerEmail: rawOrder.customer?.email || '',
            CustomerAddress: fullAddress,
            CustomerCity: city,
            CustomerDistrict: district || deliveryMainArea || '',
            CustomerLatitude: latitude,
            CustomerLongitude: longitude,
            CustomerDirections: deliveryInstructions,

            // Status flags
            IsAccepted: false,
            IsPrepared: false,
            IsDelivered: false,

            // Counters
            ItemCount: (rawOrder.products || []).length,
            TotalQuantity: (rawOrder.products || []).reduce((sum, p) => sum + (parseInt(p.quantity) || 0), 0)
        };
    }

    // ==================== API AUTHENTICATION ====================

    async getToken() {
        // Check cache
        if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
            return this.token;
        }

        if (!this.config.username || !this.config.password) {
            console.log('[YemekSepeti] No credentials configured');
            return null;
        }

        try {
            const response = await axios.post(
                `${this.config.baseUrl}/v2/login`,
                new URLSearchParams({
                    username: this.config.username,
                    password: this.config.password,
                    grant_type: 'client_credentials'
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
            );

            this.token = response.data.access_token;
            this.tokenExpiry = Date.now() + (25 * 60 * 1000); // 25 minutes
            console.log('[YemekSepeti] Token refreshed');
            return this.token;

        } catch (error) {
            console.error('[YemekSepeti] Token error:', error.message);
            return null;
        }
    }

    // ==================== API METHODS ====================

    async acceptOrder(orderId, branchConfig = {}) {
        const token = await this.getToken();
        if (!token) return { success: false, reason: 'no_token' };

        try {
            const callbackUrl = branchConfig.acceptCallbackUrl;
            if (callbackUrl) {
                await axios.post(callbackUrl, {}, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }

            await this.updateOrderStatus(orderId, 'ACCEPTED');
            console.log(`[YemekSepeti] Order accepted: ${orderId}`);
            return { success: true, orderId };

        } catch (error) {
            console.error('[YemekSepeti] Accept error:', error.message);
            return { success: false, reason: error.message };
        }
    }

    async rejectOrder(orderId, reason, branchConfig = {}) {
        const token = await this.getToken();
        if (!token) return { success: false, reason: 'no_token' };

        try {
            const callbackUrl = branchConfig.rejectCallbackUrl;
            if (callbackUrl) {
                await axios.post(callbackUrl, { reason }, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }

            await this.updateOrderStatus(orderId, 'REJECTED', { rejectReason: reason });
            console.log(`[YemekSepeti] Order rejected: ${orderId} - ${reason}`);
            return { success: true, orderId };

        } catch (error) {
            console.error('[YemekSepeti] Reject error:', error.message);
            return { success: false, reason: error.message };
        }
    }

    async markOrderReady(orderId, branchConfig = {}) {
        const token = await this.getToken();
        if (!token) return { success: false, reason: 'no_token' };

        try {
            const callbackUrl = branchConfig.preparedCallbackUrl;
            if (callbackUrl) {
                await axios.post(callbackUrl, {}, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }

            await this.updateOrderStatus(orderId, 'READY');
            console.log(`[YemekSepeti] Order ready: ${orderId}`);
            return { success: true, orderId };

        } catch (error) {
            console.error('[YemekSepeti] Ready error:', error.message);
            return { success: false, reason: error.message };
        }
    }

    async markOrderPickedUp(orderId, branchConfig = {}) {
        const token = await this.getToken();
        if (!token) return { success: false, reason: 'no_token' };

        try {
            const callbackUrl = branchConfig.pickedUpCallbackUrl;
            if (callbackUrl) {
                await axios.post(callbackUrl, {}, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }

            await this.updateOrderStatus(orderId, 'PICKED_UP');
            console.log(`[YemekSepeti] Order picked up: ${orderId}`);
            return { success: true, orderId };

        } catch (error) {
            console.error('[YemekSepeti] Pickup error:', error.message);
            return { success: false, reason: error.message };
        }
    }

    async markOrderDelivered(orderId, branchConfig = {}) {
        await this.updateOrderStatus(orderId, 'DELIVERED');
        console.log(`[YemekSepeti] Order delivered: ${orderId}`);
        return { success: true, orderId };
    }

    // ==================== STATUS CHECK ====================

    async checkOrderStatus(orderToken) {
        const token = await this.getToken();
        if (!token || !this.config.chainCode) return null;

        try {
            const response = await axios.get(
                `${this.config.baseUrl}/v2/chains/${this.config.chainCode}/orders/${orderToken}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            return response.data.order;

        } catch (error) {
            if (error.response?.status === 404) {
                return { status: 'NOT_FOUND' };
            }
            return null;
        }
    }
}

module.exports = YemekSepetiConnector;
