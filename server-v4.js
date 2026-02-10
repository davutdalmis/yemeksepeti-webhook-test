// ==================================================================================
// YEMIGO CLOUD-FIRST PLATFORM HUB SERVER v4.0.0
// ==================================================================================
// Modüler platform connector mimarisi ile WPF ve Web için unified API
// - Platform Registry: Dinamik platform tanımları (Firebase'den)
// - Modular Connectors: Her platform için ayrı connector modülü
// - Unified API: Tek API ile tüm platformlara komut gönderme
// - Backward Compatibility: Eski WPF polling sistemi korundu
// ==================================================================================

try { require('dotenv').config(); } catch (e) { }

const express = require('express');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const geolib = require('geolib');

// Modular imports
const PlatformRegistry = require('./services/platforms/platform-registry');
const YemekSepetiConnector = require('./services/platforms/connectors/yemeksepeti-connector');
const GetirYemekConnector = require('./services/platforms/connectors/getiryemek-connector');
const TrendyolGoConnector = require('./services/platforms/connectors/trendyolgo-connector');
const createOrdersApi = require('./services/api/orders-api');
const createPlatformsApi = require('./services/api/platforms-api');

const app = express();
const server = http.createServer(app);

// Socket.io setup with CORS
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());

// ==================== IN-MEMORY QUEUES (GERİYE UYUMLULUK) ====================
const orders = new Map();
const cancellations = new Map();
const getirYemekWebhooks = [];

// ==================== API KEY CONFIGURATION ====================
const API_KEYS = {
    YEMEKSEPETI_POLLING_KEY: process.env.YEMEKSEPETI_POLLING_API_KEY || null,
    GETIRYEMEK_POLLING_KEY: process.env.GETIRYEMEK_POLLING_API_KEY || null,
    GETIRYEMEK_DEFAULT_RESTAURANT_SECRET: process.env.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET || null,
    UNIFIED_API_KEY: process.env.UNIFIED_API_KEY || null,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || null
};

// Webhook secret for incoming platform webhooks
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;
const SOCKET_AUTH_TOKEN = process.env.SOCKET_AUTH_TOKEN || null;

