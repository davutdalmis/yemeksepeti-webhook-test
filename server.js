// ==================================================================================
// YEMIGO CLOUD-FIRST WEBHOOK SERVER v3.0.0
// ==================================================================================
// Bu server hem eski WPF polling sistemini destekler hem de Firebase'e direkt yazar.
// WPF kapalı olsa bile siparişler Firebase'e yazılır ve kurye uygulaması çalışmaya devam eder.
// ==================================================================================

try { require('dotenv').config(); } catch (e) { }

const express = require('express');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const geolib = require('geolib');

const app = express();
const server = http.createServer(app);

// Socket.io setup with CORS
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());

// ==================== IN-MEMORY QUEUES (ESKİ SİSTEM İÇİN - GERİYE UYUMLULUK) ====================
const orders = new Map();
const cancellations = new Map();
const getirYemekWebhooks = [];

// ==================== API KEY CONFIGURATION ====================
const API_KEYS = {
    YEMEKSEPETI_POLLING_KEY: process.env.YEMEKSEPETI_POLLING_API_KEY || null,
    GETIRYEMEK_POLLING_KEY: process.env.GETIRYEMEK_POLLING_API_KEY || null,
    GETIRYEMEK_DEFAULT_RESTAURANT_SECRET: process.env.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET || null
};

// ==================== FIREBASE CONFIGURATION ====================
let db = null;
let firebaseInitialized = false;

