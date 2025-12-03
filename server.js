// Load .env file if exists (optional - Railway uses environment variables)
try { require('dotenv').config(); } catch (e) { }
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const orders = new Map();
const cancellations = new Map(); // YemekSepeti iptal bildirimleri
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
    // Skip validation if no credentials (Railway polling mode only)
    if (!YEMEKSEPETI_CONFIG.username || !YEMEKSEPETI_CONFIG.password || !YEMEKSEPETI_CONFIG.chainCode) {
        console.log('[YemekSepeti] Validation skipped - API credentials not configured (Railway polling mode)');
        return;
    }

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

    console.log('[YemekSepeti] ========== NEW ORDER RECEIVED ==========');
    console.log('[YemekSepeti] Order Code:', order.code || order.token);
    console.log('[YemekSepeti] Remote ID:', remoteId);
    console.log('[YemekSepeti] Full Order Payload:', JSON.stringify(order, null, 2));

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

    console.log('[YemekSepeti] ========== TRANSFORMED ORDER ==========');
    console.log('[YemekSepeti] Customer:', transformedOrder.Customer?.FirstName, transformedOrder.Customer?.LastName);
    console.log('[YemekSepeti] Phone:', transformedOrder.Customer?.Phone);
    console.log('[YemekSepeti] Items:', transformedOrder.Items.length);
    transformedOrder.Items.forEach((item, idx) => {
        console.log(`[YemekSepeti]   ${idx + 1}. ${item.Name} x${item.Quantity} = ${item.TotalPrice} TL`);
    });
    console.log('[YemekSepeti] Total Amount:', transformedOrder.TotalAmount, 'TL');
    console.log('[YemekSepeti] Payment Method:', transformedOrder.PaymentMethod);
    console.log('[YemekSepeti] Delivery Type:', transformedOrder.DeliveryType);
    console.log('[YemekSepeti] ========================================');

    res.status(200).json({
        remoteResponse: {
            remoteOrderId: `${remoteId}_${order.token}_${Date.now()}`
        }
    });
});

