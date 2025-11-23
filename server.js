require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// In-memory order storage with status tracking
// Structure: Map<orderId, { order: {...}, status: 'NEW|ACCEPTED|PREPARED|PICKED_UP|REJECTED' }>
const orders = new Map();

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

// ==================== YEMEKSEPETI API FUNCTIONS ====================

/**
 * YemekSepeti API'den token al
 */
async function getYemekSepetiToken() {
    // Token varsa ve geçerliyse, onu kullan
    if (yemeksepetiToken && tokenExpiry && Date.now() < tokenExpiry) {
        return yemeksepetiToken;
    }

    if (!YEMEKSEPETI_CONFIG.username || !YEMEKSEPETI_CONFIG.password) {
        console.log('[YemekSepeti API] ⚠️ Username veya Password yapılandırılmamış - API kontrolü yapılamayacak');
        return null;
    }

    try {
        console.log('[YemekSepeti API] 🔑 Token alınıyor...');

        const response = await axios.post(
            `${YEMEKSEPETI_CONFIG.baseUrl}/v2/login`,
            new URLSearchParams({
                username: YEMEKSEPETI_CONFIG.username,
                password: YEMEKSEPETI_CONFIG.password,
                grant_type: 'client_credentials'
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        yemeksepetiToken = response.data.access_token;
        // Token 30 dakika geçerli, 25 dakika sonra yenile
        tokenExpiry = Date.now() + (25 * 60 * 1000);

        console.log('[YemekSepeti API] ✅ Token alındı');
        return yemeksepetiToken;
    } catch (error) {
        console.error('[YemekSepeti API] ❌ Token alma hatası:', error.message);
        return null;
    }
}

/**
 * YemekSepeti API'den sipariş detaylarını al
 */
async function checkOrderStatus(orderId) {
    const token = await getYemekSepetiToken();
    if (!token) {
        return null;
    }

    if (!YEMEKSEPETI_CONFIG.chainCode) {
        console.log('[YemekSepeti API] ⚠️ ChainCode yapılandırılmamış');
        return null;
    }

    try {
        const response = await axios.get(
            `${YEMEKSEPETI_CONFIG.baseUrl}/v2/chains/${YEMEKSEPETI_CONFIG.chainCode}/orders/${orderId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        return response.data.order;
    } catch (error) {
        if (error.response?.status === 404) {
            console.log(`[YemekSepeti API] ℹ️ Sipariş bulunamadı (muhtemelen iptal edilmiş): ${orderId}`);
            return { status: 'NOT_FOUND' };
        }
        console.error(`[YemekSepeti API] ❌ Sipariş kontrol hatası (${orderId}):`, error.message);
        return null;
    }
}

/**
 * Railway'deki tüm siparişlerin durumunu YemekSepeti API'den kontrol et
 */
async function validateOrdersWithYemekSepeti() {
    if (orders.size === 0) {
        return;
    }

    console.log('='.repeat(80));
    console.log(`[YemekSepeti Validator] 🔍 ${orders.size} sipariş kontrol ediliyor...`);
    console.log('='.repeat(80));

    const ordersToDelete = [];

    for (const [orderId, orderData] of orders.entries()) {
        // Sadece NEW status'teki siparişleri kontrol et
        if (orderData.status !== 'NEW') {
            continue;
        }

        const orderToken = orderData.order.OrderToken;
        if (!orderToken) {
            continue;
        }

        const apiOrderData = await checkOrderStatus(orderToken);

        if (!apiOrderData) {
            // API hatası - atla
            continue;
        }

        if (apiOrderData.status === 'NOT_FOUND' || apiOrderData.status === 'cancelled') {
            // Sipariş iptal edilmiş veya bulunamıyor - Railway'den sil
            console.log(`[YemekSepeti Validator] 🗑️ İptal edilmiş sipariş siliniyor: ${orderId} (Status: ${apiOrderData.status})`);
            ordersToDelete.push(orderId);
        } else if (apiOrderData.status === 'accepted') {
            // Sipariş kabul edilmiş ama Railway'de hala NEW - status'u güncelle
            console.log(`[YemekSepeti Validator] ✅ Sipariş kabul edilmiş, status güncelleniyor: ${orderId}`);
            orderData.status = 'ACCEPTED';
        }
    }

    // Silinecek siparişleri sil
    for (const orderId of ordersToDelete) {
        orders.delete(orderId);
    }

    if (ordersToDelete.length > 0) {
        console.log(`[YemekSepeti Validator] ✅ ${ordersToDelete.length} sipariş Railway'den silindi`);
    }

    console.log(`[YemekSepeti Validator] ✅ Kontrol tamamlandı. Kalan sipariş: ${orders.size}`);
    console.log('='.repeat(80));
}

// Her X dakikada bir YemekSepeti API ile doğrulama yap
setInterval(() => {
    validateOrdersWithYemekSepeti().catch(err => {
        console.error('[YemekSepeti Validator] ❌ Doğrulama hatası:', err.message);
    });
}, YEMEKSEPETI_CONFIG.checkIntervalMinutes * 60 * 1000);

// Uygulama başladığında ilk kontrol
setTimeout(() => {
    validateOrdersWithYemekSepeti().catch(err => {
        console.error('[YemekSepeti Validator] ❌ İlk doğrulama hatası:', err.message);
    });
}, 30000); // 30 saniye sonra

// ==================== WEBHOOK ENDPOINTS ====================

// YemekSepeti Order Dispatch Webhook
app.post('/order/:remoteId', (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;

    console.log('='.repeat(80));
    console.log('📦 YemekSepeti Order Received!');
    console.log('='.repeat(80));
    console.log('RemoteID:', remoteId);
    console.log('Order Token:', order.token);
    console.log('Order Code:', order.code);
    console.log('Created At:', order.createdAt);
    console.log('Customer:', order.customer?.firstName, order.customer?.lastName);
    console.log('Total Price:', order.price?.grandTotal);
    console.log('Products:', order.products?.length);
    console.log('\nFull Order Payload:');
    console.log(JSON.stringify(order, null, 2));
    console.log('='.repeat(80));

    // Get base URL from request or use localhost for testing
    const baseUrl = req.get('host').includes('localhost')
        ? `http://localhost:${PORT}`
        : `http://${req.get('host')}`;

    // Transform YemekSepeti webhook to C# model format
    const now = new Date();
    const transformedOrder = {
        OrderId: order.code || order.token || '',  // code boşsa token kullan
        RemoteOrderId: `${remoteId}_${order.token}_${Date.now()}`,
        OrderToken: order.token || '',
        VendorId: remoteId || '',
        ChainCode: '', // Will be filled from settings
        OrderDate: order.createdAt || now.toISOString(),
        CreatedAt: now.toISOString(), // Railway'e kayıt edildiği zaman
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
            TotalPrice: parseFloat(p.paidPrice) || 0,  // YemekSepeti uses paidPrice
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
        CourierType: 'VENDOR',  // YemekSepeti doesn't provide this, default to VENDOR
        Note: order.comments?.customerComment || '',
        PlatformOrderId: order.id || null,
        // Use real callback URLs if provided, otherwise use test callbacks
        CallbackUrls: order.callbackUrls ? {
            orderAcceptedUrl: order.callbackUrls.orderAcceptedUrl || null,
            orderRejectedUrl: order.callbackUrls.orderRejectedUrl || null,
            orderPreparedUrl: order.callbackUrls.orderPreparedUrl || null,
            orderPickedUpUrl: order.callbackUrls.orderPickedUpUrl || null
        } : {
            // Test callback URLs for development/testing
            orderAcceptedUrl: `${baseUrl}/test-callbacks/order-accepted/${order.token}`,
            orderRejectedUrl: `${baseUrl}/test-callbacks/order-rejected/${order.token}`,
            orderPreparedUrl: `${baseUrl}/test-callbacks/order-prepared/${order.token}`,
            orderPickedUpUrl: `${baseUrl}/test-callbacks/order-pickedup/${order.token}`
        }
    };

    // Store transformed order in memory with NEW status
    const orderId = order.token;
    orders.set(orderId, {
        order: transformedOrder,
        status: 'NEW',
        createdAt: new Date()
    });

    console.log(`✅ Order stored with status NEW. Total orders: ${orders.size}`);

    // YemekSepeti'ye başarılı yanıt dön (remoteOrderId ile)
    res.status(200).json({
        remoteResponse: {
            remoteOrderId: `${remoteId}_${order.token}_${Date.now()}`
        }
    });
});

// YemekSepeti Order Status Update Webhook
app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', (req, res) => {
    const { remoteId, remoteOrderId } = req.params;
    const update = req.body;

    console.log('='.repeat(80));
    console.log('🔄 YemekSepeti Order Status Update!');
    console.log('='.repeat(80));
    console.log('RemoteID:', remoteId);
    console.log('RemoteOrderID:', remoteOrderId);
    console.log('Status:', update.status);
    console.log('Message:', update.message);
    console.log('\nFull Update Payload:');
    console.log(JSON.stringify(update, null, 2));
    console.log('='.repeat(80));

    res.status(200).send('OK');
});

// YemekSepeti Menu Import Request
app.get('/menuimport/:remoteId', (req, res) => {
    const { remoteId } = req.params;
    const { vendorCode, menuImportId } = req.query;

    console.log('='.repeat(80));
    console.log('📋 YemekSepeti Menu Import Request!');
    console.log('='.repeat(80));
    console.log('RemoteID:', remoteId);
    console.log('VendorCode:', vendorCode);
    console.log('MenuImportID:', menuImportId);
    console.log('='.repeat(80));

    res.status(202).send('Accepted');
});
 // ==================== GETIRYEMEK ENDPOINTS ====================
  const getirYemekWebhooks = [];

  app.post('/webhook/newOrder', (req, res) => {
      const order = req.body;
      console.log('📦 GetirYemek New Order:', order.id);
      const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      getirYemekWebhooks.push({ id: webhookId, type: 'newOrder', data: order, timestamp: new Date() });
      res.status(200).send('OK');
  });

  app.post('/webhook/cancelOrder', (req, res) => {
      const order = req.body;
      console.log('❌ GetirYemek Cancel:', order.id);
      const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      getirYemekWebhooks.push({ id: webhookId, type: 'cancelOrder', data: order, timestamp: new Date() });
      res.status(200).send('OK');
  });

  app.post('/webhook/courierArrival', (req, res) => {
      const notification = req.body;
      console.log('🚗 GetirYemek Courier:', notification.orderId);
      const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      getirYemekWebhooks.push({ id: webhookId, type: 'courierArrival', data: notification, timestamp: new Date() });
      res.status(200).send('OK');
  });

  app.get('/api/getiryemek/webhooks', (req, res) => {
      const apiKey = req.headers['x-api-key'];
      if (apiKey !== 'bafetto-pos-getiryemek-2024-stable-key-d0025f3ffa8172ac') {
          return res.status(401).json({ error: 'Unauthorized' });
      }
      console.log(`📤 GetirYemek polling: ${getirYemekWebhooks.length} webhooks`);
      res.json({ success: true, webhooks: getirYemekWebhooks });
  });

  app.delete('/api/getiryemek/webhooks/:webhookId', (req, res) => {
      const apiKey = req.headers['x-api-key'];
      const { webhookId } = req.params;
      if (apiKey !== 'bafetto-pos-getiryemek-2024-stable-key-d0025f3ffa8172ac') {
          return res.status(401).json({ error: 'Unauthorized' });
      }
      const index = getirYemekWebhooks.findIndex(w => w.id === webhookId);
      if (index !== -1) {
          getirYemekWebhooks.splice(index, 1);
          res.json({ success: true });
      } else {
          res.status(404).json({ success: false });
      }
  });

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'YemekSepeti Webhook Test' });
});

