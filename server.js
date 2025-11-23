require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const orders = new Map();
const getirYemekWebhooks = [];

// YemekSepeti API Configuration
const YEMEKSEPETI_CONFIG = {
    baseUrl: process.env.YEMEKSEPETI_BASE_URL || 'https://integration-middleware.stg.restaurant-partners.com',
    chainCode: process.env.YEMEKSEPETI_CHAIN_CODE || '',
    username: process.env.YEMEKSEPETI_USERNAME || '',
    password: process.env.YEMEKSEPETI_PASSWORD || '',
    checkIntervalMinutes: parseInt(process.env.YEMEKSEPETI_CHECK_INTERVAL_MINUTES) || 5
};

let yemeksepetiToken = null;
let tokenExpiry = null;

// ==================== YEMEKSEPETI API ====================

async function getYemekSepetiToken() {
    if (yemeksepetiToken && tokenExpiry && Date.now() < tokenExpiry) {
        return yemeksepetiToken;
    }

    if (!YEMEKSEPETI_CONFIG.username || !YEMEKSEPETI_CONFIG.password) {
        console.log('[YemekSepeti] Missing credentials');
        return null;
    }

    try {
        const response = await axios.post(
            `${YEMEKSEPETI_CONFIG.baseUrl}/v2/login`,
            new URLSearchParams({
                username: YEMEKSEPETI_CONFIG.username,
                password: YEMEKSEPETI_CONFIG.password,
                grant_type: 'client_credentials'
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        yemeksepetiToken = response.data.access_token;
        tokenExpiry = Date.now() + (25 * 60 * 1000);
        console.log('[YemekSepeti] Token refreshed');
        return yemeksepetiToken;
    } catch (error) {
        console.error('[YemekSepeti] Token error:', error.message);
        return null;
    }
}

async function checkOrderStatus(orderId) {
    const token = await getYemekSepetiToken();
    if (!token || !YEMEKSEPETI_CONFIG.chainCode) return null;

    try {
        const response = await axios.get(
            `${YEMEKSEPETI_CONFIG.baseUrl}/v2/chains/${YEMEKSEPETI_CONFIG.chainCode}/orders/${orderId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        return response.data.order;
    } catch (error) {
        if (error.response?.status === 404) {
            return { status: 'NOT_FOUND' };
        }
        console.error(`[YemekSepeti] Order check error (${orderId}):`, error.message);
        return null;
    }
}

async function validateOrdersWithYemekSepeti() {
    if (orders.size === 0) return;

    console.log(`[YemekSepeti] Validating ${orders.size} orders...`);
    const ordersToDelete = [];

    for (const [orderId, orderData] of orders.entries()) {
        if (orderData.status !== 'NEW') continue;

        const orderToken = orderData.order.OrderToken;
        if (!orderToken) continue;

        const apiOrderData = await checkOrderStatus(orderToken);
        if (!apiOrderData) continue;

        if (apiOrderData.status === 'NOT_FOUND' || apiOrderData.status === 'cancelled') {
            ordersToDelete.push(orderId);
        } else if (apiOrderData.status === 'accepted') {
            orderData.status = 'ACCEPTED';
        }
    }

    ordersToDelete.forEach(id => orders.delete(id));
    if (ordersToDelete.length > 0) {
        console.log(`[YemekSepeti] Deleted ${ordersToDelete.length} cancelled orders`);
    }
}

setInterval(() => {
    validateOrdersWithYemekSepeti().catch(err => {
        console.error('[YemekSepeti] Validation error:', err.message);
    });
}, YEMEKSEPETI_CONFIG.checkIntervalMinutes * 60 * 1000);

setTimeout(() => {
    validateOrdersWithYemekSepeti().catch(err => {
        console.error('[YemekSepeti] Initial validation error:', err.message);
    });
}, 30000);

// ==================== YEMEKSEPETI WEBHOOKS ====================

app.post('/order/:remoteId', (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;

    console.log('[YemekSepeti] New order:', order.code || order.token);

    const baseUrl = req.get('host').includes('localhost')
        ? `http://localhost:${PORT}`
        : `http://${req.get('host')}`;

    const now = new Date();
    const transformedOrder = {
        OrderId: order.code || order.token || '',
        RemoteOrderId: `${remoteId}_${order.token}_${Date.now()}`,
        OrderToken: order.token || '',
        VendorId: remoteId || '',
        ChainCode: '',
        OrderDate: order.createdAt || now.toISOString(),
        CreatedAt: now.toISOString(),
        ScheduledDeliveryTime: order.scheduledDeliveryTime || null,
        IsScheduled: order.isScheduled || false,
        Customer: order.customer ? {
            FirstName: order.customer.firstName || '',
            LastName: order.customer.lastName || '',
            Phone: order.customer.mobilePhone || order.customer.phone || '',
            Email: order.customer.email || '',
            Address: order.customer.address ? {
                FullAddress: order.customer.address.fullAddress || '',
                City: order.customer.address.city || '',
                District: order.customer.address.district || '',
                Street: order.customer.address.street || '',
                BuildingNo: order.customer.address.buildingNo || '',
                ApartmentNo: order.customer.address.apartmentNo || '',
                Floor: order.customer.address.floor || '',
                DoorNo: order.customer.address.doorNo || '',
                Latitude: order.customer.address.latitude || 0,
                Longitude: order.customer.address.longitude || 0
            } : null
        } : null,
        Items: (order.products || []).map(p => ({
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
        TotalAmount: parseFloat(order.price?.grandTotal) || 0,
        DeliveryFee: parseFloat(order.price?.deliveryFee) || 0,
        DiscountAmount: parseFloat(order.price?.discount) || 0,
        PaymentMethod: order.payment?.type || 'ONLINE',
        DeliveryType: order.expeditionType === 'pickup' ? 'PICKUP' : 'DELIVERY',
        CourierType: 'VENDOR',
        Note: order.comments?.customerComment || '',
        PlatformOrderId: order.id || null,
        CallbackUrls: order.callbackUrls || {
            orderAcceptedUrl: `${baseUrl}/test-callbacks/order-accepted/${order.token}`,
            orderRejectedUrl: `${baseUrl}/test-callbacks/order-rejected/${order.token}`,
            orderPreparedUrl: `${baseUrl}/test-callbacks/order-prepared/${order.token}`,
            orderPickedUpUrl: `${baseUrl}/test-callbacks/order-pickedup/${order.token}`
        }
    };

    const orderId = order.token;
    orders.set(orderId, {
        order: transformedOrder,
        status: 'NEW',
        createdAt: new Date()
    });

    res.status(200).json({
        remoteResponse: {
            remoteOrderId: `${remoteId}_${order.token}_${Date.now()}`
        }
    });
});

app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', (req, res) => {
    console.log('[YemekSepeti] Order status update:', req.body.status);
    res.status(200).send('OK');
});

app.get('/menuimport/:remoteId', (req, res) => {
    console.log('[YemekSepeti] Menu import request');
    res.status(202).send('Accepted');
});

app.get('/api/yemeksepeti/pending-orders', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const newOrders = Array.from(orders.values())
        .filter(item => item.status === 'NEW')
        .map(item => ({
            ...item.order,
            CreatedAt: item.createdAt.toISOString()
        }));

    console.log(`[YemekSepeti] Polling: ${newOrders.length} NEW orders`);
    res.json({ success: true, count: newOrders.length, orders: newOrders });
});

app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (orders.has(req.params.orderId)) {
        orders.delete(req.params.orderId);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// ==================== GETIRYEMEK WEBHOOKS ====================

app.post('/webhook/newOrder', (req, res) => {
    const order = req.body;
    // GetirYemek header göndermiyorsa default key kullan
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || 'bc19c0303e194594d027b365a95015b53edaf5a2';

    // DEBUG: Full webhook body'sini log'la
    console.log('[GetirYemek] New order webhook received');
    console.log('[GetirYemek] Full body:', JSON.stringify(order, null, 2));
    console.log('[GetirYemek] Headers:', JSON.stringify(req.headers, null, 2));

    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'newOrder',
        data: { foodOrder: order },
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });

    res.status(200).send('OK');
});

app.post('/webhook/cancelOrder', (req, res) => {
    const order = req.body;
    // GetirYemek header göndermiyorsa default key kullan
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || 'bc19c0303e194594d027b365a95015b53edaf5a2';

    console.log('[GetirYemek] Order cancelled:', order.id);

    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'cancelOrder',
        data: { foodOrder: order },
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });

    res.status(200).send('OK');
});

app.post('/webhook/courierArrival', (req, res) => {
    const notification = req.body;
    // GetirYemek header göndermiyorsa default key kullan
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || 'bc19c0303e194594d027b365a95015b53edaf5a2';

    console.log('[GetirYemek] Courier arrival:', notification.orderId);

    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'courierArrival',
        data: notification,
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });

    res.status(200).send('OK');
});

