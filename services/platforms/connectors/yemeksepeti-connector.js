// ==================================================================================
// YEMEKSEPETI PLATFORM CONNECTOR
// ==================================================================================

const BasePlatformConnector = require('../base-connector');
const axios = require('axios');

const API_TIMEOUT = 10000; // 10 seconds

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
        const rawDelivery = rawOrder.delivery || null;
        const deliveryAddress = rawDelivery?.address || rawOrder.customer?.address || null;

        // DEBUG: Log raw delivery & payment from DH API
        console.log(`[YS-CONNECTOR DEBUG] Raw delivery object:`, JSON.stringify(rawDelivery, null, 2)?.substring(0, 500));
        console.log(`[YS-CONNECTOR DEBUG] Raw payment object:`, JSON.stringify(rawOrder.payment));
        console.log(`[YS-CONNECTOR DEBUG] Raw delivery.deliveryMainArea: '${rawDelivery?.deliveryMainArea}', rawOrder.deliveryMainArea: '${rawOrder.deliveryMainArea}'`);
        console.log(`[YS-CONNECTOR DEBUG] deliveryAddress:`, JSON.stringify(deliveryAddress, null, 2)?.substring(0, 500));

        // Address building - DH API sends deliveryMainArea inside delivery object
        const latitude = rawOrder.latitude || rawDelivery?.latitude || deliveryAddress?.latitude || 0;
        const longitude = rawOrder.longitude || rawDelivery?.longitude || deliveryAddress?.longitude || 0;
        const rawDeliveryMainArea = deliveryAddress?.deliveryMainArea || rawDelivery?.deliveryMainArea || rawOrder.deliveryMainArea || '';
        // DH API sends "Altayçeşme İstanbul" - strip city name if it matches the city field
        const cityVal = deliveryAddress?.city || rawDelivery?.city || rawOrder.city || '';
        const deliveryMainArea = (cityVal && rawDeliveryMainArea.endsWith(' ' + cityVal))
            ? rawDeliveryMainArea.slice(0, -(cityVal.length + 1)).trim()
            : rawDeliveryMainArea;
        const deliveryArea = deliveryAddress?.deliveryArea || rawDelivery?.deliveryArea || rawOrder.deliveryArea || '';
        const deliveryInstructions = rawDelivery?.deliveryInstructions || rawOrder.deliveryInstructions || deliveryAddress?.deliveryInstructions || '';

        const street = deliveryAddress?.street || rawDelivery?.street || rawOrder.street || '';
        const streetNumber = deliveryAddress?.number || rawDelivery?.number || rawOrder.number || '';
        const city = deliveryAddress?.city || rawDelivery?.city || rawOrder.city || '';
        const district = deliveryAddress?.district || rawDelivery?.district || rawOrder.district || '';
        const neighborhood = deliveryAddress?.neighborhood || '';
        const building = deliveryAddress?.building || rawDelivery?.building || rawOrder.building || '';
        const entrance = deliveryAddress?.entrance || rawDelivery?.entrance || rawOrder.entrance || '';
        const floor = deliveryAddress?.floor || rawDelivery?.floor || rawOrder.floor || '';
        const flatNumber = deliveryAddress?.flatNumber || rawDelivery?.flatNumber || rawOrder.flatNumber || '';
        const intercom = deliveryAddress?.intercom || rawDelivery?.intercom || rawOrder.intercom || '';

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
                    Neighborhood: neighborhood || deliveryMainArea || '',
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

            // Delivery object - WPF reads delivery.deliveryMainArea, delivery.address etc.
            Delivery: {
                deliveryMainArea: deliveryMainArea,
                deliveryArea: deliveryArea,
                street: rawDelivery?.street || '',
                number: rawDelivery?.number || '',
                building: rawDelivery?.building || '',
                entrance: rawDelivery?.entrance || '',
                floor: rawDelivery?.floor || '',
                city: rawDelivery?.city || '',
                postcode: rawDelivery?.postcode || '',
                latitude: latitude,
                longitude: longitude,
                deliveryInstructions: deliveryInstructions,
                address: deliveryAddress ? {
                    latitude: deliveryAddress.latitude || 0,
                    longitude: deliveryAddress.longitude || 0,
                    street: deliveryAddress.street || '',
                    city: deliveryAddress.city || '',
                    district: deliveryAddress.district || '',
                    neighborhood: deliveryAddress.neighborhood || '',
                    area: deliveryAddress.area || '',
                    postcode: deliveryAddress.postcode || '',
                    fullAddress: deliveryAddress.fullAddress || fullAddress,
                    building: deliveryAddress.building || '',
                    floor: deliveryAddress.floor || '',
                    doorNumber: deliveryAddress.doorNumber || deliveryAddress.flatNumber || '',
                    addressDescription: deliveryAddress.addressDescription || deliveryAddress.deliveryInstructions || ''
                } : null
            },

            // Payment object - WPF reads payment.type (Turkish text from DH API)
            Payment: rawOrder.payment ? {
                type: rawOrder.payment.type || '',
                remoteCode: rawOrder.payment.remoteCode || '',
                status: rawOrder.payment.status || ''
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
                    Price: parseFloat(o.price) || 0,
                    Type: o.type || ''
                }))
            })),

            // Amounts
            TotalAmount: parseFloat(rawOrder.price?.grandTotal) || 0,
            DeliveryFee: parseFloat(rawOrder.price?.deliveryFee) || 0,
            DiscountAmount: parseFloat(rawOrder.price?.discountAmountTotal) || 0,

            // Delivery info
            PaymentMethod: rawOrder.payment?.type || rawOrder.paymentMethod || 'ONLINE',
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
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: API_TIMEOUT }
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
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: API_TIMEOUT
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
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: API_TIMEOUT
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
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: API_TIMEOUT
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
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: API_TIMEOUT
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
                { headers: { 'Authorization': `Bearer ${token}` }, timeout: API_TIMEOUT }
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