// POS Polling Endpoint - Get pending orders (only NEW status)
app.get('/api/yemeksepeti/pending-orders', (req, res) => {
    const apiKey = req.headers['x-api-key'];

    // Simple API key check
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only return orders with NEW status
    // Include createdAt from Railway storage (when it was first stored)
    const newOrders = Array.from(orders.values())
        .filter(item => item.status === 'NEW')
        .map(item => ({
            ...item.order,
            CreatedAt: item.createdAt.toISOString() // Railway'e kayıt edildiği zaman
        }));

    console.log(`📤 POS polling: ${newOrders.length} NEW orders (total: ${orders.size})`);

    res.json({
        success: true,
        count: newOrders.length,
        orders: newOrders
    });
});

// Delete order endpoint (optional - for manual cleanup)
app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { orderId } = req.params;

    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (orders.has(orderId)) {
        orders.delete(orderId);
        console.log(`🗑️ Order ${orderId} deleted. Remaining: ${orders.size}`);
        res.json({ success: true, message: 'Order deleted' });
    } else {
        res.status(404).json({ success: false, message: 'Order not found' });
    }
});

// ==================== TEST CALLBACK ENDPOINTS ====================
// These simulate YemekSepeti/Delivery Hero callback URLs for testing

// Order Accepted Callback
app.post('/test-callbacks/order-accepted/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { preparationTime } = req.body;

    console.log('='.repeat(80));
    console.log('✅ TEST CALLBACK: Order Accepted');
    console.log('='.repeat(80));
    console.log('Order ID:', orderId);
    console.log('Preparation Time:', preparationTime, 'minutes');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(80));

    // Update order status to ACCEPTED (simulating real YemekSepeti behavior)
    if (orders.has(orderId)) {
        const orderData = orders.get(orderId);
        orderData.status = 'ACCEPTED';
        orderData.acceptedAt = new Date();
        orders.set(orderId, orderData);
        console.log(`✅ Order ${orderId} status updated to ACCEPTED`);
    }

    res.status(200).json({
        success: true,
        message: 'Order accepted callback received',
        orderId: orderId,
        preparationTime: preparationTime
    });
});