// ==================== YEMEKSEPETI ORDER STATUS UPDATE (İPTAL DAHİL) ====================
// Delivery Hero dokümantasyonuna göre: POS plugin'e sipariş durumu güncellemeleri bu endpoint'e gelir
// İptal senaryoları: müşteri iptali, lojistik kaynaklı iptal, 10 dk timeout iptali
app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', (req, res) => {
    const { remoteId, remoteOrderId } = req.params;
    const statusUpdate = req.body;

    console.log('[YemekSepeti] ========== ORDER STATUS UPDATE ==========');
    console.log('[YemekSepeti] Remote ID:', remoteId);
    console.log('[YemekSepeti] Remote Order ID:', remoteOrderId);
    console.log('[YemekSepeti] Status:', statusUpdate.status);
    console.log('[YemekSepeti] Full Payload:', JSON.stringify(statusUpdate, null, 2));
    console.log('[YemekSepeti] ==========================================');

    // İptal durumunu kontrol et
    const status = (statusUpdate.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected' || status === 'cancel') {
        // İptal bildirimini kaydet - YemiGO polling ile alacak
        const cancellationId = `cancel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // remoteOrderId'den orderToken'ı çıkar (format: remoteId_orderToken_timestamp)
        const parts = remoteOrderId.split('_');
        const orderToken = parts.length >= 2 ? parts[1] : remoteOrderId;

        const cancellation = {
            id: cancellationId,
            orderId: orderToken,
            remoteOrderId: remoteOrderId,
            remoteId: remoteId,
            status: 'CANCELLED',
            reason: statusUpdate.reason || statusUpdate.cancelReason || statusUpdate.rejectionReason || 'UNKNOWN',
            reasonCode: statusUpdate.reasonCode || statusUpdate.cancelReasonCode || null,
            cancelledBy: statusUpdate.cancelledBy || statusUpdate.initiator || 'PLATFORM',
            note: statusUpdate.note || statusUpdate.cancelNote || null,
            originalPayload: statusUpdate,
            cancelledAt: new Date().toISOString(),
            createdAt: new Date()
        };

        cancellations.set(cancellationId, cancellation);

        console.log('[YemekSepeti] ========== CANCELLATION SAVED ==========');
        console.log('[YemekSepeti] Cancellation ID:', cancellationId);
        console.log('[YemekSepeti] Order Token:', orderToken);
        console.log('[YemekSepeti] Reason:', cancellation.reason);
        console.log('[YemekSepeti] Cancelled By:', cancellation.cancelledBy);
        console.log('[YemekSepeti] Total Cancellations:', cancellations.size);
        console.log('[YemekSepeti] ========================================');

        // orders Map'ten de sil/güncelle
        if (orders.has(orderToken)) {
            const orderData = orders.get(orderToken);
            orderData.status = 'CANCELLED';
            orderData.cancelledAt = new Date();
            orderData.cancelReason = cancellation.reason;
        }
    }

    res.status(200).json({ success: true, message: 'Status update received' });
});

// Alternatif iptal endpoint'leri (Delivery Hero farklı formatlar kullanabilir)
app.post('/remoteId/:remoteId/remoteOrder/:remoteOrderId/cancel', (req, res) => {
    const { remoteId, remoteOrderId } = req.params;
    const cancelData = req.body;

    console.log('[YemekSepeti] ========== CANCEL ENDPOINT ==========');
    console.log('[YemekSepeti] Remote ID:', remoteId);
    console.log('[YemekSepeti] Remote Order ID:', remoteOrderId);
    console.log('[YemekSepeti] Cancel Data:', JSON.stringify(cancelData, null, 2));

    const cancellationId = `cancel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const parts = remoteOrderId.split('_');
    const orderToken = parts.length >= 2 ? parts[1] : remoteOrderId;

    const cancellation = {
        id: cancellationId,
        orderId: orderToken,
        remoteOrderId: remoteOrderId,
        remoteId: remoteId,
        status: 'CANCELLED',
        reason: cancelData.reason || cancelData.cancelReason || 'UNKNOWN',
        reasonCode: cancelData.reasonCode || null,
        cancelledBy: cancelData.cancelledBy || cancelData.initiator || 'PLATFORM',
        note: cancelData.note || null,
        originalPayload: cancelData,
        cancelledAt: new Date().toISOString(),
        createdAt: new Date()
    };

    cancellations.set(cancellationId, cancellation);
    console.log('[YemekSepeti] Cancellation saved:', cancellationId);

    res.status(200).json({ success: true });
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

    // Sadece bugünkü ve status='NEW' olan siparişleri döndür
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const newOrders = Array.from(orders.entries())
        .filter(([key, item]) => {
            // Sadece NEW status
            if (item.status !== 'NEW') return false;
            // Sadece bugünkü siparişler
            const orderDate = new Date(item.createdAt);
            return orderDate >= today;
        })
        .map(([key, item]) => ({
            ...item.order,
            _railwayKey: key,  // Silme için doğru key'i gönder
            CreatedAt: item.createdAt.toISOString()
        }));

    console.log(`[YemekSepeti] Polling: ${newOrders.length} NEW orders (today only)`);
    res.json({ success: true, count: newOrders.length, orders: newOrders });
});

app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const orderId = req.params.orderId;

    // Önce direkt key ile dene
    if (orders.has(orderId)) {
        orders.delete(orderId);
        console.log(`[YemekSepeti] ✅ Order deleted by key: ${orderId}`);
        return res.json({ success: true, deletedBy: 'key' });
    }

    // Key bulunamadıysa OrderId ile ara
    for (const [key, item] of orders.entries()) {
        if (item.order.OrderId === orderId || item.order.OrderToken === orderId) {
            orders.delete(key);
            console.log(`[YemekSepeti] ✅ Order deleted by OrderId/Token: ${orderId} (key: ${key})`);
            return res.json({ success: true, deletedBy: 'orderId' });
        }
    }

    console.log(`[YemekSepeti] ⚠️ Order not found for deletion: ${orderId}`);
    res.status(404).json({ success: false, message: 'Order not found' });
});

// ==================== YEMEKSEPETI İPTAL POLLING ====================
// YemiGO iptal bildirimlerini bu endpoint'ten polling ile alır
app.get('/api/yemeksepeti/cancellations', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const pendingCancellations = Array.from(cancellations.values())
        .map(c => ({
            id: c.id,
            orderId: c.orderId,
            remoteOrderId: c.remoteOrderId,
            status: c.status,
            reason: c.reason,
            reasonCode: c.reasonCode,
            cancelledBy: c.cancelledBy,
            note: c.note,
            cancelledAt: c.cancelledAt
        }));

    console.log(`[YemekSepeti] Cancellation Polling: ${pendingCancellations.length} cancellations`);
    res.json({ success: true, count: pendingCancellations.length, cancellations: pendingCancellations });
});