// Webhook authentication middleware
function authenticateWebhook(req, res, next) {
    if (!WEBHOOK_SECRET) return next(); // Skip if not configured
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (secret !== WEBHOOK_SECRET) {
        console.warn(`[Security] Unauthorized webhook attempt from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: 'Unauthorized webhook' });
    }
    next();
}

// ==================== FIREBASE CONFIGURATION ====================
let db = null;
let firebaseInitialized = false;

function initializeFirebase() {
    try {
        const firebaseCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

        if (firebaseCredentials) {
            const serviceAccount = JSON.parse(firebaseCredentials);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('[Firebase] Initialized from environment variable');
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            admin.initializeApp({
                credential: admin.credential.applicationDefault()
            });
            console.log('[Firebase] Initialized from GOOGLE_APPLICATION_CREDENTIALS');
        } else {
            try {
                const serviceAccount = require('./firebase-credentials.json');
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('[Firebase] Initialized from local firebase-credentials.json');
            } catch (e) {
                console.warn('[Firebase] No credentials found - Firebase features disabled');
                return false;
            }
        }

        db = admin.firestore();
        firebaseInitialized = true;
        console.log('[Firebase] Firestore connected successfully');
        return true;
    } catch (error) {
        console.error('[Firebase] Initialization error:', error.message);
        return false;
    }
}

initializeFirebase();

// ==================== PLATFORM REGISTRY INITIALIZATION ====================
const platformRegistry = new PlatformRegistry(db);
let smartDispatchService = null;

async function initializePlatformHub() {
    console.log('[PlatformHub] Initializing...');

    // Initialize registry
    await platformRegistry.initialize();

    // Create and register connectors
    const yemeksepetiConnector = new YemekSepetiConnector(db, platformRegistry);
    const getiryemekConnector = new GetirYemekConnector(db, platformRegistry);
    const trendyolgoConnector = new TrendyolGoConnector(db, platformRegistry);

    platformRegistry.registerConnector('yemeksepeti', yemeksepetiConnector);
    platformRegistry.registerConnector('getiryemek', getiryemekConnector);
    platformRegistry.registerConnector('trendyolgo', trendyolgoConnector);

    // Initialize Smart Dispatch
    smartDispatchService = new SmartDispatchService(db, platformRegistry);

    console.log('[PlatformHub] Initialized with connectors:', Array.from(platformRegistry.connectors.keys()));
}

// ==================== SMART DISPATCH SERVICE ====================
class SmartDispatchService {
    constructor(db, registry) {
        this.db = db;
        this.registry = registry;
    }

    async getBranchLocation(branchId) {
        if (!this.db) return null;

        try {
            const allBranches = await this.db.collectionGroup('branches').where('id', '==', branchId).get();
            if (!allBranches.empty) {
                const data = allBranches.docs[0].data();
                return {
                    latitude: data.latitude || data.lat || 0,
                    longitude: data.longitude || data.lng || 0
                };
            }
            return null;
        } catch (error) {
            console.error('[SmartDispatch] Branch location error:', error.message);
            return null;
        }
    }

    async getAvailableCouriers(branchId) {
        if (!this.db) return [];

        try {
            const couriersSnapshot = await this.db.collectionGroup('couriers')
                .where('branchId', '==', branchId)
                .where('isOnDuty', '==', true)
                .where('isActive', '==', true)
                .get();

            return couriersSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    name: data.name || data.fullName || '',
                    phone: data.phone || '',
                    latitude: data.latitude || data.currentLatitude || 0,
                    longitude: data.longitude || data.currentLongitude || 0,
                    activeOrderCount: data.activeOrderCount || 0,
                    dailyDeliveryCount: data.dailyDeliveryCount || 0,
                    fcmToken: data.fcmToken || null
                };
            });
        } catch (error) {
            console.error('[SmartDispatch] Get couriers error:', error.message);
            return [];
        }
    }

    async getActiveOrderCount(courierId) {
        if (!this.db) return 0;

        try {
            const platforms = ['yemekSepetiOrders', 'getirYemekOrders', 'trendyolGoOrders'];
            let totalActive = 0;

            for (const platform of platforms) {
                const ordersSnapshot = await this.db.collectionGroup(platform)
                    .where('assignedCourierId', '==', courierId)
                    .where('Status', 'in', ['ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'ON_THE_WAY'])
                    .get();
                totalActive += ordersSnapshot.size;
            }

            return totalActive;
        } catch (error) {
            return 0;
        }
    }

    calculateCourierScore(courier, deliveryLocation, branchLocation) {
        let score = 0;

        if (courier.latitude && courier.longitude && deliveryLocation.latitude && deliveryLocation.longitude) {
            const distanceToDelivery = geolib.getDistance(
                { latitude: courier.latitude, longitude: courier.longitude },
                { latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }
            );
            score += distanceToDelivery / 100;
        } else if (branchLocation && branchLocation.latitude && branchLocation.longitude) {
            score += 500;
        }

        score += (courier.activeOrderCount || 0) * 200;
        score += (courier.dailyDeliveryCount || 0) * 10;

        return score;
    }

    async assignBestCourier(branchId, deliveryLocation) {
        if (!this.db) {
            console.log('[SmartDispatch] Firebase disabled - skipping auto-assignment');
            return null;
        }

        try {
            const couriers = await this.getAvailableCouriers(branchId);
            if (couriers.length === 0) {
                console.log('[SmartDispatch] No available couriers for branch:', branchId);
                return null;
            }

            const branchLocation = await this.getBranchLocation(branchId);

            const scoredCouriers = await Promise.all(
                couriers.map(async (courier) => {
                    const activeOrders = await this.getActiveOrderCount(courier.id);
                    courier.activeOrderCount = activeOrders;
                    const score = this.calculateCourierScore(courier, deliveryLocation, branchLocation);
                    return { courier, score };
                })
            );

            scoredCouriers.sort((a, b) => a.score - b.score);
            const bestMatch = scoredCouriers[0];

            console.log(`[SmartDispatch] Best courier: ${bestMatch.courier.name} (score: ${bestMatch.score.toFixed(0)})`);
            return bestMatch.courier;
        } catch (error) {
            console.error('[SmartDispatch] Assignment error:', error.message);
            return null;
        }
    }
}

// ==================== PUSH NOTIFICATION SERVICE ====================
async function sendPushNotification(fcmToken, title, body, data = {}) {
    if (!firebaseInitialized || !fcmToken) return false;

    try {
        const message = {
            token: fcmToken,
            notification: { title, body },
            data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
            android: {
                priority: 'high',
                notification: { sound: 'default', channelId: 'orders' }
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`[FCM] Notification sent: ${response}`);
        return true;
    } catch (error) {
        console.error('[FCM] Send error:', error.message);
        return false;
    }
}

async function notifyCourierNewOrder(courier, order, platform) {
    if (!courier || !courier.fcmToken) return false;

    const customerName = order.Customer?.FirstName || order.customerName || 'Müşteri';
    const address = order.Customer?.Address?.FullAddress || order.deliveryAddress || '';
    const shortAddress = address.length > 50 ? address.substring(0, 50) + '...' : address;

    return await sendPushNotification(
        courier.fcmToken,
        `Yeni ${platform} Siparişi`,
        `${customerName} - ${shortAddress}`,
        { type: 'NEW_ORDER', orderId: order.OrderId || order.id, platform, branchId: order.branchId || '' }
    );
}

// ==================== UNIFIED FIREBASE WRITE ====================
async function writeOrderToFirebaseUnified(order, platformId, branchId) {
    const connector = platformRegistry.getConnector(platformId);
    if (connector) {
        return await connector.writeOrderToFirebase(order, branchId);
    }

    // Fallback to direct write
    if (!firebaseInitialized) {
        return { success: false, reason: 'firebase_disabled' };
    }

    const collectionName = {
        'yemeksepeti': 'yemekSepetiOrders',
        'getiryemek': 'getirYemekOrders',
        'trendyolgo': 'trendyolGoOrders'
    }[platformId.toLowerCase()];

    if (!collectionName) {
        return { success: false, reason: 'unknown_platform' };
    }

    try {
        const orderId = order.OrderId || order.id || `${platformId}_${Date.now()}`;
        await db.collection(collectionName).doc(orderId).set({
            ...order,
            Platform: platformId.toUpperCase(),
            Status: 'NEW',
            branchId,
            CreatedAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'railway_webhook'
        });
        return { success: true, orderId };
    } catch (error) {
        return { success: false, reason: error.message };
    }
}

// ==================== SOCKET.IO COURIER TRACKING ====================
const connectedCouriers = new Map();
const courierLocations = new Map();

// Socket.IO authentication middleware
io.use((socket, next) => {
    if (!SOCKET_AUTH_TOKEN) return next(); // Skip if not configured
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token !== SOCKET_AUTH_TOKEN) {
        console.warn(`[Socket.io] Unauthorized connection attempt from ${socket.handshake.address}`);
        return next(new Error('Authentication failed'));
    }
    next();
});

io.on('connection', (socket) => {
    console.log(`[Socket.io] New connection: ${socket.id}`);

    socket.on('courier:connect', (data) => {
        const { courierId, branchId, name } = data;
        if (!courierId || !branchId) return;
        console.log(`[Socket.io] Courier connected: ${name} (${courierId})`);

        socket.courierId = courierId;
        socket.branchId = branchId;
        socket.courierName = name;
        socket.userType = 'courier';

        socket.join(`branch:${branchId}`);
        connectedCouriers.set(courierId, socket.id);

        io.to(`branch:${branchId}`).emit('courier:online', {
            courierId, name, timestamp: new Date().toISOString()
        });

        // Confirm connection to the courier app
        socket.emit('courier:connected', {
            courierId, branchId, timestamp: new Date().toISOString()
        });
    });

    socket.on('pos:connect', (data) => {
        const { branchId, posName } = data;
        if (!branchId) return;
        console.log(`[Socket.io] POS connected: ${posName}`);

        socket.branchId = branchId;
        socket.posName = posName;
        socket.userType = 'pos';
        socket.join(`branch:${branchId}`);

        const branchCouriers = [];
        for (const [courierId, socketId] of connectedCouriers.entries()) {
            const courierSocket = io.sockets.sockets.get(socketId);
            if (courierSocket && courierSocket.branchId === branchId) {
                branchCouriers.push({
                    courierId,
                    name: courierSocket.courierName,
                    location: courierLocations.get(courierId) || null
                });
            }
        }
        socket.emit('couriers:list', branchCouriers);
    });

    socket.on('courier:location', (data) => {
        const { courierId, latitude, longitude, speed, heading } = data;
        if (!courierId || !socket.branchId) return;

        const locationData = { courierId, latitude, longitude, speed: speed || 0, heading: heading || 0, timestamp: new Date().toISOString() };
        courierLocations.set(courierId, locationData);
        io.to(`branch:${socket.branchId}`).emit('courier:location:update', locationData);
    });

    // Handle batch location updates from courier app (offline queue sync)
    socket.on('courier:location:batch', (data) => {
        const { courierId, locations } = data;
        if (!courierId || !socket.branchId || !Array.isArray(locations)) return;

        console.log(`[Socket.io] Batch location update: ${locations.length} points from ${courierId}`);
        for (const loc of locations) {
            const locationData = {
                courierId,
                latitude: loc.latitude || loc.lat,
                longitude: loc.longitude || loc.lng,
                speed: loc.speed || 0,
                heading: loc.heading || 0,
                timestamp: loc.timestamp ? new Date(loc.timestamp).toISOString() : new Date().toISOString()
            };
            courierLocations.set(courierId, locationData);
            io.to(`branch:${socket.branchId}`).emit('courier:location:update', locationData);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userType === 'courier' && socket.courierId) {
            console.log(`[Socket.io] Courier disconnected: ${socket.courierName}`);
            connectedCouriers.delete(socket.courierId);
            courierLocations.delete(socket.courierId);
            if (socket.branchId) {
                io.to(`branch:${socket.branchId}`).emit('courier:offline', {
                    courierId: socket.courierId, name: socket.courierName, timestamp: new Date().toISOString()
                });
            }
        }
    });
});

// ==================== UNIFIED API ROUTES ====================
// New modular API endpoints
app.use('/api/v2/orders', (req, res, next) => {
    // Initialize smartDispatch for API
    req.smartDispatch = smartDispatchService;
    next();
}, createOrdersApi(platformRegistry, smartDispatchService));

app.use('/api/v2/platforms', createPlatformsApi(platformRegistry, db));

// ==================== YEMEKSEPETI WEBHOOKS (LEGACY COMPATIBILITY) ====================

app.post('/order/:remoteId', authenticateWebhook, async (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    console.log('[YemekSepeti] ========== NEW ORDER ==========');

    try {
        // Use connector for transformation
        const connector = platformRegistry.getConnector('yemeksepeti');
        const transformedOrder = connector ? connector.transformOrder(order, branchId) : order;
        transformedOrder.RemoteOrderId = `${remoteId}_${order.token}_${Date.now()}`;

        // Legacy queue (WPF polling)
        const orderId = order.token;
        orders.set(orderId, { order: transformedOrder, status: 'NEW', createdAt: new Date() });
        console.log('[YemekSepeti] Added to legacy queue');

        // Firebase direct write
        const firebaseResult = await writeOrderToFirebaseUnified(transformedOrder, 'yemeksepeti', branchId);
        if (firebaseResult.success) {
            // Auto-assign courier
            if (smartDispatchService && branchId) {
                const deliveryLocation = {
                    latitude: transformedOrder.Customer?.Address?.Latitude || 0,
                    longitude: transformedOrder.Customer?.Address?.Longitude || 0
                };
                const courier = await smartDispatchService.assignBestCourier(branchId, deliveryLocation);
                if (courier) {
                    await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                    await notifyCourierNewOrder(courier, transformedOrder, 'YemekSepeti');
                }
            }
        }

        console.log('[YemekSepeti] ============================');

        res.status(200).json({
            remoteResponse: { remoteOrderId: transformedOrder.RemoteOrderId }
        });
    } catch (error) {
        console.error('[YemekSepeti] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// YemekSepeti Status Update
app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', authenticateWebhook, async (req, res) => {
    const { remoteOrderId } = req.params;
    const statusUpdate = req.body;

    console.log('[YemekSepeti] Status Update:', remoteOrderId, statusUpdate.status);

    const status = (statusUpdate.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected' || status === 'cancel') {
        const connector = platformRegistry.getConnector('yemeksepeti');
        const parts = remoteOrderId.split('_');
        const orderToken = parts.length >= 2 ? parts[1] : remoteOrderId;

        // Cancel in Firebase
        if (connector) {
            await connector.cancelOrder(orderToken, statusUpdate.reason || 'UNKNOWN');
        }

        // Update legacy queue
        if (orders.has(orderToken)) {
            const orderData = orders.get(orderToken);
            orderData.status = 'CANCELLED';
        }
    }

    res.status(200).json({ success: true });
});

// ==================== GETIRYEMEK WEBHOOKS (LEGACY COMPATIBILITY) ====================

app.post('/webhook/newOrder', authenticateWebhook, async (req, res) => {
    const order = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    console.log('[GetirYemek] ========== NEW ORDER ==========');

    try {
        // Use connector for transformation
        const connector = platformRegistry.getConnector('getiryemek');
        const transformedOrder = connector ? connector.transformOrder(order, branchId) : order;

        // Legacy queue
        const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        getirYemekWebhooks.push({
            id: webhookId,
            type: 'newOrder',
            data: order,
            restaurantSecretKey,
            timestamp: new Date()
        });

        // Firebase direct write
        const firebaseResult = await writeOrderToFirebaseUnified(transformedOrder, 'getiryemek', branchId);
        if (firebaseResult.success && smartDispatchService && branchId) {
            const deliveryLocation = {
                latitude: order.client?.deliveryAddress?.latitude || 0,
                longitude: order.client?.deliveryAddress?.longitude || 0
            };
            const courier = await smartDispatchService.assignBestCourier(branchId, deliveryLocation);
            if (courier) {
                await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                await notifyCourierNewOrder(courier, transformedOrder, 'GetirYemek');
            }
        }

        console.log('[GetirYemek] ============================');
        res.status(200).send('OK');
    } catch (error) {
        console.error('[GetirYemek] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/webhook/cancelOrder', authenticateWebhook, async (req, res) => {
    const order = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'];

    console.log('[GetirYemek] Cancel Order:', order.id);

    getirYemekWebhooks.push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'cancelOrder',
        data: { foodOrder: order },
        restaurantSecretKey,
        timestamp: new Date()
    });

    const connector = platformRegistry.getConnector('getiryemek');
    if (connector && order.id) {
        await connector.cancelOrder(order.id);
    }

    res.status(200).send('OK');
});

app.post('/webhook/courierArrival', authenticateWebhook, (req, res) => {
    const notification = req.body;
    getirYemekWebhooks.push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'courierArrival',
        data: notification,
        restaurantSecretKey: req.headers['x-restaurant-secret-key'],
        timestamp: new Date()
    });
    res.status(200).send('OK');
});

app.post('/webhook/restaurantStatus', authenticateWebhook, (req, res) => {
    const notification = req.body;
    getirYemekWebhooks.push({
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'restaurantStatus',
        data: notification,
        restaurantSecretKey: req.headers['x-restaurant-secret-key'],
        timestamp: new Date()
    });
    res.status(200).send('OK');
});

// ==================== TRENDYOLGO WEBHOOKS ====================

app.post('/webhook/trendyolgo/order', authenticateWebhook, async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    console.log('[TrendyolGo] ========== NEW ORDER ==========');

    try {
        const connector = platformRegistry.getConnector('trendyolgo');
        const transformedOrder = connector ? connector.transformOrder(order, branchId) : order;

        const firebaseResult = await writeOrderToFirebaseUnified(transformedOrder, 'trendyolgo', branchId);
        if (firebaseResult.success && smartDispatchService && branchId) {
            const deliveryLocation = {
                latitude: order.latitude || 0,
                longitude: order.longitude || 0
            };
            const courier = await smartDispatchService.assignBestCourier(branchId, deliveryLocation);
            if (courier) {
                await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                await notifyCourierNewOrder(courier, transformedOrder, 'TrendyolGo');
            }
        }

        console.log('[TrendyolGo] ============================');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[TrendyolGo] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== LEGACY POLLING ENDPOINTS ====================

app.get('/api/yemeksepeti/pending-orders', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const newOrders = Array.from(orders.entries())
        .filter(([key, item]) => item.status === 'NEW' && new Date(item.createdAt) >= today)
        .map(([key, item]) => ({ ...item.order, _railwayKey: key, CreatedAt: item.createdAt.toISOString() }));

    res.json({ success: true, count: newOrders.length, orders: newOrders });
});

app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const orderId = req.params.orderId;
    if (orders.has(orderId)) {
        orders.delete(orderId);
        return res.json({ success: true });
    }

    for (const [key, item] of orders.entries()) {
        if (item.order.OrderId === orderId || item.order.OrderToken === orderId) {
            orders.delete(key);
            return res.json({ success: true });
        }
    }

    res.status(404).json({ success: false, message: 'Order not found' });
});

app.get('/api/yemeksepeti/cancellations', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const pendingCancellations = Array.from(cancellations.values());
    res.json({ success: true, count: pendingCancellations.length, cancellations: pendingCancellations });
});

app.delete('/api/yemeksepeti/cancellations/:cancellationId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (cancellations.has(req.params.cancellationId)) {
        cancellations.delete(req.params.cancellationId);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.get('/poll/webhooks', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.GETIRYEMEK_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const restaurantSecretKey = req.query.restaurantSecretKey;
    const filteredWebhooks = restaurantSecretKey
        ? getirYemekWebhooks.filter(w => w.restaurantSecretKey === restaurantSecretKey)
        : getirYemekWebhooks;

    res.json({ success: true, webhooks: filteredWebhooks });
});

app.delete('/api/getiryemek/webhooks/:webhookId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.GETIRYEMEK_POLLING_KEY) {
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

// ==================== HEALTH & INFO ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'YemiGO Platform Hub Server',
        version: '4.0.0',
        firebase: firebaseInitialized ? 'connected' : 'disabled',
        platforms: platformRegistry.getAllPlatforms().length,
        connectors: platformRegistry.connectors.size
    });
});

app.get('/', (req, res) => {
    const ordersByStatus = {};
    orders.forEach(item => {
        ordersByStatus[item.status] = (ordersByStatus[item.status] || 0) + 1;
    });

    res.json({
        service: 'YemiGO Platform Hub Server',
        version: '4.0.0',
        architecture: 'MODULAR PLATFORM HUB',
        firebase: {
            status: firebaseInitialized ? 'CONNECTED' : 'DISABLED',
            features: firebaseInitialized ? ['direct_write', 'smart_dispatch', 'push_notifications', 'realtime_sync'] : []
        },
        platformHub: {
            platforms: platformRegistry.getAllPlatforms().map(p => ({ id: p.id, name: p.name, enabled: p.enabled })),
            connectors: Array.from(platformRegistry.connectors.keys())
        },
        queues: {
            yemeksepeti: { totalOrders: orders.size, ordersByStatus },
            getiryemek: { pendingWebhooks: getirYemekWebhooks.length }
        },
        sockets: {
            connectedCouriers: connectedCouriers.size,
            totalConnections: io.sockets.sockets.size
        },
        api: {
            v2: {
                orders: '/api/v2/orders',
                platforms: '/api/v2/platforms'
            },
            legacy: {
                yemeksepeti: '/api/yemeksepeti/pending-orders',
                getiryemek: '/poll/webhooks'
            }
        }
    });
});

app.get('/socket/status', (req, res) => {
    const couriers = [];
    for (const [courierId, socketId] of connectedCouriers.entries()) {
        const courierSocket = io.sockets.sockets.get(socketId);
        if (courierSocket) {
            couriers.push({
                courierId,
                name: courierSocket.courierName,
                branchId: courierSocket.branchId,
                location: courierLocations.get(courierId) || null
            });
        }
    }

    res.json({
        status: 'ok',
        connectedCouriers: couriers.length,
        couriers,
        totalConnections: io.sockets.sockets.size
    });
});

// ==================== CLEANUP ====================

function cleanupOldOrders() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    let deleted = 0;

    for (const [key, item] of orders.entries()) {
        if (new Date(item.createdAt) < yesterday) {
            orders.delete(key);
            deleted++;
        }
    }

    for (const [key, item] of cancellations.entries()) {
        if (new Date(item.createdAt) < yesterday) {
            cancellations.delete(key);
            deleted++;
        }
    }

    for (let i = getirYemekWebhooks.length - 1; i >= 0; i--) {
        if (new Date(getirYemekWebhooks[i].timestamp) < yesterday) {
            getirYemekWebhooks.splice(i, 1);
            deleted++;
        }
    }

    // Stale courier locations (30 min no update = stale)
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    for (const [courierId, loc] of courierLocations.entries()) {
        if (new Date(loc.timestamp) < thirtyMinAgo) {
            courierLocations.delete(courierId);
            deleted++;
        }
    }

    if (deleted > 0) {
        console.log(`[Cleanup] Deleted ${deleted} old items`);
    }
}

setInterval(cleanupOldOrders, 15 * 60 * 1000); // 15 dakikada bir
setTimeout(cleanupOldOrders, 30000);

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

async function startServer() {
    // Initialize Platform Hub
    await initializePlatformHub();

    server.listen(PORT, () => {
        console.log('');
        console.log('================================================================================');
        console.log('  YEMIGO PLATFORM HUB SERVER v4.0.0');
        console.log('================================================================================');
        console.log(`  Port: ${PORT}`);
        console.log(`  Firebase: ${firebaseInitialized ? '✅ CONNECTED' : '⚠️ DISABLED'}`);
        console.log(`  Socket.io: ✅ Ready`);
        console.log('');
        console.log('  PLATFORM CONNECTORS:');
        platformRegistry.connectors.forEach((connector, id) => {
            console.log(`    ├─ ${id}: ✅ Active`);
        });
        console.log('');
        console.log('  API ENDPOINTS:');
        console.log('    ├─ v2 (Unified): /api/v2/orders, /api/v2/platforms');
        console.log('    └─ Legacy (WPF): /api/yemeksepeti/*, /poll/webhooks');
        console.log('');
        console.log('  ARCHITECTURE: Modular Platform Hub with backward compatibility');
        console.log('================================================================================');
        console.log('');
    });
}

startServer().catch(err => {
    console.error('Server startup error:', err);
    process.exit(1);
});