function initializeFirebase() {
    try {
        // Firebase credentials - environment variable veya dosyadan
        const firebaseCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

        if (firebaseCredentials) {
            // JSON string olarak environment variable'dan
            const serviceAccount = JSON.parse(firebaseCredentials);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('[Firebase] Initialized from environment variable');
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            // Dosya yolu olarak
            admin.initializeApp({
                credential: admin.credential.applicationDefault()
            });
            console.log('[Firebase] Initialized from GOOGLE_APPLICATION_CREDENTIALS');
        } else {
            // Local development - firebase-credentials.json dosyasından
            try {
                const serviceAccount = require('./firebase-credentials.json');
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('[Firebase] Initialized from local firebase-credentials.json');
            } catch (e) {
                console.warn('[Firebase] No credentials found - Firebase features disabled');
                console.warn('[Firebase] To enable: Set FIREBASE_SERVICE_ACCOUNT_JSON env var or add firebase-credentials.json');
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

// Initialize Firebase
initializeFirebase();

// ==================== STARTUP VALIDATION ====================
function validateConfiguration() {
    const missingKeys = [];

    if (!API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        missingKeys.push('YEMEKSEPETI_POLLING_API_KEY');
    }
    if (!API_KEYS.GETIRYEMEK_POLLING_KEY) {
        missingKeys.push('GETIRYEMEK_POLLING_API_KEY');
    }

    if (missingKeys.length > 0) {
        console.error('==================== SECURITY ERROR ====================');
        console.error('CRITICAL: Missing required environment variables:');
        missingKeys.forEach(key => console.error(`  - ${key}`));
        console.error('Server cannot start without proper API key configuration.');
        console.error('=========================================================');
        process.exit(1);
    }

    console.log('[Security] API Keys Configuration:');
    console.log(`  - YEMEKSEPETI_POLLING_KEY: ✅ (${API_KEYS.YEMEKSEPETI_POLLING_KEY.substring(0, 8)}...)`);
    console.log(`  - GETIRYEMEK_POLLING_KEY: ✅ (${API_KEYS.GETIRYEMEK_POLLING_KEY.substring(0, 8)}...)`);
    console.log(`  - GETIRYEMEK_DEFAULT_RESTAURANT_SECRET: ${API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET ? '✅' : '⚠️ Not set'}`);
    console.log(`  - FIREBASE: ${firebaseInitialized ? '✅ Connected' : '⚠️ Disabled (WPF-only mode)'}`);
}

validateConfiguration();

// ==================== SMART DISPATCH SERVICE ====================
// Kurye atama algoritması - en uygun kuryeyi seçer

async function getBranchLocation(branchId) {
    if (!firebaseInitialized) return null;

    try {
        // branches koleksiyonundan şube lokasyonunu al
        const branchDoc = await db.collection('tenants').doc('*').collection('branches').doc(branchId).get();

        if (!branchDoc.exists) {
            // Alternatif: direkt branches koleksiyonundan dene
            const allBranches = await db.collectionGroup('branches').where('id', '==', branchId).get();
            if (!allBranches.empty) {
                const data = allBranches.docs[0].data();
                return {
                    latitude: data.latitude || data.lat || 0,
                    longitude: data.longitude || data.lng || 0
                };
            }
            return null;
        }

        const data = branchDoc.data();
        return {
            latitude: data.latitude || data.lat || 0,
            longitude: data.longitude || data.lng || 0
        };
    } catch (error) {
        console.error('[SmartDispatch] Branch location error:', error.message);
        return null;
    }
}

async function getAvailableCouriers(branchId) {
    if (!firebaseInitialized) return [];

    try {
        // Couriers koleksiyonundan aktif kuryeler
        const couriersSnapshot = await db.collectionGroup('couriers')
            .where('branchId', '==', branchId)
            .where('isOnDuty', '==', true)
            .where('isActive', '==', true)
            .get();

        const couriers = [];
        couriersSnapshot.forEach(doc => {
            const data = doc.data();
            couriers.push({
                id: doc.id,
                name: data.name || data.fullName || '',
                phone: data.phone || '',
                latitude: data.latitude || data.currentLatitude || 0,
                longitude: data.longitude || data.currentLongitude || 0,
                activeOrderCount: data.activeOrderCount || 0,
                dailyDeliveryCount: data.dailyDeliveryCount || 0,
                fcmToken: data.fcmToken || null
            });
        });

        return couriers;
    } catch (error) {
        console.error('[SmartDispatch] Get couriers error:', error.message);
        return [];
    }
}

async function getActiveOrderCount(courierId) {
    if (!firebaseInitialized) return 0;

    try {
        // Platform siparişlerinden aktif olanları say
        const platforms = ['yemekSepetiOrders', 'getirYemekOrders', 'trendyolGoOrders'];
        let totalActive = 0;

        for (const platform of platforms) {
            const ordersSnapshot = await db.collectionGroup(platform)
                .where('assignedCourierId', '==', courierId)
                .where('Status', 'in', ['ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'ON_THE_WAY'])
                .get();
            totalActive += ordersSnapshot.size;
        }

        return totalActive;
    } catch (error) {
        console.error('[SmartDispatch] Active order count error:', error.message);
        return 0;
    }
}

function calculateCourierScore(courier, deliveryLocation, branchLocation) {
    let score = 0;

    // 1. Mesafe skoru (teslimat adresine yakınlık)
    if (courier.latitude && courier.longitude && deliveryLocation.latitude && deliveryLocation.longitude) {
        const distanceToDelivery = geolib.getDistance(
            { latitude: courier.latitude, longitude: courier.longitude },
            { latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }
        );
        // Her 100 metre için 1 puan ekle (yakın olan düşük puan alır)
        score += distanceToDelivery / 100;
    } else if (branchLocation && branchLocation.latitude && branchLocation.longitude) {
        // Kurye konumu yoksa şubeye yakınlık kullan
        score += 500; // Default mesafe skoru
    }

    // 2. İş yükü skoru (aktif sipariş sayısı)
    score += (courier.activeOrderCount || 0) * 200; // Her aktif sipariş için 200 puan

    // 3. Günlük teslimat sayısı (yorgunluk faktörü)
    score += (courier.dailyDeliveryCount || 0) * 10; // Her teslimat için 10 puan

    return score;
}

async function assignBestCourier(branchId, deliveryLocation) {
    if (!firebaseInitialized) {
        console.log('[SmartDispatch] Firebase disabled - skipping auto-assignment');
        return null;
    }

    try {
        const couriers = await getAvailableCouriers(branchId);

        if (couriers.length === 0) {
            console.log('[SmartDispatch] No available couriers for branch:', branchId);
            return null;
        }

        const branchLocation = await getBranchLocation(branchId);

        // Her kurye için skor hesapla
        const scoredCouriers = await Promise.all(
            couriers.map(async (courier) => {
                const activeOrders = await getActiveOrderCount(courier.id);
                courier.activeOrderCount = activeOrders;

                const score = calculateCourierScore(courier, deliveryLocation, branchLocation);
                return { courier, score };
            })
        );

        // En düşük skorlu kuryeyi seç
        scoredCouriers.sort((a, b) => a.score - b.score);
        const bestMatch = scoredCouriers[0];

        console.log(`[SmartDispatch] Best courier: ${bestMatch.courier.name} (score: ${bestMatch.score.toFixed(0)})`);
        console.log(`[SmartDispatch] Candidates: ${scoredCouriers.map(c => `${c.courier.name}:${c.score.toFixed(0)}`).join(', ')}`);

        return bestMatch.courier;
    } catch (error) {
        console.error('[SmartDispatch] Assignment error:', error.message);
        return null;
    }
}

// ==================== PUSH NOTIFICATION SERVICE ====================

async function sendPushNotification(fcmToken, title, body, data = {}) {
    if (!firebaseInitialized || !fcmToken) {
        console.log('[FCM] Skipping notification - Firebase disabled or no token');
        return false;
    }

    try {
        const message = {
            token: fcmToken,
            notification: {
                title: title,
                body: body
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'orders'
                }
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
        {
            type: 'NEW_ORDER',
            orderId: order.OrderId || order.id,
            platform: platform,
            branchId: order.branchId || ''
        }
    );
}

// ==================== FIREBASE DIRECT WRITE ====================
// YENİ SİSTEM: Siparişleri direkt Firebase'e yazar

async function writeOrderToFirebase(order, platform, branchId) {
    if (!firebaseInitialized) {
        console.log(`[Firebase] Skipping write - Firebase disabled`);
        return { success: false, reason: 'firebase_disabled' };
    }

    const collectionName = {
        'yemeksepeti': 'yemekSepetiOrders',
        'getiryemek': 'getirYemekOrders',
        'trendyolgo': 'trendyolGoOrders'
    }[platform.toLowerCase()];

    if (!collectionName) {
        console.error(`[Firebase] Unknown platform: ${platform}`);
        return { success: false, reason: 'unknown_platform' };
    }

    try {
        const orderId = order.OrderId || order.id || `${platform}_${Date.now()}`;

        // Duplicate check - aynı sipariş zaten var mı?
        const existingOrder = await db.collectionGroup(collectionName)
            .where('OrderId', '==', orderId)
            .get();

        if (!existingOrder.empty) {
            console.log(`[Firebase] Order already exists: ${orderId} - skipping duplicate`);
            return { success: true, reason: 'duplicate_skipped', orderId };
        }

        // Delivery location
        const deliveryLocation = {
            latitude: order.Customer?.Address?.Latitude || order.latitude || 0,
            longitude: order.Customer?.Address?.Longitude || order.longitude || 0
        };

        // SmartDispatch - kurye ata
        let assignedCourier = null;
        const isPickup = (order.DeliveryType === 'PICKUP' || order.expeditionType === 'pickup');

        if (!isPickup && branchId) {
            assignedCourier = await assignBestCourier(branchId, deliveryLocation);
        }

        // Firebase document hazırla
        const firebaseOrder = {
            // Temel bilgiler
            OrderId: orderId,
            OrderToken: order.OrderToken || orderId,
            Platform: platform.toUpperCase(),
            Status: 'NEW',
            IsCancelled: false,

            // Müşteri bilgileri
            CustomerName: order.Customer?.FirstName ?
                `${order.Customer.FirstName} ${order.Customer.LastName || ''}`.trim() :
                (order.customerName || ''),
            CustomerPhone: order.Customer?.Phone || order.customerPhone || '',

            // Adres bilgileri
            DeliveryAddress: order.Customer?.Address?.FullAddress || order.deliveryAddress || '',
            Latitude: deliveryLocation.latitude,
            Longitude: deliveryLocation.longitude,

            // Sipariş detayları
            Items: order.Items || order.items || [],
            TotalAmount: order.TotalAmount || order.totalAmount || 0,
            PaymentMethod: order.PaymentMethod || order.paymentMethod || 'ONLINE',
            DeliveryType: order.DeliveryType || 'DELIVERY',
            Note: order.Note || order.note || '',

            // Kurye ataması
            assignedCourierId: assignedCourier?.id || null,
            assignedCourierName: assignedCourier?.name || null,

            // Branch bilgisi
            branchId: branchId || null,

            // Zaman bilgileri
            CreatedAt: admin.firestore.FieldValue.serverTimestamp(),
            OrderDate: order.OrderDate || new Date().toISOString(),

            // Kaynak bilgisi
            source: 'railway_webhook',
            updatedBy: 'railway_server'
        };

        // Branch path'i bul ve yaz
        if (branchId) {
            // Tenant'ı bul
            const branchQuery = await db.collectionGroup('branches')
                .where('id', '==', branchId)
                .limit(1)
                .get();

            if (!branchQuery.empty) {
                const branchPath = branchQuery.docs[0].ref.parent.parent; // tenant doc ref
                await branchPath.collection('branches').doc(branchId)
                    .collection(collectionName).doc(orderId).set(firebaseOrder);
            } else {
                // Fallback: root level collection
                await db.collection(collectionName).doc(orderId).set(firebaseOrder);
            }
        } else {
            // branchId yoksa root level'a yaz
            await db.collection(collectionName).doc(orderId).set(firebaseOrder);
        }

        console.log(`[Firebase] ✅ Order written: ${orderId} (${platform})`);

        // Push notification gönder
        if (assignedCourier) {
            await notifyCourierNewOrder(assignedCourier, order, platform);
        }

        return {
            success: true,
            orderId,
            assignedCourierId: assignedCourier?.id || null,
            assignedCourierName: assignedCourier?.name || null
        };

    } catch (error) {
        console.error(`[Firebase] Write error:`, error.message);
        return { success: false, reason: error.message };
    }
}

// ==================== SOCKET.IO COURIER TRACKING ====================

const connectedCouriers = new Map();
const courierLocations = new Map();

io.on('connection', (socket) => {
    console.log(`[Socket.io] Yeni bağlantı: ${socket.id}`);

    socket.on('courier:connect', (data) => {
        const { courierId, branchId, name } = data;
        console.log(`[Socket.io] Kurye bağlandı: ${name} (${courierId}) - Şube: ${branchId}`);

        socket.courierId = courierId;
        socket.branchId = branchId;
        socket.courierName = name;
        socket.userType = 'courier';

        socket.join(`branch:${branchId}`);
        connectedCouriers.set(courierId, socket.id);

        io.to(`branch:${branchId}`).emit('courier:online', {
            courierId,
            name,
            timestamp: new Date().toISOString()
        });
    });

    socket.on('pos:connect', (data) => {
        const { branchId, posName } = data;
        console.log(`[Socket.io] POS bağlandı: ${posName} - Şube: ${branchId}`);

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

        const locationData = {
            courierId,
            latitude,
            longitude,
            speed: speed || 0,
            heading: heading || 0,
            timestamp: new Date().toISOString()
        };

        courierLocations.set(courierId, locationData);
        io.to(`branch:${socket.branchId}`).emit('courier:location', locationData);

        // Firebase'e de yaz (async, bloklamaz)
        if (firebaseInitialized) {
            updateCourierLocationInFirebase(courierId, locationData).catch(() => {});
        }
    });

    socket.on('disconnect', () => {
        if (socket.userType === 'courier' && socket.courierId) {
            console.log(`[Socket.io] Kurye ayrıldı: ${socket.courierName} (${socket.courierId})`);

            connectedCouriers.delete(socket.courierId);

            if (socket.branchId) {
                io.to(`branch:${socket.branchId}`).emit('courier:offline', {
                    courierId: socket.courierId,
                    name: socket.courierName,
                    timestamp: new Date().toISOString()
                });
            }
        } else if (socket.userType === 'pos') {
            console.log(`[Socket.io] POS ayrıldı: ${socket.posName}`);
        }
    });
});

async function updateCourierLocationInFirebase(courierId, locationData) {
    if (!firebaseInitialized) return;

    try {
        await db.collectionGroup('couriers')
            .where('id', '==', courierId)
            .get()
            .then(snapshot => {
                snapshot.forEach(doc => {
                    doc.ref.update({
                        currentLatitude: locationData.latitude,
                        currentLongitude: locationData.longitude,
                        lastLocationUpdate: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
            });
    } catch (error) {
        // Silent fail - konum güncellemesi kritik değil
    }
}

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

// ==================== YEMEKSEPETI API ====================

const YEMEKSEPETI_CONFIG = {
    baseUrl: process.env.YEMEKSEPETI_BASE_URL || 'https://integration-middleware.stg.restaurant-partners.com',
    chainCode: process.env.YEMEKSEPETI_CHAIN_CODE || '',
    username: process.env.YEMEKSEPETI_USERNAME || '',
    password: process.env.YEMEKSEPETI_PASSWORD || '',
    checkIntervalMinutes: parseInt(process.env.YEMEKSEPETI_CHECK_INTERVAL_MINUTES) || 5,
    defaultBranchId: process.env.DEFAULT_BRANCH_ID || null
};

let yemeksepetiToken = null;
let tokenExpiry = null;

async function getYemekSepetiToken() {
    if (yemeksepetiToken && tokenExpiry && Date.now() < tokenExpiry) {
        return yemeksepetiToken;
    }

    if (!YEMEKSEPETI_CONFIG.username || !YEMEKSEPETI_CONFIG.password) {
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
        return null;
    }
}

async function validateOrdersWithYemekSepeti() {
    if (!YEMEKSEPETI_CONFIG.username || !YEMEKSEPETI_CONFIG.password || !YEMEKSEPETI_CONFIG.chainCode) {
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
    validateOrdersWithYemekSepeti().catch(() => {});
}, 30000);

// ==================== YEMEKSEPETI WEBHOOKS ====================

app.post('/order/:remoteId', async (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;

    // branchId - header'dan veya query'den al
    const branchId = req.headers['x-branch-id'] || req.query.branchId || YEMEKSEPETI_CONFIG.defaultBranchId;

    console.log('[YemekSepeti] ========== NEW ORDER RECEIVED ==========');
    console.log('[YemekSepeti] Order Code:', order.code || order.token);
    console.log('[YemekSepeti] Branch ID:', branchId);

    const baseUrl = req.get('host').includes('localhost')
        ? `http://localhost:${PORT}`
        : `https://${req.get('host')}`;

    const now = new Date();
    const deliveryAddress = order.delivery?.address || order.customer?.address || null;
    const latitude = order.latitude || deliveryAddress?.latitude || 0;
    const longitude = order.longitude || deliveryAddress?.longitude || 0;
    const deliveryMainArea = order.delivery?.deliveryMainArea || order.deliveryMainArea || '';
    const deliveryArea = order.delivery?.deliveryArea || order.deliveryArea || '';
    const deliveryInstructions = order.delivery?.deliveryInstructions || order.deliveryInstructions || deliveryAddress?.deliveryInstructions || '';

    const street = deliveryAddress?.street || order.street || '';
    const streetNumber = deliveryAddress?.number || order.number || '';
    const city = deliveryAddress?.city || order.city || '';
    const district = deliveryAddress?.district || order.district || '';
    const building = deliveryAddress?.building || order.building || '';
    const entrance = deliveryAddress?.entrance || order.entrance || '';
    const floor = deliveryAddress?.floor || order.floor || '';
    const flatNumber = deliveryAddress?.flatNumber || order.flatNumber || '';
    const intercom = deliveryAddress?.intercom || order.intercom || '';

    let fullAddress = '';
    const addressParts = [];

    if (street) {
        let streetPart = street;
        if (streetNumber) streetPart += ' ' + streetNumber;
        addressParts.push(streetPart);
    }
    if (deliveryMainArea) addressParts.push(deliveryMainArea);
    if (district) addressParts.push(district);
    if (city) addressParts.push(city);

    fullAddress = addressParts.join(', ');

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
        branchId: branchId,
        Customer: order.customer ? {
            FirstName: order.customer.firstName || order.customer.name?.split(' ')[0] || '',
            LastName: order.customer.lastName || order.customer.name?.split(' ').slice(1).join(' ') || '',
            Phone: order.customer.mobilePhone || order.customer.phone || order.customer.phoneNumber || '',
            Email: order.customer.email || '',
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
        Items: (order.products || []).map(p => ({
            Name: p.name || '',
            Quantity: parseInt(p.quantity) || 0,
            UnitPrice: parseFloat(p.unitPrice) || 0,
            TotalPrice: parseFloat(p.paidPrice) || 0,
            Note: p.description || '',
            Options: (p.selectedToppings || []).map(o => ({
                Name: o.name || '',
                Value: o.value || '',
                Price: parseFloat(o.price) || 0,
                IsRemoval: (o.type || '').toLowerCase() === 'remove' || (o.type || '').toLowerCase() === 'removed',
                IsAddition: (o.type || '').toLowerCase() === 'add' || (o.type || '').toLowerCase() === 'added' || (o.type || '').toLowerCase() === 'extra'
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
        Payment: order.payment ? {
            Type: order.payment.type || null,
            RemoteCode: order.payment.remoteCode || null,
            Status: order.payment.status || null
        } : null,
        Delivery: {
            DeliveryMainArea: deliveryMainArea,
            DeliveryArea: deliveryArea,
            Street: street,
            Address: deliveryAddress ? {
                Street: deliveryAddress.street || '',
                Neighborhood: deliveryAddress.neighborhood || deliveryMainArea || '',
                District: deliveryAddress.district || deliveryArea || '',
                FullAddress: fullAddress,
                Building: deliveryAddress.building || '',
                Floor: deliveryAddress.floor || '',
                DoorNumber: deliveryAddress.flatNumber || '',
                AddressDescription: deliveryInstructions
            } : null
        },
        CallbackUrls: order.callbackUrls || {
            orderAcceptedUrl: `${baseUrl}/test-callbacks/order-accepted/${order.token}`,
            orderRejectedUrl: `${baseUrl}/test-callbacks/order-rejected/${order.token}`,
            orderPreparedUrl: `${baseUrl}/test-callbacks/order-prepared/${order.token}`,
            orderPickedUpUrl: `${baseUrl}/test-callbacks/order-pickedup/${order.token}`
        }
    };

    const orderId = order.token;

    // ==================== PARALEL YAZIM ====================
    // ESKİ YOL: Queue'ya ekle (WPF polling için)
    orders.set(orderId, {
        order: transformedOrder,
        status: 'NEW',
        createdAt: new Date()
    });
    console.log('[YemekSepeti] ✅ Added to queue (WPF polling)');

    // YENİ YOL: Firebase'e direkt yaz (kurye app için)
    const firebaseResult = await writeOrderToFirebase(transformedOrder, 'yemeksepeti', branchId);
    if (firebaseResult.success) {
        console.log(`[YemekSepeti] ✅ Written to Firebase (courier: ${firebaseResult.assignedCourierName || 'unassigned'})`);
    } else {
        console.log(`[YemekSepeti] ⚠️ Firebase write skipped: ${firebaseResult.reason}`);
    }

    console.log('[YemekSepeti] ========================================');

    res.status(200).json({
        remoteResponse: {
            remoteOrderId: `${remoteId}_${order.token}_${Date.now()}`
        }
    });
});

// YemekSepeti Status Update
app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', async (req, res) => {
    const { remoteId, remoteOrderId } = req.params;
    const statusUpdate = req.body;

    console.log('[YemekSepeti] ========== ORDER STATUS UPDATE ==========');
    console.log('[YemekSepeti] Remote Order ID:', remoteOrderId);
    console.log('[YemekSepeti] Status:', statusUpdate.status);

    const status = (statusUpdate.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected' || status === 'cancel') {
        const cancellationId = `cancel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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

        // Firebase'de de iptal et
        if (firebaseInitialized) {
            try {
                const ordersSnapshot = await db.collectionGroup('yemekSepetiOrders')
                    .where('OrderToken', '==', orderToken)
                    .get();

                ordersSnapshot.forEach(doc => {
                    doc.ref.update({
                        Status: 'CANCELLED',
                        IsCancelled: true,
                        cancelReason: cancellation.reason,
                        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                console.log('[YemekSepeti] ✅ Cancellation synced to Firebase');
            } catch (e) {
                console.error('[YemekSepeti] Firebase cancel error:', e.message);
            }
        }

        if (orders.has(orderToken)) {
            const orderData = orders.get(orderToken);
            orderData.status = 'CANCELLED';
            orderData.cancelledAt = new Date();
            orderData.cancelReason = cancellation.reason;
        }

        console.log('[YemekSepeti] ✅ Cancellation saved:', cancellationId);
    }

    res.status(200).json({ success: true, message: 'Status update received' });
});

app.post('/remoteId/:remoteId/remoteOrder/:remoteOrderId/cancel', (req, res) => {
    const { remoteId, remoteOrderId } = req.params;
    const cancelData = req.body;

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
    res.status(200).json({ success: true });
});

app.get('/menuimport/:remoteId', (req, res) => {
    res.status(202).send('Accepted');
});

// ==================== YEMEKSEPETI POLLING ENDPOINTS (ESKİ SİSTEM) ====================

app.get('/api/yemeksepeti/pending-orders', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const newOrders = Array.from(orders.entries())
        .filter(([key, item]) => {
            if (item.status !== 'NEW') return false;
            const orderDate = new Date(item.createdAt);
            return orderDate >= today;
        })
        .map(([key, item]) => ({
            ...item.order,
            _railwayKey: key,
            CreatedAt: item.createdAt.toISOString()
        }));

    console.log(`[YemekSepeti] Polling: ${newOrders.length} NEW orders`);
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
        return res.json({ success: true, deletedBy: 'key' });
    }

    for (const [key, item] of orders.entries()) {
        if (item.order.OrderId === orderId || item.order.OrderToken === orderId) {
            orders.delete(key);
            return res.json({ success: true, deletedBy: 'orderId' });
        }
    }

    res.status(404).json({ success: false, message: 'Order not found' });
});

app.get('/api/yemeksepeti/cancellations', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
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
        res.status(404).json({ success: false, message: 'Cancellation not found' });
    }
});

// ==================== GETIRYEMEK WEBHOOKS ====================

app.post('/webhook/newOrder', async (req, res) => {
    const order = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    console.log('[GetirYemek] ========== NEW ORDER RECEIVED ==========');
    console.log('[GetirYemek] Order ID:', order.id);
    console.log('[GetirYemek] Branch ID:', branchId);

    // ESKİ YOL: Queue'ya ekle
    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'newOrder',
        data: order,
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });
    console.log('[GetirYemek] ✅ Added to queue (WPF polling)');

    // YENİ YOL: Firebase'e direkt yaz
    const transformedOrder = {
        OrderId: order.id || '',
        OrderToken: order.id || '',
        customerName: order.client?.name || '',
        customerPhone: order.client?.clientPhoneNumber || order.client?.maskedPhoneNumber || '',
        deliveryAddress: order.client?.deliveryAddress?.address || '',
        latitude: order.client?.deliveryAddress?.latitude || 0,
        longitude: order.client?.deliveryAddress?.longitude || 0,
        Items: (order.products || []).map(p => ({
            Name: p.name || '',
            Quantity: p.count || 1,
            UnitPrice: p.price || 0,
            TotalPrice: (p.price || 0) * (p.count || 1)
        })),
        TotalAmount: order.totalPrice || 0,
        PaymentMethod: order.paymentMethodText || 'ONLINE',
        DeliveryType: order.isScheduled ? 'SCHEDULED' : 'DELIVERY',
        Note: order.clientNote || '',
        branchId: branchId
    };

    const firebaseResult = await writeOrderToFirebase(transformedOrder, 'getiryemek', branchId);
    if (firebaseResult.success) {
        console.log(`[GetirYemek] ✅ Written to Firebase (courier: ${firebaseResult.assignedCourierName || 'unassigned'})`);
    }

    console.log('[GetirYemek] ========================================');

    res.status(200).send('OK');
});

app.post('/webhook/cancelOrder', async (req, res) => {
    const order = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;

    console.log('[GetirYemek] Order cancelled:', order.id);

    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'cancelOrder',
        data: { foodOrder: order },
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });

    // Firebase'de iptal et
    if (firebaseInitialized && order.id) {
        try {
            const ordersSnapshot = await db.collectionGroup('getirYemekOrders')
                .where('OrderId', '==', order.id)
                .get();

            ordersSnapshot.forEach(doc => {
                doc.ref.update({
                    Status: 'CANCELLED',
                    IsCancelled: true,
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
        } catch (e) {
            console.error('[GetirYemek] Firebase cancel error:', e.message);
        }
    }

    res.status(200).send('OK');
});

app.post('/webhook/courierArrival', (req, res) => {
    const notification = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;

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

app.post('/webhook/restaurantStatus', (req, res) => {
    const notification = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;

    console.log('[GetirYemek] Restaurant Status:', notification.status);

    const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    getirYemekWebhooks.push({
        id: webhookId,
        type: 'restaurantStatus',
        data: notification,
        restaurantSecretKey: restaurantSecretKey,
        timestamp: new Date()
    });

    res.status(200).send('OK');
});

// GetirYemek Polling (ESKİ SİSTEM)
app.get('/poll/webhooks', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const restaurantSecretKey = req.query.restaurantSecretKey;

    if (apiKey !== API_KEYS.GETIRYEMEK_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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

// ==================== TRENDYOLGO WEBHOOKS (YENİ) ====================

app.post('/webhook/trendyolgo/order', async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    console.log('[TrendyolGo] ========== NEW ORDER RECEIVED ==========');
    console.log('[TrendyolGo] Package ID:', order.id || order.packageId);
    console.log('[TrendyolGo] Branch ID:', branchId);

    // Firebase'e direkt yaz
    const transformedOrder = {
        OrderId: order.id || order.packageId || '',
        OrderToken: order.id || order.packageId || '',
        customerName: order.recipientName || order.customerName || '',
        customerPhone: order.recipientPhone || order.customerPhone || '',
        deliveryAddress: order.deliveryAddress || order.address || '',
        latitude: order.latitude || 0,
        longitude: order.longitude || 0,
        Items: (order.lines || order.items || []).map(item => ({
            Name: item.productName || item.name || '',
            Quantity: item.quantity || 1,
            UnitPrice: item.price || 0,
            TotalPrice: (item.price || 0) * (item.quantity || 1)
        })),
        TotalAmount: order.totalPrice || order.grossAmount || 0,
        PaymentMethod: order.paymentType || 'ONLINE',
        DeliveryType: 'DELIVERY',
        Note: order.customerNote || order.note || '',
        branchId: branchId
    };

    const firebaseResult = await writeOrderToFirebase(transformedOrder, 'trendyolgo', branchId);
    if (firebaseResult.success) {
        console.log(`[TrendyolGo] ✅ Written to Firebase (courier: ${firebaseResult.assignedCourierName || 'unassigned'})`);
    }

    console.log('[TrendyolGo] ========================================');

    res.status(200).json({ success: true });
});

// ==================== TEST CALLBACKS ====================

app.post('/test-callbacks/order-accepted/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    if (orders.has(orderId)) {
        orders.delete(orderId);
        console.log(`[YemekSepeti] ✅ Order ACCEPTED: ${orderId}`);
    }
    res.status(200).json({ success: true, orderId: orderId, action: 'accepted' });
});

app.post('/test-callbacks/order-rejected/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    if (orders.has(orderId)) {
        orders.delete(orderId);
        console.log(`[YemekSepeti] ❌ Order REJECTED: ${orderId}`);
    }
    res.status(200).json({ success: true, orderId: orderId, action: 'rejected' });
});

app.post('/test-callbacks/order-prepared/:orderId', (req, res) => {
    console.log(`[YemekSepeti] 📦 Order PREPARED: ${req.params.orderId}`);
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

app.post('/test-callbacks/order-pickedup/:orderId', (req, res) => {
    console.log(`[YemekSepeti] 🚗 Order PICKED UP: ${req.params.orderId}`);
    res.status(200).json({ success: true, orderId: req.params.orderId });
});

// ==================== HEALTH & INFO ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'YemiGO Cloud-First Webhook Server',
        version: '3.0.0',
        firebase: firebaseInitialized ? 'connected' : 'disabled'
    });
});

app.get('/', (req, res) => {
    const ordersByStatus = {};
    orders.forEach(item => {
        ordersByStatus[item.status] = (ordersByStatus[item.status] || 0) + 1;
    });

    res.json({
        service: 'YemiGO Cloud-First Webhook Server',
        version: '3.0.0',
        architecture: 'PARALLEL (Queue + Firebase Direct Write)',
        firebase: {
            status: firebaseInitialized ? 'CONNECTED' : 'DISABLED',
            features: firebaseInitialized ? ['direct_write', 'smart_dispatch', 'push_notifications'] : []
        },
        queues: {
            yemeksepeti: {
                totalOrders: orders.size,
                ordersByStatus: ordersByStatus,
                pendingCancellations: cancellations.size
            },
            getiryemek: {
                pendingWebhooks: getirYemekWebhooks.length
            }
        },
        sockets: {
            connectedCouriers: connectedCouriers.size,
            totalConnections: io.sockets.sockets.size
        },
        endpoints: {
            webhooks: {
                yemeksepeti: 'POST /order/:remoteId',
                getiryemek: ['POST /webhook/newOrder', 'POST /webhook/cancelOrder'],
                trendyolgo: 'POST /webhook/trendyolgo/order'
            },
            polling: {
                yemeksepeti: 'GET /api/yemeksepeti/pending-orders',
                getiryemek: 'GET /poll/webhooks'
            }
        }
    });
});

// ==================== CLEANUP ====================

function cleanupOldOrders() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    let deletedOrders = 0;
    let deletedCancellations = 0;

    for (const [key, item] of orders.entries()) {
        const orderDate = new Date(item.createdAt);
        if (orderDate < yesterday) {
            orders.delete(key);
            deletedOrders++;
        }
    }

    for (const [key, item] of cancellations.entries()) {
        const cancelDate = new Date(item.createdAt);
        if (cancelDate < yesterday) {
            cancellations.delete(key);
            deletedCancellations++;
        }
    }

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

setInterval(cleanupOldOrders, 60 * 60 * 1000);
setTimeout(cleanupOldOrders, 5000);

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('================================================================================');
    console.log('  YEMIGO CLOUD-FIRST WEBHOOK SERVER v3.0.0');
    console.log('================================================================================');
    console.log(`  Port: ${PORT}`);
    console.log(`  Firebase: ${firebaseInitialized ? '✅ CONNECTED (Direct Write Enabled)' : '⚠️ DISABLED (Queue-Only Mode)'}`);
    console.log(`  Socket.io: ✅ Ready for courier tracking`);
    console.log(`  Architecture: PARALLEL (Queue + Firebase)`);
    console.log('');
    console.log('  PARALEL ÇALIŞMA:');
    console.log('  ├─ ESKİ YOL: Queue → WPF Polling → Firebase (WPF açıkken)');
    console.log('  └─ YENİ YOL: Webhook → Firebase Direct (WPF kapalı olsa bile)');
    console.log('');
    console.log('  WPF KAPALI OLSA BİLE SİPARİŞLER FİREBASE\'E YAZILIR!');
    console.log('================================================================================');
    console.log('');
});