// İptal bildirimini sil (YemiGO işledikten sonra)
app.delete('/api/yemeksepeti/cancellations/:cancellationId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (cancellations.has(req.params.cancellationId)) {
        cancellations.delete(req.params.cancellationId);
        console.log(`[YemekSepeti] Cancellation deleted: ${req.params.cancellationId}`);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Cancellation not found' });
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
        data: order,  // GetirYemek zaten full data gönderiyor
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
    const orderId = req.params.orderId;
    if (orders.has(orderId)) {
        // Sipariş onaylandı - Railway'den SİL (tekrar polling'e düşmesin)
        orders.delete(orderId);
        console.log(`[YemekSepeti] ✅ Order ACCEPTED and REMOVED from queue: ${orderId}`);
    }
    res.status(200).json({ success: true, orderId: orderId, action: 'accepted_and_removed' });
});

app.post('/test-callbacks/order-rejected/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    if (orders.has(orderId)) {
        // Sipariş reddedildi - Railway'den SİL
        orders.delete(orderId);
        console.log(`[YemekSepeti] ❌ Order REJECTED and REMOVED from queue: ${orderId}`);
    }
    res.status(200).json({ success: true, orderId: orderId, action: 'rejected_and_removed' });
});

app.post('/test-callbacks/order-prepared/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    // Hazırlandı bildirimi - sipariş zaten queue'dan silinmiş olmalı
    console.log(`[YemekSepeti] 📦 Order PREPARED: ${orderId}`);
    res.status(200).json({ success: true, orderId: orderId });
});

app.post('/test-callbacks/order-pickedup/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    // Teslim alındı bildirimi - sipariş zaten queue'dan silinmiş olmalı
    console.log(`[YemekSepeti] 🚗 Order PICKED UP: ${orderId}`);
    res.status(200).json({ success: true, orderId: orderId });
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
            ordersByStatus: ordersByStatus,
            pendingCancellations: cancellations.size
        },
        getiryemek: {
            pendingWebhooks: getirYemekWebhooks.length
        },
        endpoints: {
            yemeksepeti: {
                orderWebhook: 'POST /order/:remoteId',
                statusUpdate: 'PUT /remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus',
                cancelWebhook: 'POST /remoteId/:remoteId/remoteOrder/:remoteOrderId/cancel',
                orderPolling: 'GET /api/yemeksepeti/pending-orders',
                cancellationPolling: 'GET /api/yemeksepeti/cancellations',
                deleteCancellation: 'DELETE /api/yemeksepeti/cancellations/:cancellationId'
            },
            getiryemek: {
                webhooks: ['POST /webhook/newOrder', 'POST /webhook/cancelOrder', 'POST /webhook/courierArrival'],
                polling: 'GET /poll/webhooks?restaurantSecretKey=xxx',
                delete: 'DELETE /api/getiryemek/webhooks/:webhookId'
            }
        }
    });
});

// ==================== CLEANUP FUNCTION ====================
// Eski siparişleri otomatik temizle (memory leak önleme)
function cleanupOldOrders() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    let deletedOrders = 0;
    let deletedCancellations = 0;

    // Eski siparişleri sil
    for (const [key, item] of orders.entries()) {
        const orderDate = new Date(item.createdAt);
        if (orderDate < yesterday) {
            orders.delete(key);
            deletedOrders++;
        }
    }

    // Eski iptalleri sil
    for (const [key, item] of cancellations.entries()) {
        const cancelDate = new Date(item.createdAt);
        if (cancelDate < yesterday) {
            cancellations.delete(key);
            deletedCancellations++;
        }
    }

    // Eski GetirYemek webhook'larını sil
    const webhooksToDelete = [];
    for (let i = getirYemekWebhooks.length - 1; i >= 0; i--) {
        const webhookDate = new Date(getirYemekWebhooks[i].timestamp);
        if (webhookDate < yesterday) {
            webhooksToDelete.push(i);
        }
    }
    webhooksToDelete.forEach(i => getirYemekWebhooks.splice(i, 1));

    if (deletedOrders > 0 || deletedCancellations > 0 || webhooksToDelete.length > 0) {
        console.log(`[Cleanup] Deleted: ${deletedOrders} orders, ${deletedCancellations} cancellations, ${webhooksToDelete.length} webhooks`);
    }
}

// Her saat başı temizlik yap
setInterval(cleanupOldOrders, 60 * 60 * 1000);

// Uygulama başlarken de temizle
setTimeout(cleanupOldOrders, 5000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`[YemekSepeti] Order validation interval: ${YEMEKSEPETI_CONFIG.checkIntervalMinutes} minutes`);
    console.log(`[Cleanup] Auto-cleanup enabled (hourly)`);
});