app.get('/poll/webhooks', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const restaurantSecretKey = req.query.restaurantSecretKey;

    if (apiKey !== 'bafetto-pos-getiryemek-2024-stable-key-d0025f3ffa8172ac') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const filteredWebhooks = restaurantSecretKey
        ? getirYemekWebhooks.filter(w => w.restaurantSecretKey === restaurantSecretKey)
        : getirYemekWebhooks;

    console.log(`[GetirYemek] Polling: ${filteredWebhooks.length} webhooks`);
    res.json({ success: true, webhooks: filteredWebhooks });
});

app.delete('/api/getiryemek/webhooks/:webhookId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-pos-getiryemek-2024-stable-key-d0025f3ffa8172ac') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const index = getirYemekWebhooks.findIndex(w => w.id === req.params.webhookId);
    if (index !== -1) {
        getirYemekWebhooks.splice(index, 1);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// ==================== TEST CALLBACKS ====================

app.post('/test-callbacks/order-accepted/:orderId', (req, res) => {
    if (orders.has(req.params.orderId)) {
        const orderData = orders.get(req.params.orderId);
        orderData.status = 'ACCEPTED';
        orderData.acceptedAt = new Date();
    }
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

app.post('/test-callbacks/order-rejected/:orderId', (req, res) => {
    if (orders.has(req.params.orderId)) {
        const orderData = orders.get(req.params.orderId);
        orderData.status = 'REJECTED';
        orderData.rejectedAt = new Date();
    }
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

app.post('/test-callbacks/order-prepared/:orderId', (req, res) => {
    if (orders.has(req.params.orderId)) {
        const orderData = orders.get(req.params.orderId);
        orderData.status = 'PREPARED';
        orderData.preparedAt = new Date();
    }
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

app.post('/test-callbacks/order-pickedup/:orderId', (req, res) => {
    if (orders.has(req.params.orderId)) {
        const orderData = orders.get(req.params.orderId);
        orderData.status = 'PICKED_UP';
        orderData.pickedUpAt = new Date();
    }
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

// ==================== HEALTH & INFO ====================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'Restaurant Webhook Server' });
});

app.get('/', (req, res) => {
    const ordersByStatus = {};
    orders.forEach(item => {
        ordersByStatus[item.status] = (ordersByStatus[item.status] || 0) + 1;
    });

    res.json({
        service: 'Restaurant Webhook & Polling Server',
        yemeksepeti: {
            totalOrders: orders.size,
            ordersByStatus: ordersByStatus
        },
        getiryemek: {
            pendingWebhooks: getirYemekWebhooks.length
        },
        endpoints: {
            yemeksepeti: {
                webhook: 'POST /order/:remoteId',
                polling: 'GET /api/yemeksepeti/pending-orders'
            },
            getiryemek: {
                webhooks: ['POST /webhook/newOrder', 'POST /webhook/cancelOrder', 'POST /webhook/courierArrival'],
                polling: 'GET /poll/webhooks?restaurantSecretKey=xxx',
                delete: 'DELETE /api/getiryemek/webhooks/:webhookId'
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
