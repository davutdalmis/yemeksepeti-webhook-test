const express = require('express');
const app = express();

app.use(express.json());

// In-memory order storage
const pendingOrders = new Map();

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

    // Store order in memory
    const orderId = order.token;
    pendingOrders.set(orderId, {
        ...order,
        remoteId,
        receivedAt: new Date().toISOString()
    });

    console.log(`✅ Order stored. Total pending: ${pendingOrders.size}`);

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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'YemekSepeti Webhook Test' });
});

// POS Polling Endpoint - Get pending orders
app.get('/api/yemeksepeti/pending-orders', (req, res) => {
    const apiKey = req.headers['x-api-key'];

    // Simple API key check
    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const orders = Array.from(pendingOrders.values());

    console.log(`📤 POS polling: ${orders.length} pending orders`);

    res.json({
        success: true,
        count: orders.length,
        orders: orders
    });
});

// Mark order as fetched (delete from pending)
app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const { orderId } = req.params;

    if (apiKey !== 'bafetto-yemeksepeti-2025-secure-key') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (pendingOrders.has(orderId)) {
        pendingOrders.delete(orderId);
        console.log(`🗑️ Order ${orderId} removed. Remaining: ${pendingOrders.size}`);
        res.json({ success: true, message: 'Order removed' });
    } else {
        res.status(404).json({ success: false, message: 'Order not found' });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'YemekSepeti Webhook & Polling Server',
        pendingOrders: pendingOrders.size,
        endpoints: {
            orderDispatch: 'POST /order/:remoteId',
            orderStatusUpdate: 'PUT /remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus',
            menuImport: 'GET /menuimport/:remoteId',
            getPendingOrders: 'GET /api/yemeksepeti/pending-orders (requires x-api-key header)',
            deleteOrder: 'DELETE /api/yemeksepeti/orders/:orderId (requires x-api-key header)',
            health: 'GET /health'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YemekSepeti Webhook Test Server running on port ${PORT}`);
    console.log(`📡 Waiting for webhooks from YemekSepeti...`);
});