// Order Rejected Callback
app.post('/test-callbacks/order-rejected/:orderId', (req, res) => {
    const { orderId } = req.params;
    const { rejectReason, rejectNote } = req.body;

    console.log('='.repeat(80));
    console.log('❌ TEST CALLBACK: Order Rejected');
    console.log('='.repeat(80));
    console.log('Order ID:', orderId);
    console.log('Reject Reason:', rejectReason);
    console.log('Reject Note:', rejectNote);
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(80));

    // Update order status to REJECTED (simulating real YemekSepeti behavior)
    if (orders.has(orderId)) {
        const orderData = orders.get(orderId);
        orderData.status = 'REJECTED';
        orderData.rejectedAt = new Date();
        orders.set(orderId, orderData);
        console.log(`❌ Order ${orderId} status updated to REJECTED`);
    }

    res.status(200).json({
        success: true,
        message: 'Order rejected callback received',
        orderId: orderId,
        rejectReason: rejectReason
    });
});

// Order Prepared Callback
app.post('/test-callbacks/order-prepared/:orderId', (req, res) => {
    const { orderId } = req.params;

    console.log('='.repeat(80));
    console.log('🔥 TEST CALLBACK: Order Prepared');
    console.log('='.repeat(80));
    console.log('Order ID:', orderId);
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(80));

    // Update order status to PREPARED
    if (orders.has(orderId)) {
        const orderData = orders.get(orderId);
        orderData.status = 'PREPARED';
        orderData.preparedAt = new Date();
        orders.set(orderId, orderData);
        console.log(`🔥 Order ${orderId} status updated to PREPARED`);
    }

    res.status(200).json({
        success: true,
        message: 'Order prepared callback received',
        orderId: orderId
    });
});

