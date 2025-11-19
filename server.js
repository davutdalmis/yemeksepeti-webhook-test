const express = require('express');
const app = express();

app.use(express.json());

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

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'YemekSepeti Webhook Test Server',
        endpoints: {
            orderDispatch: 'POST /order/:remoteId',
            orderStatusUpdate: 'PUT /remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus',
            menuImport: 'GET /menuimport/:remoteId',
            health: 'GET /health'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 YemekSepeti Webhook Test Server running on port ${PORT}`);
    console.log(`📡 Waiting for webhooks from YemekSepeti...`);
});