// Order Picked Up Callback
app.post('/test-callbacks/order-pickedup/:orderId', (req, res) => {
    const { orderId } = req.params;

    console.log('='.repeat(80));
    console.log('🚚 TEST CALLBACK: Order Picked Up / Delivered');
    console.log('='.repeat(80));
    console.log('Order ID:', orderId);
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(80));

    // Update order status to PICKED_UP
    if (orders.has(orderId)) {
        const orderData = orders.get(orderId);
        orderData.status = 'PICKED_UP';
        orderData.pickedUpAt = new Date();
        orders.set(orderId, orderData);
        console.log(`🚚 Order ${orderId} status updated to PICKED_UP`);
    }

    res.status(200).json({
        success: true,
        message: 'Order picked up callback received',
        orderId: orderId
    });
});

// Root endpoint
app.get('/', (req, res) => {
    // Count orders by status
    const ordersByStatus = {};
    orders.forEach(item => {
        ordersByStatus[item.status] = (ordersByStatus[item.status] || 0) + 1;
    });

    res.json({
        service: 'YemekSepeti Webhook & Polling Server',
        totalOrders: orders.size,
        ordersByStatus: ordersByStatus,
        endpoints: {
            orderDispatch: 'POST /order/:remoteId',
            orderStatusUpdate: 'PUT /remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus',
            menuImport: 'GET /menuimport/:remoteId',
            getPendingOrders: 'GET /api/yemeksepeti/pending-orders (returns only NEW orders, requires x-api-key header)',
            deleteOrder: 'DELETE /api/yemeksepeti/orders/:orderId (requires x-api-key header)',
            health: 'GET /health',
            testCallbacks: {
                orderAccepted: 'POST /test-callbacks/order-accepted/:orderId',
                orderRejected: 'POST /test-callbacks/order-rejected/:orderId',
                orderPrepared: 'POST /test-callbacks/order-prepared/:orderId',
                orderPickedUp: 'POST /test-callbacks/order-pickedup/:orderId'
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YemekSepeti Webhook Test Server running on port ${PORT}`);
    console.log(`📡 Waiting for webhooks from YemekSepeti...`);
});
