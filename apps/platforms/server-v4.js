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
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const geolib = require('geolib');
const rateLimit = require('express-rate-limit');

// Modular imports
const PlatformRegistry = require('./services/platforms/platform-registry');
const YemekSepetiConnector = require('./services/platforms/connectors/yemeksepeti-connector');
const GetirYemekConnector = require('./services/platforms/connectors/getiryemek-connector');
const TrendyolGoConnector = require('./services/platforms/connectors/trendyolgo-connector');
const FuudyConnector = require('./services/platforms/connectors/fuudy-connector');
// Plan 30: Telefon siparişi connector (Yemigo kendi kanalı, tableOrders koleksiyonu)
const PhoneConnector = require('./services/platforms/connectors/phone-connector');
const MigrosYemekConnector = require('./services/platforms/connectors/migrosyemek-connector');
const createOrdersApi = require('./services/api/orders-api');
const createPlatformsApi = require('./services/api/platforms-api');
const createDelayedCallApi = require('./services/api/delayed-call-api');
const GoogleMapsDistanceService = require('./services/google-maps-distance');
const DispatchMetrics = require('./services/dispatch/dispatch-metrics');
const DispatchQueue = require('./services/dispatch/dispatch-queue');
// Plan 29 Faz 2.3 — Pre-dispatch buffer (kurye dönüş bekleme penceresi, default 0 = kapalı)
const PreDispatchBuffer = require('./services/dispatch/pre-dispatch-buffer');
// Plan 29 Faz 2.4 — Audit log (assignmentDecisions koleksiyonu)
const DispatchAudit = require('./services/dispatch/dispatch-audit');
const DispatchAlerts = require('./services/dispatch/dispatch-alerts');
const DelayedCallQueue = require('./services/queue/delayed-call-queue');
const { getRedisClient, isRedisAvailable, getRedisStatus, getRedisFailoverInfo } = require('@yemigo/shared/redis-client');
const { createAdapter } = require('@socket.io/redis-adapter');
const OrderStore = require('./services/redis-orders');
const CancellationStore = require('./services/redis-cancellations');
const WebhookStore = require('./services/redis-webhooks');
const CourierStateStore = require('./services/redis-courier-state');
const MetricsCollector = require('./services/metrics');
const { CircuitBreaker } = require('./services/circuit-breaker');

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

// Socket.IO Redis Adapter — multi-instance broadcasting
if (process.env.REDIS_URL) {
    const pubClient = getRedisClient().duplicate();
    const subClient = getRedisClient().duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[Socket.io] Redis adapter enabled — multi-instance broadcasting active');
} else {
    console.log('[Socket.io] No Redis — using default in-memory adapter');
}

app.set('trust proxy', 1); // Railway runs behind a proxy

// HTTP CORS — manuel implementation (sıfır bağımlılık).
// Browser tabanlı istemciler (yemigo-pos web) için.
// Webhook'lar (platform sunucuları) ve WPF polling browser'dan gelmediği için bundan etkilenmez.
function isAllowedOrigin(origin) {
    if (!origin) return true; // server-to-server
    if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);
    // Whitelist tanımsızsa varsayılan: localhost (dev) + yemigo subdomain'leri
    return /^https?:\/\/(localhost(:\d+)?|.*\.yemigo\.com)$/.test(origin);
}

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-branch-id, x-admin-key, x-webhook-secret');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

app.use(express.json({ limit: '50kb' }));

// Global rate limit (genel güvenlik ağı)
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Server rate limit exceeded' }
});

// Polling endpoint'leri için limit — binlerce şube polling yapabilir
// Her şube ~1 req/10sn = 1000 şube = 6000 req/dk
const pollingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: { error: 'Polling rate limit exceeded' }
});

// Webhook endpoint'leri için limit — platformlar (YS, GY, TG, Fuudy, Migros) webhook push eder
// Platformların IP'leri sınırlı, per-IP limit yeterli
// Tek IP'den max 3000/dk = saniyede 50 webhook (platform sunucuları için makul)
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: { error: 'Webhook rate limit exceeded' }
});

app.use(globalLimiter);

// ==================== REQUEST LOG (DEBUG) ====================
const requestLog = [];
const MAX_REQUEST_LOG = 200;

app.use((req, res, next) => {
    // Log all non-polling requests (polling is too noisy)
    const isPolling = req.path.includes('pending-orders') || req.path.includes('/poll/');
    const isHealth = req.path === '/health' || req.path === '/';

    if (!isPolling && !isHealth) {
        const entry = {
            time: new Date().toISOString(),
            method: req.method,
            path: req.path,
            ip: req.ip || req.connection?.remoteAddress,
            headers: {
                'content-type': req.headers['content-type'],
                'user-agent': req.headers['user-agent']?.substring(0, 100),
                'x-webhook-secret': req.headers['x-webhook-secret'] ? '***SET***' : undefined,
                'x-api-key': req.headers['x-api-key'] ? req.headers['x-api-key'].substring(0, 8) + '...' : undefined
            },
            bodyKeys: req.body ? Object.keys(req.body) : [],
            bodyPreview: req.body ? JSON.stringify(req.body).substring(0, 200) : null
        };
        requestLog.push(entry);
        if (requestLog.length > MAX_REQUEST_LOG) requestLog.shift();
        console.log(`[REQUEST] ${req.method} ${req.path} from ${entry.ip}`);
    }
    next();
});

// ==================== IN-MEMORY QUEUES (GERİYE UYUMLULUK) ====================
const orderStore = new OrderStore(getRedisClient(), isRedisAvailable, {
    maxPerBranch: 500,
    maxTotal: 10000
});
const cancellationStore = new CancellationStore(getRedisClient(), isRedisAvailable);
const webhookStore = new WebhookStore(getRedisClient(), isRedisAvailable);

// ==================== LAZY CLEANUP ====================
const LAZY_CLEANUP_THRESHOLD = 30 * 60 * 1000; // 30 dakika
let lastLazyCleanup = Date.now();
const LAZY_CLEANUP_INTERVAL = 60 * 1000; // En fazla 60sn'de bir lazy cleanup yap

async function lazyCleanupOrders(branchId) {
    const now = Date.now();
    if (now - lastLazyCleanup < LAZY_CLEANUP_INTERVAL) return;
    lastLazyCleanup = now;
    await orderStore.cleanupBranch(branchId, LAZY_CLEANUP_THRESHOLD);
}

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

// Webhook authentication middleware (internal API'ler için)
function authenticateWebhook(req, res, next) {
    if (!WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook authentication not configured' });
    const secret = req.headers['x-webhook-secret'] || req.query.secret;
    if (!secret || !timingSafeCompare(secret, WEBHOOK_SECRET)) {
        console.warn(`[Security] Unauthorized webhook attempt from ${req.ip} to ${req.path}`);
        return res.status(401).json({ error: 'Unauthorized webhook' });
    }
    next();
}

// Timing-safe string karşılaştırma (timing attack önleme)
function timingSafeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Uzunluk farklıysa bile sabit sürede karşılaştır (bilgi sızdırmamak için)
        const padded = Buffer.alloc(bufA.length);
        bufB.copy(padded, 0, 0, Math.min(bufB.length, padded.length));
        crypto.timingSafeEqual(bufA, padded);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// Platform webhook'ları için auth (DH/GetirYemek/TrendyolGo kendi secret'larını göndermez)
function authenticatePlatformWebhook(req, res, next) {
    // Platform webhook'ları doğrudan gelir, x-webhook-secret göndermezler
    // Gelecekte platform-bazlı doğrulama eklenebilir (IP whitelist, HMAC vs.)
    next();
}

// ==================== BRANCH VALIDATION (HARD) ====================
// In-memory cache: branchId → { exists: bool, timestamp: Date }
const branchValidationCache = new Map();
const BRANCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 dakika

async function validateBranchId(branchId, platform, dbRef) {
    if (!branchId) return { valid: false, reason: 'branchId is required' };
    if (!dbRef) return { valid: true, reason: 'firebase_not_available' }; // Firebase yoksa geç (graceful)

    // Cache kontrol
    const cached = branchValidationCache.get(branchId);
    if (cached && (Date.now() - cached.timestamp) < BRANCH_CACHE_TTL_MS) {
        if (!cached.exists) {
            console.warn(`[Security] REJECTED: Unknown branchId ${branchId} for ${platform} (cached)`);
            return { valid: false, reason: 'invalid_branch' };
        }
        return { valid: true };
    }

    // Firestore'dan doğrula
    try {
        const branchSnap = await dbRef.collection('branches').doc(branchId).get();
        const exists = branchSnap.exists;
        branchValidationCache.set(branchId, { exists, timestamp: Date.now() });

        if (!exists) {
            console.error(`[Security] REJECTED: Branch ${branchId} does NOT exist — ${platform} webhook blocked`);
            return { valid: false, reason: 'invalid_branch' };
        }
        return { valid: true };
    } catch (err) {
        console.error(`[Security] Branch validation error for ${branchId}:`, err.message);
        // Hata durumunda siparişi geçir (false negative'den kaçın — canlı restoran etkilenmesin)
        return { valid: true, reason: 'validation_error_passthrough' };
    }
}

// ==================== GETIRYEMEK DEBUG CAPTURE ====================
// Son 20 Getir webhook'unun ham payload'ını (header + body) tutar.
// Tanı için: kullanıcı sipariş gönderdiğinde Getir'in tam olarak neyi
// gönderdiğini, hangi secret'ı kullandığını, body içinde restaurant id
// olup olmadığını görmek için kullanılır.
const lastGetirWebhooks = [];
const MAX_GETIR_DEBUG = 20;

function captureGetirWebhook(req, resolvedBranchId, urlBranchId, resolveResult) {
    // In-memory (per-instance) — hızlı erişim
    try {
        lastGetirWebhooks.push({
            time: new Date().toISOString(),
            ip: req.ip || req.connection?.remoteAddress,
            method: req.method,
            path: req.path,
            query: req.query,
            headers: {
                'content-type': req.headers['content-type'],
                'user-agent': req.headers['user-agent']?.substring(0, 100),
                'x-restaurant-secret-key': req.headers['x-restaurant-secret-key'] || null,
                'x-branch-id': req.headers['x-branch-id'] || null,
                'x-api-key': req.headers['x-api-key'] ? req.headers['x-api-key'].substring(0, 8) + '...' : null,
            },
            body: req.body,
            resolveResult: {
                urlBranchId: urlBranchId,
                resolvedBranchId: resolvedBranchId,
                finalBranchId: resolveResult,
                mismatch: urlBranchId && resolvedBranchId && urlBranchId !== resolvedBranchId,
            },
        });
        if (lastGetirWebhooks.length > MAX_GETIR_DEBUG) lastGetirWebhooks.shift();
    } catch (err) {
        console.error('[GetirDebug] in-memory capture failed:', err.message);
    }

    // Firestore (multi-instance shared) — best effort, fire-and-forget
    if (db) {
        db.collection('debugGetirWebhooks').add({
            time: admin.firestore.FieldValue.serverTimestamp(),
            ip: req.ip || null,
            path: req.path,
            query: req.query || {},
            headers: {
                'content-type': req.headers['content-type'] || null,
                'user-agent': (req.headers['user-agent'] || '').substring(0, 100),
                'x-restaurant-secret-key': req.headers['x-restaurant-secret-key'] || null,
                'x-branch-id': req.headers['x-branch-id'] || null,
            },
            bodyKeys: Object.keys(req.body || {}),
            bodyJson: JSON.stringify(req.body || {}).substring(0, 8000),
            resolveResult: {
                urlBranchId: urlBranchId || null,
                resolvedBranchId: resolvedBranchId || null,
                finalBranchId: resolveResult || null,
                mismatch: !!(urlBranchId && resolvedBranchId && urlBranchId !== resolvedBranchId),
            },
        }).catch(err => console.error('[GetirDebug] Firestore capture failed:', err.message));
    }
}

// ==================== GETIRYEMEK BRANCH RESOLVER ====================
// Gelen Getir webhook'unun hangi şubeye ait olduğunu, x-restaurant-secret-key
// header'ından Firestore'a bakarak çözer. URL'deki branchId'ye GÜVENMEZ —
// secret authoritative kaynaktır (multi-tenant izolasyon).
//
// In-memory cache: secret → { branchId, timestamp }
const getirSecretBranchCache = new Map();
const GETIR_SECRET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 dakika

async function resolveBranchByGetirSecret(secret, dbRef) {
    if (!secret || !dbRef) return null;

    const cached = getirSecretBranchCache.get(secret);
    if (cached && (Date.now() - cached.timestamp) < GETIR_SECRET_CACHE_TTL_MS) {
        return cached.branchId;
    }

    try {
        // Aynı secret birden fazla şubede olabilir (test şube vs prod) — limit(5) ile
        // ambiguity tespit edebiliyoruz, sonra client-side `isEnabled !== false` filtre.
        // 14 şubede `getirYemek_isEnabled` field'ı yok (undefined → backward-compat:
        // aktif say). Sadece açıkça `false` olanlar elenir; tipik test şubeleri böyle.
        const snap = await dbRef.collection('branches')
            .where('getirYemek_restaurantSecretKey', '==', secret)
            .limit(5)
            .get();

        if (snap.empty) {
            getirSecretBranchCache.set(secret, { branchId: null, timestamp: Date.now() });
            return null;
        }

        const activeMatches = snap.docs.filter(d => d.data().getirYemek_isEnabled !== false);

        if (activeMatches.length === 0) {
            console.warn(`[GetirYemek] secret=${secret.substring(0, 10)}... ${snap.size} match buldu ama hepsi isEnabled=false`);
            getirSecretBranchCache.set(secret, { branchId: null, timestamp: Date.now() });
            return null;
        }

        if (activeMatches.length > 1) {
            // Aynı secret birden fazla aktif şubede → secret artık otoriter sayılamaz.
            // Caller body.restaurantId fallback'ine düşmeli (resolveBranchByGetirRestaurantId).
            const ids = activeMatches.map(d => d.id).join(', ');
            console.error(`[GetirYemek] AMBIGUOUS secret=${secret.substring(0, 10)}... ${activeMatches.length} aktif şubeye eşleşiyor (${ids}); secret resolve atlandı, restaurantId şart`);
            getirSecretBranchCache.set(secret, { branchId: null, timestamp: Date.now() });
            return null;
        }

        const branchId = activeMatches[0].id;
        getirSecretBranchCache.set(secret, { branchId, timestamp: Date.now() });
        return branchId;
    } catch (err) {
        console.error('[GetirYemek] Secret→branch resolve error:', err.message);
        return null;
    }
}

// Body içindeki Getir restaurantId'den şube çözer (paylaşılan secret olan
// firmaları ayırmak için). branches.getirYemek_restaurantId ile eşleşir.
const getirRestaurantBranchCache = new Map();
async function resolveBranchByGetirRestaurantId(restaurantId, dbRef) {
    if (!restaurantId || !dbRef) return null;
    const key = String(restaurantId);
    const cached = getirRestaurantBranchCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < GETIR_SECRET_CACHE_TTL_MS) {
        return cached.branchId;
    }
    try {
        // Secret resolver ile aynı pattern: ambiguity'i tespit et, isEnabled=false elenir.
        // Aynı restaurantId iki aktif şubede paylaşılırsa caller env_fallback'a düşer.
        const snap = await dbRef.collection('branches')
            .where('getirYemek_restaurantId', '==', key)
            .limit(5)
            .get();

        if (snap.empty) {
            getirRestaurantBranchCache.set(key, { branchId: null, timestamp: Date.now() });
            return null;
        }

        const activeMatches = snap.docs.filter(d => d.data().getirYemek_isEnabled !== false);

        if (activeMatches.length === 0) {
            console.warn(`[GetirYemek] restaurantId=${key} ${snap.size} match buldu ama hepsi isEnabled=false`);
            getirRestaurantBranchCache.set(key, { branchId: null, timestamp: Date.now() });
            return null;
        }

        if (activeMatches.length > 1) {
            const ids = activeMatches.map(d => d.id).join(', ');
            console.error(`[GetirYemek] AMBIGUOUS restaurantId=${key} ${activeMatches.length} aktif şubeye eşleşiyor (${ids})`);
            getirRestaurantBranchCache.set(key, { branchId: null, timestamp: Date.now() });
            return null;
        }

        const branchId = activeMatches[0].id;
        getirRestaurantBranchCache.set(key, { branchId, timestamp: Date.now() });
        return branchId;
    } catch (err) {
        console.error('[GetirYemek] RestaurantId→branch resolve error:', err.message);
        return null;
    }
}

// ==================== FIREBASE CONFIGURATION ====================
// Plan 27 Faz 1.1: init delegated to @yemigo/shared/firestore-admin (auto-init on require).
const { db, firebaseInitialized } = require('@yemigo/shared/firestore-admin');

// ==================== PLATFORM REGISTRY INITIALIZATION ====================
const platformRegistry = new PlatformRegistry(db);
let smartDispatchService = null;
let dispatchMetrics = null;
let dispatchAlerts = null;
let dispatchQueue = null;
let preDispatchBuffer = null; // Plan 29 Faz 2.3
let dispatchAudit = null;     // Plan 29 Faz 2.4
let delayedCallQueue = null;

async function initializePlatformHub() {
    console.log('[PlatformHub] Initializing...');

    // Initialize registry
    await platformRegistry.initialize();

    // Create and register connectors
    const yemeksepetiConnector = new YemekSepetiConnector(db, platformRegistry);
    const getiryemekConnector = new GetirYemekConnector(db, platformRegistry);
    const trendyolgoConnector = new TrendyolGoConnector(db, platformRegistry);
    const fuudyConnector = new FuudyConnector(db, platformRegistry);

    platformRegistry.registerConnector('yemeksepeti', yemeksepetiConnector);
    platformRegistry.registerConnector('getiryemek', getiryemekConnector);
    platformRegistry.registerConnector('trendyolgo', trendyolgoConnector);
    platformRegistry.registerConnector('fuudy', fuudyConnector);

    const migrosyemekConnector = new MigrosYemekConnector(db, platformRegistry);
    platformRegistry.registerConnector('migrosyemek', migrosyemekConnector);

    // Plan 30: Telefon siparişi connector — WPF DispatchApiClient tarafından
    // POST /api/v2/orders/phone/{docId}/assign-courier ile tetiklenir.
    // Connector tableOrders koleksiyonuna assignedCourierId/Name yazar (base.assignCourier transaction).
    const phoneConnector = new PhoneConnector(db, platformRegistry);
    platformRegistry.registerConnector('phone', phoneConnector);

    // Initialize Dispatch Metrics & Alerts
    dispatchMetrics = new DispatchMetrics(db);
    dispatchAlerts = new DispatchAlerts(db);

    // Initialize Smart Dispatch
    smartDispatchService = new SmartDispatchService(db, platformRegistry);
    smartDispatchService.setMetrics(dispatchMetrics);
    smartDispatchService.setAlerts(dispatchAlerts);
    smartDispatchService.setCourierState(courierState);
    smartDispatchService.setRedis(getRedisClient(), isRedisAvailable);

    // Initialize Dispatch Queue (retry for failed assignments)
    dispatchQueue = new DispatchQueue(db, smartDispatchService, platformRegistry, dispatchMetrics);
    dispatchQueue.start();

    // Plan 29 Faz 2.3 — Pre-dispatch buffer (geriye uyumlu: bufferSeconds=0 default → buffer atlanır)
    preDispatchBuffer = new PreDispatchBuffer(db, smartDispatchService, platformRegistry, dispatchQueue);
    preDispatchBuffer.start();

    // Plan 29 Faz 2.4 — Audit log (her atama için "neden bu kurye" karar dokümanı)
    dispatchAudit = new DispatchAudit(db);
    if (typeof smartDispatchService.setAudit === 'function') {
        smartDispatchService.setAudit(dispatchAudit);
    }

    // Initialize Delayed API Call Queue (GetirYemek 1-minute rule — RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.3)
    // Worker stays dormant until Faz 1.4 wires connector.executeAction.
    try {
        delayedCallQueue = new DelayedCallQueue(db, platformRegistry);
        delayedCallQueue.start();
    } catch (delayedQueueErr) {
        console.error('[PlatformHub] DelayedCallQueue init failed (non-fatal):', delayedQueueErr.message);
    }

    console.log('[PlatformHub] Initialized with connectors:', Array.from(platformRegistry.connectors.keys()));
}

// ==================== SMART DISPATCH SERVICE ====================
// 5-factor weighted scoring matching WPF CourierScoreCalculator
// Weights: distanceToBranch=0.25, availability=0.25, workload=0.20, deliveryProximity=0.15, performance=0.15
class SmartDispatchService {
    constructor(db, registry) {
        this.db = db;
        this.registry = registry;

        // Circuit breakers for external service calls (must init before googleMaps)
        this.firestoreBreaker = new CircuitBreaker('firestore-read', {
            failureThreshold: 5,
            resetTimeoutMs: 60000,
            jitterFactor: 0.3,
            halfOpenSuccessThreshold: 2
        });
        this.googleMapsBreaker = new CircuitBreaker('google-maps', {
            failureThreshold: 3,
            resetTimeoutMs: 30000,
            jitterFactor: 0.3,
            halfOpenSuccessThreshold: 1
        });

        this.googleMaps = new GoogleMapsDistanceService();
        this.googleMaps.setCircuitBreaker(this.googleMapsBreaker);

        // [FIX-2] Assignment tracking via Redis-backed CourierStateStore
        // courierState is injected via setCourierState() after construction
        this._courierState = null;

        // [FIX-3] Mutex: serializes assignBestCourier calls to prevent race conditions
        this._assignmentQueue = Promise.resolve();

        // Default scoring weights (Plan 29 Faz 1.1+1.2: recency + workload sertleştirme)
        // Sektör ilhamı: DoorDash acceptance-rate tabanlı tie-breaker; workload'u şube avantajına karşı güçlendir
        this.defaultWeights = {
            distanceToBranch: 0.18,
            availability: 0.22,
            workload: 0.25,
            deliveryProximity: 0.10,
            performance: 0.15,
            recency: 0.10
        };
        this.weights = { ...this.defaultWeights };

        // Recency thresholds (saniye) — son atamadan beri geçen süre
        this.RECENCY_HOT_S = 60;       // <60s = tam ceza
        this.RECENCY_WARM_S = 300;     // <300s = yarı ceza

        // Dynamic weights cache: Redis-backed with in-memory fallback
        this._weightCache = new Map(); // fallback when Redis unavailable
        this._WEIGHT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
        this._WEIGHT_CACHE_TTL_S = 300; // 5 minutes in seconds (for Redis SETEX)
        this._redisClient = null;
        this._isRedisAvailable = null;

        // Dispatch metrics & alerts (injected later via setMetrics/setAlerts)
        this.dispatchMetrics = null;
        this.dispatchAlerts = null;

        // Constants
        this.MAX_DISTANCE_KM = 10.0;
        this.MAX_AVAILABILITY_MINUTES = 60.0;
        this.MAX_ACTIVE_ORDERS = 5;
        this.MAX_RATING = 5.0;
        this.ASSIGNMENT_TRACKING_TTL_MS = 60 * 1000; // 60 seconds

        // [FIX-4] Tie-breaker threshold: 5 points (covers typical location differences)
        this.TIE_BREAKER_THRESHOLD = 5.0;
    }

    setMetrics(dispatchMetrics) {
        this.dispatchMetrics = dispatchMetrics;
    }

    setAlerts(dispatchAlerts) {
        this.dispatchAlerts = dispatchAlerts;
    }

    // Plan 29 Faz 2.4 — Audit log injection
    setAudit(dispatchAudit) {
        this.dispatchAudit = dispatchAudit;
    }

    setCourierState(courierStateStore) {
        this._courierState = courierStateStore;
    }

    setRedis(redisClient, isRedisAvailableFn) {
        this._redisClient = redisClient;
        this._isRedisAvailable = isRedisAvailableFn;
    }

    getCircuitBreakerStatuses() {
        return [
            this.firestoreBreaker.getStatus(),
            this.googleMapsBreaker.getStatus()
        ];
    }

    /**
     * Get dispatch weights for a branch — Redis cache (shared across instances) with in-memory fallback
     * Falls back to defaults if not found or invalid
     */
    async getWeightsForBranch(branchId) {
        if (!this.db || !branchId) return this.defaultWeights;

        const redisKey = `dispatch:weights:${branchId}`;
        const useRedis = this._redisClient && this._isRedisAvailable && this._isRedisAvailable();

        // Check Redis cache first (shared across instances)
        if (useRedis) {
            try {
                const cached = await this._redisClient.get(redisKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (err) {
                console.warn('[SmartDispatch] Redis weight cache read failed, checking memory:', err.message);
            }
        }

        // Fallback: check in-memory cache
        if (!useRedis) {
            const cached = this._weightCache.get(branchId);
            if (cached && Date.now() < cached.expiresAt) {
                return cached.weights;
            }
        }

        // Cache miss — load from Firestore (through circuit breaker)
        let weights = this.defaultWeights;
        const loadedWeights = await this.firestoreBreaker.execute(
            async () => {
                const doc = await this.db.doc(`branches/${branchId}/settings/dispatchWeights`).get();
                if (doc.exists) {
                    const data = doc.data();
                    return this._validateWeights(data) || this.defaultWeights;
                }
                return this.defaultWeights;
            },
            () => {
                console.warn('[SmartDispatch] Firestore CB open — using default weights');
                return this.defaultWeights;
            }
        );
        weights = loadedWeights;

        // Store in Redis (primary) or in-memory (fallback)
        if (useRedis) {
            try {
                await this._redisClient.setex(redisKey, this._WEIGHT_CACHE_TTL_S, JSON.stringify(weights));
            } catch (err) {
                console.warn('[SmartDispatch] Redis weight cache write failed:', err.message);
            }
        }
        // Always update in-memory cache as fallback
        this._weightCache.set(branchId, {
            weights,
            expiresAt: Date.now() + this._WEIGHT_CACHE_TTL_MS
        });

        return weights;
    }

    /**
     * Validate weights object — 5 zorunlu key + opsiyonel recency (geriye uyumlu).
     * Eski 5-key Firestore doc'ları kabul eder, recency=0 olarak normalize eder.
     */
    _validateWeights(data) {
        const requiredKeys = ['distanceToBranch', 'availability', 'workload', 'deliveryProximity', 'performance'];
        const weights = {};

        for (const key of requiredKeys) {
            if (typeof data[key] !== 'number' || data[key] < 0 || data[key] > 1) {
                return null; // Invalid
            }
            weights[key] = data[key];
        }

        // Recency opsiyonel — yoksa 0 (eski 5-key dokümanlar geriye uyumlu)
        weights.recency = (typeof data.recency === 'number' && data.recency >= 0 && data.recency <= 1)
            ? data.recency : 0;

        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1.0) > 0.05) {
            console.warn(`[SmartDispatch] Weights sum ${sum.toFixed(2)} != 1.0, using defaults`);
            return null;
        }

        return weights;
    }

    async getBranchLocation(branchId) {
        if (!this.db) return null;

        return this.firestoreBreaker.execute(
            async () => {
                // Branches root collection; doc id == branchId. Earlier collectionGroup('branches')
                // .where('id','==',branchId) silently returned empty because docs have no 'id' field.
                const branchDoc = await this.db.doc(`branches/${branchId}`).get();
                if (branchDoc.exists) {
                    const data = branchDoc.data();
                    return {
                        latitude: data.latitude || data.lat || 0,
                        longitude: data.longitude || data.lng || 0
                    };
                }
                return null;
            },
            () => null
        );
    }

    async getAvailableCouriers(branchId) {
        if (!this.db) return [];

        return this.firestoreBreaker.execute(
            async () => {
                // Couriers live in root /couriers/. Avoid collectionGroup (requires composite
                // COLLECTION_GROUP index on branchId+isOnDuty+isActive that is not deployed —
                // before this fix every probe failed and tripped firestore-read circuit breaker).
                const couriersSnapshot = await this.db.collection('couriers')
                    .where('branchId', '==', branchId)
                    .where('isOnDuty', '==', true)
                    .where('isActive', '==', true)
                    .get();

                return couriersSnapshot.docs
                    .map(doc => {
                        const data = doc.data();
                        return {
                            id: doc.id,
                            name: data.name || data.fullName || '',
                            phone: data.phone || '',
                            latitude: data.latitude || data.currentLatitude || 0,
                            longitude: data.longitude || data.currentLongitude || 0,
                            activeOrderCount: data.activeOrderCount || 0,
                            dailyDeliveryCount: data.dailyDeliveryCount || data.totalDeliveriesToday || 0,
                            rating: data.rating || 0,
                            isApproved: data.isApproved !== undefined ? data.isApproved : true,
                            fcmToken: data.fcmToken || null,
                            // Plan 29 Faz 1.1 — round-robin için son atama zamanı (Firestore Timestamp veya null)
                            lastAssignedAt: data.lastAssignedAt || null
                        };
                    })
                    .filter(c => c.isApproved);
            },
            () => []
        );
    }

    async getActiveOrderCount(courierId) {
        const pendingCount = await this._getPendingCount(courierId);
        if (!this.db) return pendingCount;

        return this.firestoreBreaker.execute(
            async () => {
                const platforms = ['yemekSepetiOrders', 'getirYemekOrders', 'trendyolGoOrders'];
                let totalActive = 0;

                // [FIX-1] Include 'NEW' and 'PREPARING' statuses — orders assigned during
                // webhook flow keep Status:'NEW', accept flow keeps Status:'ACCEPTED'
                for (const platform of platforms) {
                    // Orders live in root collections. collectionGroup variant needs COLLECTION_GROUP
                    // composite index on (assignedCourierId, Status) which is not deployed.
                    const ordersSnapshot = await this.db.collection(platform)
                        .where('assignedCourierId', '==', courierId)
                        .where('Status', 'in', ['NEW', 'PREPARING', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'ON_THE_WAY'])
                        .get();
                    totalActive += ordersSnapshot.size;
                }

                // [FIX-2] Add ALL pending assignments not yet reflected in Firestore
                totalActive += pendingCount;
                return totalActive;
            },
            () => pendingCount
        );
    }

    // ==================== 5-FACTOR SCORING ====================

    /**
     * Distance to branch score (0-100, low = close = good)
     */
    _calcDistanceToBranchScore(courier, branchLocation, branchDistanceInfo) {
        // Real Google Maps data available
        if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
            return this._calcDistanceScoreFromReal(branchDistanceInfo.distanceKm);
        }

        // Haversine fallback
        if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
            branchLocation && this._isValidCoordinate(branchLocation.latitude, branchLocation.longitude)) {
            const distanceMeters = geolib.getDistance(
                { latitude: courier.latitude, longitude: courier.longitude },
                { latitude: branchLocation.latitude, longitude: branchLocation.longitude }
            );
            const distanceKm = distanceMeters / 1000;
            let normalized = Math.min(distanceKm / this.MAX_DISTANCE_KM, 1.0) * 100;
            if (distanceKm < 0.5) normalized *= 0.5; // Near-branch bonus
            return normalized;
        }

        return 100; // No location = worst score
    }

    /**
     * Real road distance to score (0-100)
     */
    _calcDistanceScoreFromReal(distanceKm) {
        if (distanceKm <= 0) return 0;
        let normalized = Math.min(distanceKm / this.MAX_DISTANCE_KM, 1.0) * 100;
        if (distanceKm < 0.5) normalized *= 0.5; // 500m bonus
        return normalized;
    }

    /**
     * Plan 29 Faz 2.2 — readyAt-aware availability scoring
     * estimatedReadyAt verilirse, kuryenin "ne zaman serbest olacağı" ile yemeğin "ne zaman hazır olacağı" karşılaştırılır.
     * Δ = freeAt - readyAt (dakika): -10 ≤ Δ ≤ 5 mükemmel pencere (0 puan), Δ > 15 kabul edilemez (100 puan).
     * estimatedReadyAt yoksa → eski formüle düşer (geriye uyumlu).
     */
    _calcAvailabilityScoreReadyAware(courier, estimatedReadyAt, branchDistanceInfo) {
        if (!estimatedReadyAt) return null; // Sinyal yoksa caller eski formüle düşsün

        const readyMs = typeof estimatedReadyAt.toMillis === 'function'
            ? estimatedReadyAt.toMillis()
            : new Date(estimatedReadyAt).getTime();
        if (!Number.isFinite(readyMs)) return null;

        // freeAt(courier) = now + activeOrderCount × 20 dk + (yoldaysa) returnDistanceMin
        let busyMinutes = (courier.activeOrderCount || 0) * 20;
        if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
            busyMinutes += branchDistanceInfo.durationMinutes || 0;
        }
        const freeAtMs = Date.now() + busyMinutes * 60 * 1000;
        const deltaMin = (freeAtMs - readyMs) / 60000;

        if (deltaMin < -10) return 50;            // Kurye 10dk+ erken — boşa bekler
        if (deltaMin <= 5) return 0;              // Mükemmel pencere
        if (deltaMin <= 15) return 50;            // Yemek 5-15 dk soğur
        return 100;                                // Kabul edilemez geç
    }

    /**
     * Availability score (0-100, low = available soon = good)
     */
    _calcAvailabilityScore(courier, branchLocation, branchDistanceInfo) {
        if (courier.activeOrderCount === 0) {
            // Free courier - score based on return time to branch
            if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
                // Real return time: if under 10 min, great
                if (branchDistanceInfo.durationMinutes <= 10) return 0;
                const lateMinutes = branchDistanceInfo.durationMinutes - 10;
                return Math.min(lateMinutes / 10 * 100, 100);
            }

            // Haversine estimate
            if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
                branchLocation && this._isValidCoordinate(branchLocation.latitude, branchLocation.longitude)) {
                const distanceMeters = geolib.getDistance(
                    { latitude: courier.latitude, longitude: courier.longitude },
                    { latitude: branchLocation.latitude, longitude: branchLocation.longitude }
                );
                const estimatedMinutes = Math.max(2, (distanceMeters / 1000 / 25) * 60); // 25 km/h motorcycle
                if (estimatedMinutes <= 10) return 0;
                return Math.min((estimatedMinutes - 10) / 10 * 100, 100);
            }

            return 0; // Free and no location data - assume available
        }

        // Busy courier: each active order ~15 min
        const estimatedBusyMinutes = courier.activeOrderCount * 15;
        return Math.min(estimatedBusyMinutes / this.MAX_AVAILABILITY_MINUTES, 1.0) * 100;
    }

    /**
     * Workload score (0-100, low = light workload = good)
     * Plan 29 Faz 1.2 — eksponansiyel: şubedeki kuryenin avantajını kırmak için
     * lineer formül 1 sipariş = 20 puan veriyordu, çok zayıf ceza. Yeni: hızlı doygunluk
     */
    _calcWorkloadScore(activeOrderCount) {
        const tiers = [0, 30, 60, 85, 100];
        return tiers[Math.min(activeOrderCount, tiers.length - 1)];
    }

    /**
     * Plan 29 Faz 3.1 — Batch alignment bonus (negatif puan = kurye lehine).
     * Kurye yoldaki son aktif siparişinin teslimat noktasına yakın yeni sipariş gelirse, atanması verim sağlar (DoorDash/Uber Eats batching mantığı).
     * Mesafe bandı:
     *   < 1.5 km  → -15 (güçlü bonus)
     *   < 3.0 km  → -8  (orta bonus)
     *   ≥ 3.0 km  → 0   (bonus yok)
     * Sınır: kuryenin aktif sipariş sayısı maxBatchSize'dan büyükse skor 9999 (atanamaz emniyeti).
     */
    _calcBatchAlignmentScore(courier, newDeliveryLoc, recentDeliveryLoc, maxBatchSize) {
        if (!recentDeliveryLoc || !this._isValidCoordinate(recentDeliveryLoc.latitude, recentDeliveryLoc.longitude)) return 0;
        if (!newDeliveryLoc || !this._isValidCoordinate(newDeliveryLoc.latitude, newDeliveryLoc.longitude)) return 0;
        if ((courier.activeOrderCount || 0) >= maxBatchSize) return 9999; // emniyet — overload

        const distMeters = geolib.getDistance(
            { latitude: recentDeliveryLoc.latitude, longitude: recentDeliveryLoc.longitude },
            { latitude: newDeliveryLoc.latitude, longitude: newDeliveryLoc.longitude }
        );
        const distKm = distMeters / 1000;
        if (distKm < 1.5) return -15;
        if (distKm < 3.0) return -8;
        return 0;
    }

    /**
     * Plan 29 Faz 3.1 — Şube batching policy (5 dk cache).
     * branches/{id}/settings/dispatchSettings.batchingEnabled (default false), maxBatchSize (default 3).
     */
    async getBatchPolicyForBranch(branchId) {
        if (!this.db || !branchId) return { enabled: false, maxBatchSize: 3 };
        const cached = this._batchPolicyCache?.get(branchId);
        if (cached && Date.now() < cached.expiresAt) return cached.policy;

        if (!this._batchPolicyCache) this._batchPolicyCache = new Map();

        let policy = { enabled: false, maxBatchSize: 3 };
        try {
            const doc = await this.db.doc(`branches/${branchId}/settings/dispatchSettings`).get();
            if (doc.exists) {
                const data = doc.data();
                policy = {
                    enabled: data.batchingEnabled === true,
                    maxBatchSize: typeof data.maxBatchSize === 'number' ? Math.min(Math.max(2, data.maxBatchSize), 5) : 3
                };
            }
        } catch (err) {
            console.warn('[SmartDispatch] batch policy read fail:', err.message);
        }

        this._batchPolicyCache.set(branchId, { policy, expiresAt: Date.now() + 5 * 60 * 1000 });
        return policy;
    }

    /**
     * Plan 29 Faz 3.1 — Kuryenin son aktif teslimat lokasyonu (5 platform collectionGroup).
     * Index hatasında sessizce null döner (geriye uyumlu, batching kapalı kalır).
     */
    async getRecentDeliveryLocationForCourier(courierId, branchId) {
        if (!this.db || !courierId) return null;
        const platforms = ['yemekSepetiOrders', 'getirYemekOrders', 'trendyolGoOrders', 'migrosYemekOrders', 'fuudyOrders'];
        for (const platform of platforms) {
            try {
                let q = this.db.collectionGroup(platform)
                    .where('assignedCourierId', '==', courierId)
                    .where('Status', 'in', ['ACCEPTED', 'PREPARING', 'PICKED_UP', 'ON_THE_WAY']);
                if (branchId) q = q.where('branchId', '==', branchId);
                const snap = await q.limit(1).get();
                if (!snap.empty) {
                    const data = snap.docs[0].data();
                    const lat = data.deliveryLatitude || data.customerLatitude || data?.Customer?.Address?.Latitude || 0;
                    const lng = data.deliveryLongitude || data.customerLongitude || data?.Customer?.Address?.Longitude || 0;
                    if (lat && lng) return { latitude: lat, longitude: lng };
                }
            } catch (err) {
                // index hatası → sessiz devam (batching opsiyonel)
            }
        }
        return null;
    }

    /**
     * Recency score (0-100, low = atanmaz, yüksek = ceza)
     * Plan 29 Faz 1.1 — round-robin sinyali. Eşit skorlu kuryelerde son atanan ceza alır.
     * lastAssignedAt: Firestore Timestamp | Date | null. null ise hiç ceza yok (yeni kurye veya hiç atanmamış).
     */
    _calcRecencyScore(lastAssignedAt) {
        if (!lastAssignedAt) return 0;
        const lastMs = typeof lastAssignedAt.toMillis === 'function'
            ? lastAssignedAt.toMillis()
            : new Date(lastAssignedAt).getTime();
        if (!Number.isFinite(lastMs)) return 0;

        const deltaS = (Date.now() - lastMs) / 1000;
        if (deltaS < this.RECENCY_HOT_S) return 100;   // <60s = tam ceza
        if (deltaS < this.RECENCY_WARM_S) return 50;   // <300s = yarı ceza
        return 0;                                        // ≥300s = ceza yok
    }

    /**
     * Delivery proximity score (0-100, low = close to delivery = good)
     */
    _calcDeliveryProximityScore(courier, deliveryLocation, deliveryDistanceInfo) {
        // Real Google Maps data
        if (deliveryDistanceInfo && deliveryDistanceInfo.isSuccess && !deliveryDistanceInfo.isFallback) {
            return this._calcDistanceScoreFromReal(deliveryDistanceInfo.distanceKm);
        }

        // Haversine fallback
        if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
            this._isValidCoordinate(deliveryLocation?.latitude, deliveryLocation?.longitude)) {
            const distanceMeters = geolib.getDistance(
                { latitude: courier.latitude, longitude: courier.longitude },
                { latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }
            );
            const distanceKm = distanceMeters / 1000;
            if (distanceKm <= 5) return (distanceKm / 5) * 50;
            return 50 + Math.min((distanceKm - 5) / 10, 0.5) * 100;
        }

        return 50; // Neutral
    }

    /**
     * Performance score (0-100, HIGH = good performance)
     * Uses rating + daily delivery fatigue factor
     */
    _calcPerformanceScore(courier) {
        // Rating component (0-50)
        const ratingScore = (Math.min(courier.rating || 0, this.MAX_RATING) / this.MAX_RATING) * 50;

        // Daily delivery fatigue (0-50)
        const deliveriesToday = courier.dailyDeliveryCount || 0;
        let deliveryScore;
        if (deliveriesToday <= 5) deliveryScore = 50;       // Optimal
        else if (deliveriesToday <= 10) deliveryScore = 40;  // Good
        else if (deliveriesToday <= 15) deliveryScore = 30;  // Getting tired
        else deliveryScore = 20;                              // Very tired

        return ratingScore + deliveryScore;
    }

    /**
     * Calculate full weighted score for a courier
     * Lower total = better courier match
     */
    calculateCourierScore(courier, deliveryLocation, branchLocation, deliveryDistanceInfo, branchDistanceInfo, weights, context) {
        const w = weights || this.defaultWeights;
        const ctx = context || {};
        const distanceToBranchScore = this._calcDistanceToBranchScore(courier, branchLocation, branchDistanceInfo);
        // Plan 29 Faz 2.2 — estimatedReadyAt varsa freeAt vs readyAt formülü, yoksa eski formül (geriye uyumlu)
        const readyAwareScore = this._calcAvailabilityScoreReadyAware(courier, ctx.estimatedReadyAt, branchDistanceInfo);
        const availabilityScore = readyAwareScore !== null
            ? readyAwareScore
            : this._calcAvailabilityScore(courier, branchLocation, branchDistanceInfo);
        const workloadScore = this._calcWorkloadScore(courier.activeOrderCount);
        const deliveryProximityScore = this._calcDeliveryProximityScore(courier, deliveryLocation, deliveryDistanceInfo);
        const performanceScore = this._calcPerformanceScore(courier);
        const recencyScore = this._calcRecencyScore(courier.lastAssignedAt);

        const recencyWeight = typeof w.recency === 'number' ? w.recency : 0;

        const totalScore =
            (distanceToBranchScore * w.distanceToBranch) +
            (availabilityScore * w.availability) +
            (workloadScore * w.workload) +
            (deliveryProximityScore * w.deliveryProximity) +
            ((100 - performanceScore) * w.performance) + // Performance inverted
            (recencyScore * recencyWeight);              // Plan 29 Faz 1.1 — round-robin

        return {
            totalScore,
            details: {
                distanceToBranch: distanceToBranchScore,
                availability: availabilityScore,
                workload: workloadScore,
                deliveryProximity: deliveryProximityScore,
                performance: performanceScore,
                recency: recencyScore
            }
        };
    }

    _isValidCoordinate(lat, lon) {
        return lat && lon && lat !== 0 && lon !== 0 &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    // ==================== ASSIGNMENT TRACKING (FIX-2) ====================

    /**
     * Get pending (not yet in Firestore) assignment count for a courier
     * Now async — reads from Redis-backed CourierStateStore
     */
    async _getPendingCount(courierId) {
        if (this._courierState) {
            return await this._courierState.getPendingCount(courierId);
        }
        return 0;
    }

    /**
     * Track a new assignment — increments counter in Redis with PEXPIRE TTL
     * In memory mode: auto-decrements via setTimeout (same as original behavior)
     */
    async _trackAssignment(courierId) {
        if (this._courierState) {
            await this._courierState.incrementPending(courierId, this.ASSIGNMENT_TRACKING_TTL_MS);
        }
    }

    // ==================== MUTEX (FIX-3) ====================

    /**
     * Serializes assignBestCourier calls so concurrent requests
     * don't read the same stale Firestore state
     */
    _enqueue(fn) {
        const result = this._assignmentQueue.then(fn, fn);
        this._assignmentQueue = result.catch(() => {}); // prevent unhandled rejection chain
        return result;
    }

    // ==================== MAIN ASSIGNMENT ====================

    /**
     * Public entry: queued to prevent race conditions between concurrent calls
     * Plan 29 Faz 2.2 — context: { estimatedReadyAt, orderId, retryAttempt } opsiyonel
     */
    assignBestCourier(branchId, deliveryLocation, context) {
        return this._enqueue(() => this._assignBestCourierInternal(branchId, deliveryLocation, context || {}));
    }

    async _assignBestCourierInternal(branchId, deliveryLocation, context = {}) {
        if (!this.db) {
            console.log('[SmartDispatch] Firebase disabled - skipping auto-assignment');
            return null;
        }

        const scoreStart = Date.now();

        try {
            // Load dynamic weights for branch (cached with 5min TTL)
            const weights = await this.getWeightsForBranch(branchId);

            const couriers = await this.getAvailableCouriers(branchId);
            if (couriers.length === 0) {
                console.log('[SmartDispatch] No available couriers for branch:', branchId);
                // Record metric: no courier
                if (this.dispatchMetrics) {
                    await this.dispatchMetrics.recordAssignment(branchId, null, Date.now() - scoreStart, false, { reason: 'no_couriers' });
                }
                // Alert: record failure + check capacity
                if (this.dispatchAlerts) {
                    await this.dispatchAlerts.recordAttempt(branchId, false);
                }
                return null;
            }

            // Alert: check if all couriers at capacity
            if (this.dispatchAlerts) {
                await this.dispatchAlerts.checkAllAtCapacity(branchId, couriers);
            }

            const branchLocation = await this.getBranchLocation(branchId);

            // Google Maps distances (parallel: to delivery + to branch)
            let deliveryDistances = null;
            let branchDistances = null;

            try {
                const deliveryDest = {
                    latitude: deliveryLocation?.latitude || 0,
                    longitude: deliveryLocation?.longitude || 0
                };
                const branchDest = branchLocation || { latitude: 0, longitude: 0 };

                const [deliveryResult, branchResult] = await Promise.all([
                    this.googleMaps.getBatchDistances(couriers, deliveryDest),
                    branchLocation ? this.googleMaps.getBatchDistances(couriers, branchDest) : Promise.resolve(null)
                ]);

                deliveryDistances = deliveryResult.results;
                branchDistances = branchResult?.results || null;

                const totalFallback = deliveryResult.fallbackCount + (branchResult?.fallbackCount || 0);
                if (totalFallback === 0) {
                    console.log('[SmartDispatch] Google Maps: all couriers resolved via API');
                } else {
                    console.log(`[SmartDispatch] Google Maps: ${totalFallback} fallback(s)`);
                }
            } catch (gmError) {
                console.warn('[SmartDispatch] Google Maps error, using geolib fallback:', gmError.message);
            }

            // Plan 29 Faz 3.1 — Şube batching policy (5 dk cache, default kapalı)
            const batchPolicy = await this.getBatchPolicyForBranch(branchId);

            const scoredCouriers = await Promise.all(
                couriers.map(async (courier) => {
                    const activeOrders = await this.getActiveOrderCount(courier.id);
                    courier.activeOrderCount = activeOrders;

                    const deliveryDistInfo = deliveryDistances ? deliveryDistances.get(courier.id) : null;
                    const branchDistInfo = branchDistances ? branchDistances.get(courier.id) : null;

                    const { totalScore, details } = this.calculateCourierScore(
                        courier, deliveryLocation, branchLocation, deliveryDistInfo, branchDistInfo, weights, context
                    );

                    // Plan 29 Faz 3.1 — Batch alignment bonus (sadece flag açık + kurye boş değilse)
                    let batchScore = 0;
                    if (batchPolicy.enabled && courier.activeOrderCount > 0) {
                        const recentLoc = await this.getRecentDeliveryLocationForCourier(courier.id, branchId);
                        batchScore = this._calcBatchAlignmentScore(courier, deliveryLocation, recentLoc, batchPolicy.maxBatchSize);
                        details.batchAlignment = batchScore;
                    }

                    return {
                        courier,
                        score: totalScore + batchScore, // negatif batchScore = bonus (lehine)
                        details,
                        source: deliveryDistInfo?.source || 'geolib',
                        wasBatched: batchScore < 0
                    };
                })
            );

            // [FIX-4] Sort by score, wide tie-breaker threshold (5 points)
            scoredCouriers.sort((a, b) => {
                const diff = a.score - b.score;
                if (Math.abs(diff) < this.TIE_BREAKER_THRESHOLD) return Math.random() - 0.5;
                return diff;
            });

            const bestMatch = scoredCouriers[0];
            const scoreTimeMs = Date.now() - scoreStart;

            console.log(`[SmartDispatch] Best courier: ${bestMatch.courier.name} (score: ${bestMatch.score.toFixed(1)}, ` +
                `D:${bestMatch.details.distanceToBranch.toFixed(0)} A:${bestMatch.details.availability.toFixed(0)} ` +
                `W:${bestMatch.details.workload.toFixed(0)} P:${bestMatch.details.deliveryProximity.toFixed(0)} ` +
                `R:${bestMatch.details.performance.toFixed(0)} Rc:${(bestMatch.details.recency || 0).toFixed(0)}, ` +
                `source: ${bestMatch.source}, ${scoreTimeMs}ms)`);

            if (scoredCouriers.length > 1) {
                const runner = scoredCouriers[1];
                console.log(`[SmartDispatch] Runner-up: ${runner.courier.name} (score: ${runner.score.toFixed(1)})`);
            }

            // [FIX-2] Track assignment with counter (not single entry)
            await this._trackAssignment(bestMatch.courier.id);

            // Plan 29 Faz 1.4 — Pilot Mod telemetri
            const runnerUp = scoredCouriers[1];
            const tieBreakerUsed = !!runnerUp && Math.abs(bestMatch.score - runnerUp.score) < this.TIE_BREAKER_THRESHOLD;

            // Plan 29 Faz 2.4 — Audit log: "neden bu kurye" karar dokümanı (non-fatal)
            if (this.dispatchAudit) {
                this.dispatchAudit.recordDecision({
                    orderId: context.orderId || null,
                    branchId,
                    decidedBy: context.retryAttempt > 0 ? 'retry' : 'auto',
                    candidates: scoredCouriers.slice(0, 5).map(c => ({
                        courierId: c.courier.id,
                        name: c.courier.name,
                        score: c.score,
                        breakdown: c.details
                    })),
                    weights,
                    selectedCourierId: bestMatch.courier.id,
                    tieBreakerUsed,
                    scoreTimeMs,
                    context: { ...context, wasBatched: bestMatch.wasBatched || false, batchPolicy }
                }).catch(() => {}); // fire-and-forget
            }

            // Record metric
            if (this.dispatchMetrics) {
                await this.dispatchMetrics.recordAssignment(branchId, bestMatch.courier.id, scoreTimeMs, true, {
                    score: bestMatch.score,
                    tieBreakerUsed,
                    recencyScore: bestMatch.details.recency || 0
                });
            }

            // Alert: record success
            if (this.dispatchAlerts) {
                await this.dispatchAlerts.recordAttempt(branchId, true);
            }

            return bestMatch.courier;
        } catch (error) {
            console.error('[SmartDispatch] Assignment error:', error.message);
            // Record metric
            if (this.dispatchMetrics) {
                await this.dispatchMetrics.recordAssignment(branchId, null, Date.now() - scoreStart, false, {
                    reason: error.message
                });
            }
            // Alert: record failure
            if (this.dispatchAlerts) {
                await this.dispatchAlerts.recordAttempt(branchId, false);
            }
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

// ==================== UNIFIED PLATFORM WEBHOOK HANDLER ====================

/**
 * Platform webhook'larında yeni sipariş akışını tek yerde yönetir:
 *   1. metrics.increment (orders_received + webhook_requests)
 *   2. connector.transformOrder (raw → standart şema)
 *   3. writeOrderToFirebaseUnified (Firestore + dedup + field metadata)
 *   4. smartDispatchService.assignBestCourier (+ dispatchQueue fallback)
 *   5. connector.assignCourier + notifyCourierNewOrder (push notification)
 *   6. Socket.IO emit 'order:new' (şubeye realtime bildirim)
 *
 * Yeni platform webhook'u eklerken:
 *   - Kendi handler'ında branchId resolve + auth + delivery location extraction yapar
 *   - `processPlatformOrderWebhook(platformId, rawOrder, branchId, opts)` çağırır
 *   - Ortak logic kopyalanmaz
 */
async function processPlatformOrderWebhook(platformId, rawOrder, branchId, options = {}) {
    const {
        deliveryLocation = null,
        shouldDispatch = true,
        socketCustomerName = '',
        socketTotalAmount = 0,
        platformDisplayName = null
    } = options;

    metrics.increment('orders_received_total', { platform: platformId });
    metrics.increment('webhook_requests_total', { platform: platformId });

    const connector = platformRegistry.getConnector(platformId);
    const transformedOrder = connector ? connector.transformOrder(rawOrder, branchId) : rawOrder;

    const firebaseResult = await writeOrderToFirebaseUnified(transformedOrder, platformId, branchId);

    if (firebaseResult.success && shouldDispatch && smartDispatchService && deliveryLocation) {
        // Plan 29 Faz 2.3 — preDispatchBuffer wrapper (bufferSeconds=0 → eski akış, buffer atlanır)
        // Geriye uyumlu: preDispatchBuffer yoksa direkt assignBestCourier
        const estimatedReadyAt = transformedOrder?.EstimatedReadyAt || transformedOrder?.estimatedReadyAt || null;
        let courier = null;
        let buffered = false;

        if (preDispatchBuffer) {
            const result = await preDispatchBuffer.enqueueOrAssign({
                orderId: firebaseResult.orderId,
                platformId,
                branchId,
                deliveryLocation,
                estimatedReadyAt
            });
            courier = result.courier || null;
            buffered = result.buffered;
        } else {
            courier = await smartDispatchService.assignBestCourier(branchId, deliveryLocation, {
                orderId: firebaseResult.orderId, estimatedReadyAt
            });
        }

        metrics.increment('dispatch_assignments_total', {
            status: courier ? 'success' : (buffered ? 'buffered' : 'queued')
        });

        if (courier) {
            if (connector && connector.assignCourier) {
                await connector.assignCourier(firebaseResult.orderId, courier.id, courier.name);
            }
            await notifyCourierNewOrder(courier, transformedOrder, platformDisplayName || platformId);
        } else if (!buffered && dispatchQueue) {
            await dispatchQueue.enqueue({
                orderId: firebaseResult.orderId,
                platformId,
                branchId,
                deliveryLocation
            });
        }
    }

    if (firebaseResult.success && branchId) {
        io.to(`branch:${branchId}`).emit('order:new', {
            orderId: firebaseResult.orderId,
            platform: platformId,
            customerName: socketCustomerName,
            totalAmount: socketTotalAmount,
            timestamp: new Date().toISOString()
        });
    }

    return firebaseResult;
}

// ==================== SOCKET.IO COURIER TRACKING ====================
const courierState = new CourierStateStore(getRedisClient(), isRedisAvailable);

// ==================== METRICS ====================
const metrics = new MetricsCollector({
    orderStore, cancellationStore, webhookStore, courierState, io, getRedisStatus, getRedisFailoverInfo
});

// Wire circuit breaker metrics (smartDispatchService may be null if Firebase disabled)
metrics.setCircuitBreakerProvider(() => {
    if (!smartDispatchService) return [];
    return smartDispatchService.getCircuitBreakerStatuses();
});

// Wire delayed call queue metrics (queue may be null if Firebase disabled)
if (delayedCallQueue && typeof delayedCallQueue.setMetrics === 'function') {
    delayedCallQueue.setMetrics(metrics);
}

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
    metrics.increment('socket_events_total', { event: 'connect' });
    console.log(`[Socket.io] New connection: ${socket.id}`);

    socket.on('courier:connect', async (data) => {
        const { courierId, branchId, name } = data;
        if (!courierId || !branchId) return;
        console.log(`[Socket.io] Courier connected: ${name} (${courierId})`);

        socket.courierId = courierId;
        socket.branchId = branchId;
        socket.courierName = name;
        socket.userType = 'courier';

        socket.join(`branch:${branchId}`);
        await courierState.setConnected(courierId, socket.id, branchId);

        io.to(`branch:${branchId}`).emit('courier:online', {
            courierId, name, timestamp: new Date().toISOString()
        });

        // Confirm connection to the courier app
        socket.emit('courier:connected', {
            courierId, branchId, timestamp: new Date().toISOString()
        });
    });

    socket.on('pos:connect', async (data) => {
        const { branchId, posName } = data;
        if (!branchId) return;
        console.log(`[Socket.io] POS connected: ${posName}`);

        socket.branchId = branchId;
        socket.posName = posName;
        socket.userType = 'pos';
        socket.join(`branch:${branchId}`);

        const connected = await courierState.getConnectedByBranch(branchId);
        const branchCouriers = [];
        for (const { courierId, socketId } of connected) {
            const courierSocket = io.sockets.sockets.get(socketId);
            const location = await courierState.getLocation(courierId);
            branchCouriers.push({
                courierId,
                name: courierSocket ? courierSocket.courierName : 'Unknown',
                location: location || null
            });
        }
        socket.emit('couriers:list', branchCouriers);
    });

    // POS order listener — joins branch room for order events
    socket.on('pos:order_connect', (data) => {
        const { branchId, posName } = data;
        if (!branchId) return;
        socket.branchId = branchId;
        socket.posName = posName;
        socket.userType = 'pos_order';
        socket.join(`branch:${branchId}`);
        console.log(`[Socket.io] POS order listener: ${posName} joined branch:${branchId}`);
    });

    socket.on('courier:location', async (data) => {
        const { courierId, latitude, longitude, speed, heading } = data;
        if (!courierId || !socket.branchId) return;

        const locationData = { courierId, branchId: socket.branchId, latitude, longitude, speed: speed || 0, heading: heading || 0, timestamp: new Date().toISOString() };
        await courierState.setLocation(courierId, locationData);
        io.to(`branch:${socket.branchId}`).emit('courier:location:update', locationData);
    });

    // Handle batch location updates from courier app (offline queue sync)
    socket.on('courier:location:batch', async (data) => {
        const { courierId, locations } = data;
        if (!courierId || !socket.branchId || !Array.isArray(locations)) return;

        console.log(`[Socket.io] Batch location update: ${locations.length} points from ${courierId}`);
        for (const loc of locations) {
            const locationData = {
                courierId,
                branchId: socket.branchId,
                latitude: loc.latitude || loc.lat,
                longitude: loc.longitude || loc.lng,
                speed: loc.speed || 0,
                heading: loc.heading || 0,
                timestamp: loc.timestamp ? new Date(loc.timestamp).toISOString() : new Date().toISOString()
            };
            await courierState.setLocation(courierId, locationData);
            io.to(`branch:${socket.branchId}`).emit('courier:location:update', locationData);
        }
    });

    socket.on('disconnect', async () => {
        metrics.increment('socket_events_total', { event: 'disconnect' });
        if (socket.userType === 'courier' && socket.courierId) {
            console.log(`[Socket.io] Courier disconnected: ${socket.courierName}`);
            await courierState.removeConnected(socket.courierId);
            await courierState.removeLocation(socket.courierId);
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
}, createOrdersApi(platformRegistry, smartDispatchService, {
    sendPushNotification,
    notifyCourierNewOrder,
    db,
    dispatchMetrics,
    dispatchQueue,
    io
}));

app.use('/api/v2/platforms', createPlatformsApi(platformRegistry, db));

// ==================== Plan 29 Faz 1.5B — Anlık dispatch tetik ====================
// Express "Görevdeyim" toggle olduğunda bu endpoint'i çağırır.
// Mevcut işleyişi BOZMAZ: çağrılmasa bile 15sn polling devam eder.
// Eski APK'lar bu endpoint'i bilmez → mevcut akış sürer.
// Yeni APK'lar çağırınca: kuyruktaki bekleyen siparişler ANINDA değerlendirilir.
app.post('/api/v2/couriers/:branchId/:courierId/notify-availability', async (req, res) => {
    // Auth: aynı x-branch-id pattern'ı (Express NetworkModule zaten gönderiyor)
    const headerBranchId = req.headers['x-branch-id'];
    const { branchId, courierId } = req.params;

    if (!headerBranchId || headerBranchId !== branchId) {
        return res.status(401).json({ success: false, error: 'branch_mismatch' });
    }

    if (!dispatchQueue) {
        // Servis henüz başlatılmadı — sessiz başarı (mevcut polling devralır)
        return res.json({ success: true, processed: 0, assigned: 0, note: 'queue_not_ready' });
    }

    try {
        const result = await dispatchQueue.processQueueForBranch(branchId);
        console.log(`[NotifyAvailability] courier=${courierId} branch=${branchId} → processed=${result.processed} assigned=${result.assigned}`);
        return res.json({ success: true, ...result });
    } catch (error) {
        console.error('[NotifyAvailability] error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Delayed API call queue (RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.5)
// Lazy-mount: queue is initialized inside initializePlatformHub() (async after this point)
let _delayedCallApiRouter = null;
app.use('/api/v2/delayed-call', (req, res, next) => {
    if (!_delayedCallApiRouter && delayedCallQueue) {
        _delayedCallApiRouter = createDelayedCallApi(delayedCallQueue);
    }
    if (_delayedCallApiRouter) return _delayedCallApiRouter(req, res, next);
    return res.status(503).json({
        success: false,
        error: 'DelayedCallQueue not initialized',
        code: 'SERVICE_UNAVAILABLE'
    });
});

// ==================== YEMEKSEPETI WEBHOOKS (LEGACY COMPATIBILITY) ====================

app.post('/order/:remoteId', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;

    // DIAG: bu endpoint Getir tarafından da kullanılıyor olabilir, capture
    if (db) {
        db.collection('debugGetirWebhooks').add({
            time: admin.firestore.FieldValue.serverTimestamp(),
            note: 'CAUGHT BY /order/:remoteId — likely YemekSepeti, but logging in case Getir uses it',
            ip: req.ip || null,
            path: req.path,
            params: { remoteId },
            query: req.query || {},
            headers: {
                'content-type': req.headers['content-type'] || null,
                'user-agent': (req.headers['user-agent'] || '').substring(0, 100),
                'x-restaurant-secret-key': req.headers['x-restaurant-secret-key'] || null,
                'x-branch-id': req.headers['x-branch-id'] || null,
            },
            bodyKeys: Object.keys(req.body || {}),
            bodyJson: JSON.stringify(req.body || {}).substring(0, 8000),
        }).catch(err => console.error('[GetirDebug] /order/:remoteId capture failed:', err.message));
    }

    // remoteId = POS Vendor ID = Firestore branch document ID (e.g. QgNkbMyFVgDWGqbHG1ZS)
    // DH sends webhooks to /order/{remoteId} where remoteId maps directly to branchId
    const branchId = remoteId || req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId) {
        console.error('[YemekSepeti] ❌ branchId belirlenemedi — sipariş reddedildi (multi-tenant güvenlik)');
        return res.status(400).json({ error: 'branchId is required' });
    }

    // Şube doğrulama (HARD validation — geçersiz branchId engellenir)
    const branchCheck = await validateBranchId(branchId, 'yemeksepeti', db);
    if (!branchCheck.valid) {
        return res.status(403).json({ error: branchCheck.reason });
    }

    metrics.increment('orders_received_total', { platform: 'yemeksepeti' });
    metrics.increment('webhook_requests_total', { platform: 'yemeksepeti' });
    console.log('[YemekSepeti] ========== NEW ORDER ==========');
    console.log('[YemekSepeti] Remote ID:', remoteId, '→ branchId:', branchId);
    console.log('[YemekSepeti] Raw order keys:', Object.keys(order));
    console.log('[YemekSepeti] Raw order.token:', order.token);
    console.log('[YemekSepeti] Raw order.code:', order.code);
    console.log('[YemekSepeti] Raw order.products count:', order.products?.length || 0);
    console.log('[YemekSepeti] Raw order.customer:', order.customer ? `${order.customer.firstName} ${order.customer.lastName}` : 'NULL');
    console.log('[YemekSepeti] Raw order.price:', JSON.stringify(order.price));
    console.log('[YemekSepeti] Raw payload (first 2000 chars):', JSON.stringify(order).substring(0, 2000));

    try {
        // Use connector for transformation
        const connector = platformRegistry.getConnector('yemeksepeti');
        console.log('[YemekSepeti] Connector available:', !!connector);
        const branchConfig = platformRegistry.getBranchPlatformConfig(branchId, 'yemeksepeti') || {};
        const transformedOrder = connector ? connector.transformOrder(order, branchId, branchConfig) : order;
        transformedOrder.RemoteOrderId = `${remoteId}_${order.token}_${Date.now()}`;

        console.log('[YemekSepeti] Transformed - Items:', transformedOrder.Items?.length || 0);
        console.log('[YemekSepeti] Transformed - Customer:', transformedOrder.Customer?.FirstName || 'NULL');
        console.log('[YemekSepeti] Transformed - TotalAmount:', transformedOrder.TotalAmount);
        console.log('[YemekSepeti] Transformed - PaymentMethod:', transformedOrder.PaymentMethod);
        if (transformedOrder.Items?.length > 0) {
            transformedOrder.Items.forEach((item, idx) => {
                console.log(`[YemekSepeti]   ${idx + 1}. ${item.Name} x${item.Quantity} = ${item.TotalPrice} TL`);
            });
        }

        // Legacy queue (WPF polling)
        const orderId = order.token;

        // Lazy cleanup: 30dk'dan eski siparişleri temizle (en fazla 60sn'de bir)
        await lazyCleanupOrders(branchId);

        // Per-branch cap
        await orderStore.evictOldestInBranch(branchId);

        // Global cap
        await orderStore.evictOldestGlobal();

        await orderStore.set(orderId, { order: transformedOrder, status: 'NEW', createdAt: new Date() });
        console.log('[YemekSepeti] Added to legacy queue (key:', orderId, ')');

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
                metrics.increment('dispatch_assignments_total', { status: courier ? 'success' : 'queued' });
                if (courier) {
                    await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                    await notifyCourierNewOrder(courier, transformedOrder, 'YemekSepeti');
                } else if (dispatchQueue) {
                    // No courier available — enqueue for retry
                    await dispatchQueue.enqueue({
                        orderId: firebaseResult.orderId,
                        platformId: 'yemeksepeti',
                        branchId,
                        deliveryLocation
                    });
                }
            }

            // Socket.IO: yeni sipariş bildirimi
            io.to(`branch:${branchId}`).emit('order:new', {
                orderId: firebaseResult.orderId,
                platform: 'yemeksepeti',
                customerName: `${transformedOrder.Customer?.FirstName || ''} ${transformedOrder.Customer?.LastName || ''}`.trim(),
                totalAmount: transformedOrder.TotalAmount || 0,
                timestamp: new Date().toISOString()
            });
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
app.put('/remoteId/:remoteId/remoteOrder/:remoteOrderId/posOrderStatus', authenticatePlatformWebhook, async (req, res) => {
    const { remoteOrderId } = req.params;
    const statusUpdate = req.body;

    console.log('[YemekSepeti] Status Update:', remoteOrderId, statusUpdate.status);
    metrics.increment('webhook_requests_total', { platform: 'yemeksepeti' });

    const status = (statusUpdate.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected' || status === 'cancel') {
        metrics.increment('orders_cancelled_total', { platform: 'yemeksepeti' });
        const connector = platformRegistry.getConnector('yemeksepeti');
        const parts = remoteOrderId.split('_');
        const orderToken = parts.length >= 2 ? parts[1] : remoteOrderId;

        // Cancel in Firebase
        if (connector) {
            await connector.cancelOrder(orderToken, statusUpdate.reason || 'UNKNOWN');
        }

        // Socket.IO: sipariş iptal bildirimi
        const branchId = req.params.remoteId;
        io.to(`branch:${branchId}`).emit('order:cancelled', {
            orderId: orderToken,
            platform: 'yemeksepeti',
            reason: statusUpdate.reason || 'UNKNOWN',
            timestamp: new Date().toISOString()
        });

        // Legacy queue - artık status değiştirmiyoruz, WPF kendi yönetir
    }

    res.status(200).json({ success: true });
});

// ==================== GETIRYEMEK WEBHOOKS (LEGACY COMPATIBILITY) ====================

app.post('/webhook/newOrder', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    // Getir bazen { foodOrder: {...} } wrapper'ı içinde gönderir — unwrap et.
    const rawBody = req.body || {};
    const order = rawBody.foodOrder || rawBody;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'] || API_KEYS.GETIRYEMEK_DEFAULT_RESTAURANT_SECRET;

    // Body içinden olası restaurantId alanları
    const bodyRestaurantId =
        order?.restaurantId ||
        order?.restaurant?.id ||
        order?.restaurant ||
        rawBody?.restaurantId ||
        null;

    // ===== DETAILED DIAGNOSTIC LOGGING =====
    console.log('[GetirYemek] ┌─── INCOMING WEBHOOK ───');
    console.log(`[GetirYemek] │ time: ${new Date().toISOString()}`);
    console.log(`[GetirYemek] │ ip: ${req.ip}`);
    console.log(`[GetirYemek] │ x-restaurant-secret-key: ${restaurantSecretKey || '<MISSING>'}`);
    console.log(`[GetirYemek] │ x-branch-id (header): ${req.headers['x-branch-id'] || '<NONE>'}`);
    console.log(`[GetirYemek] │ branchId (query): ${req.query.branchId || '<NONE>'}`);
    console.log(`[GetirYemek] │ unwrapped: ${rawBody.foodOrder ? 'foodOrder' : 'direct'}`);
    console.log(`[GetirYemek] │ order.id: ${order?.id || '<NONE>'}`);
    console.log(`[GetirYemek] │ body.restaurantId: ${bodyRestaurantId || '<NONE>'}`);
    console.log(`[GetirYemek] │ body keys: ${Object.keys(rawBody).join(',')}`);
    console.log('[GetirYemek] └────');

    // Multi-source branchId resolve:
    // a) URL/header (en hızlı) → b) secret → c) body.restaurantId → d) env fallback → e) permissive
    const urlBranchId = req.headers['x-branch-id'] || req.query.branchId;
    let branchId = urlBranchId || null;
    let resolveSource = urlBranchId ? 'url' : null;

    const secretResolved = await resolveBranchByGetirSecret(restaurantSecretKey, db);
    console.log(`[GetirYemek] resolver(secret): secret=${restaurantSecretKey?.substring(0,16)}... -> ${secretResolved || 'NULL'}`);
    if (secretResolved) {
        if (branchId && branchId !== secretResolved) {
            console.warn(`[GetirYemek] ⚠ branchId mismatch — URL=${branchId} secret=${secretResolved} (secret authoritative)`);
        }
        branchId = secretResolved;
        resolveSource = 'secret';
    }

    if (!branchId && bodyRestaurantId) {
        const ridResolved = await resolveBranchByGetirRestaurantId(bodyRestaurantId, db);
        console.log(`[GetirYemek] resolver(restaurantId): ${bodyRestaurantId} -> ${ridResolved || 'NULL'}`);
        if (ridResolved) {
            branchId = ridResolved;
            resolveSource = 'restaurantId';
        }
    }

    if (!branchId && process.env.GETIR_DEFAULT_BRANCH_ID) {
        branchId = process.env.GETIR_DEFAULT_BRANCH_ID;
        resolveSource = 'env_fallback';
        console.warn(`[GetirYemek] ⚠ Using GETIR_DEFAULT_BRANCH_ID fallback: ${branchId}`);
    }

    // Capture for /debug/last-getir-webhooks
    captureGetirWebhook(req, secretResolved, urlBranchId, branchId);

    if (!branchId) {
        // Permissive mode: 200 dön ki Getir retry yapmasın, ama Firestore'a unresolved olarak yaz
        if (process.env.GETIR_WEBHOOK_PERMISSIVE === 'true') {
            console.error('[GetirYemek] ⚠ branchId çözülemedi — PERMISSIVE mode, unresolved kaydediliyor');
            try {
                await db.collection('getirYemekOrders_unresolved').add({
                    receivedAt: new Date(),
                    headers: {
                        'x-restaurant-secret-key': restaurantSecretKey || null,
                        'x-branch-id': req.headers['x-branch-id'] || null,
                        'user-agent': req.headers['user-agent'] || null,
                    },
                    query: req.query || {},
                    body: rawBody,
                    bodyRestaurantId: bodyRestaurantId || null,
                    _unresolved: true,
                });
            } catch (e) {
                console.error('[GetirYemek] unresolved write failed:', e.message);
            }
            return res.status(200).send('OK');
        }
        console.error('[GetirYemek] ❌ branchId belirlenemedi — sipariş reddedildi (multi-tenant güvenlik)');
        return res.status(400).json({ error: 'branchId could not be resolved (url/secret/restaurantId all failed)' });
    }
    console.log(`[GetirYemek] ✓ branchId resolved via ${resolveSource}: ${branchId}`);
    const branchCheckGY = await validateBranchId(branchId, 'getiryemek', db);
    if (!branchCheckGY.valid) return res.status(403).json({ error: branchCheckGY.reason });

    metrics.increment('orders_received_total', { platform: 'getiryemek' });
    metrics.increment('webhook_requests_total', { platform: 'getiryemek' });
    console.log('[GetirYemek] ========== NEW ORDER ==========');

    try {
        // Use connector for transformation
        const connector = platformRegistry.getConnector('getiryemek');
        const transformedOrder = connector ? connector.transformOrder(order, branchId) : order;

        // Legacy queue
        const webhookId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const webhook = {
            id: webhookId,
            type: 'newOrder',
            data: order,
            restaurantSecretKey,
            timestamp: new Date()
        };
        await webhookStore.add(webhook);

        // Firebase direct write
        const firebaseResult = await writeOrderToFirebaseUnified(transformedOrder, 'getiryemek', branchId);
        if (firebaseResult.success && smartDispatchService && branchId) {
            const deliveryLocation = {
                latitude: order.client?.deliveryAddress?.latitude || 0,
                longitude: order.client?.deliveryAddress?.longitude || 0
            };
            const courier = await smartDispatchService.assignBestCourier(branchId, deliveryLocation);
            metrics.increment('dispatch_assignments_total', { status: courier ? 'success' : 'queued' });
            if (courier) {
                await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                await notifyCourierNewOrder(courier, transformedOrder, 'GetirYemek');
            } else if (dispatchQueue) {
                await dispatchQueue.enqueue({
                    orderId: firebaseResult.orderId,
                    platformId: 'getiryemek',
                    branchId,
                    deliveryLocation
                });
            }
        }

        if (firebaseResult.success) {
            // Socket.IO: yeni sipariş bildirimi
            io.to(`branch:${branchId}`).emit('order:new', {
                orderId: firebaseResult.orderId,
                platform: 'getiryemek',
                customerName: `${transformedOrder.Customer?.FirstName || ''} ${transformedOrder.Customer?.LastName || ''}`.trim(),
                totalAmount: transformedOrder.TotalAmount || 0,
                timestamp: new Date().toISOString()
            });
        }

        console.log('[GetirYemek] ============================');
        res.status(200).send('OK');
    } catch (error) {
        console.error('[GetirYemek] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/webhook/cancelOrder', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const order = req.body;
    const restaurantSecretKey = req.headers['x-restaurant-secret-key'];

    metrics.increment('orders_cancelled_total', { platform: 'getiryemek' });
    metrics.increment('webhook_requests_total', { platform: 'getiryemek' });
    console.log('[GetirYemek] Cancel Order:', order.id);

    const cancelWebhook = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'cancelOrder',
        data: { foodOrder: order },
        restaurantSecretKey,
        timestamp: new Date()
    };
    await webhookStore.add(cancelWebhook);

    const connector = platformRegistry.getConnector('getiryemek');
    if (connector && order.id) {
        await connector.cancelOrder(order.id);
    }

    // Socket.IO: sipariş iptal bildirimi
    // Multi-tenant güvenlik: secret authoritative
    let branchId = req.headers['x-branch-id'] || req.query.branchId;
    const resolvedBranchIdCancel = await resolveBranchByGetirSecret(restaurantSecretKey, db);
    if (resolvedBranchIdCancel) {
        if (branchId && branchId !== resolvedBranchIdCancel) {
            console.warn(`[GetirYemek] ⚠ cancelOrder branchId mismatch — URL=${branchId} secret-resolved=${resolvedBranchIdCancel} (using secret)`);
        }
        branchId = resolvedBranchIdCancel;
    }
    if (!branchId) {
        console.error('[GetirYemek] ❌ branchId belirlenemedi — iptal yayını atlandı (multi-tenant güvenlik)');
    }
    if (branchId) {
        io.to(`branch:${branchId}`).emit('order:cancelled', {
            orderId: order.id,
            platform: 'getiryemek',
            reason: order.cancelReason || 'UNKNOWN',
            timestamp: new Date().toISOString()
        });
    }

    res.status(200).send('OK');
});

app.post('/webhook/courierArrival', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const notification = req.body;
    const arrivalWebhook = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'courierArrival',
        data: notification,
        restaurantSecretKey: req.headers['x-restaurant-secret-key'],
        timestamp: new Date()
    };
    await webhookStore.add(arrivalWebhook);
    res.status(200).send('OK');
});

app.post('/webhook/restaurantStatus', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const notification = req.body;
    const statusWebhook = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: 'restaurantStatus',
        data: notification,
        restaurantSecretKey: req.headers['x-restaurant-secret-key'],
        timestamp: new Date()
    };
    await webhookStore.add(statusWebhook);
    res.status(200).send('OK');
});

// ==================== TRENDYOLGO WEBHOOKS ====================

app.post('/webhook/trendyolgo/order', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId) {
        console.error('[TrendyolGo] ❌ branchId belirlenemedi — sipariş reddedildi (multi-tenant güvenlik)');
        return res.status(400).json({ error: 'branchId is required' });
    }
    const branchCheckTG = await validateBranchId(branchId, 'trendyolgo', db);
    if (!branchCheckTG.valid) return res.status(403).json({ error: branchCheckTG.reason });

    metrics.increment('orders_received_total', { platform: 'trendyolgo' });
    metrics.increment('webhook_requests_total', { platform: 'trendyolgo' });
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
            metrics.increment('dispatch_assignments_total', { status: courier ? 'success' : 'queued' });
            if (courier) {
                await connector?.assignCourier(firebaseResult.orderId, courier.id, courier.name);
                await notifyCourierNewOrder(courier, transformedOrder, 'TrendyolGo');
            } else if (dispatchQueue) {
                await dispatchQueue.enqueue({
                    orderId: firebaseResult.orderId,
                    platformId: 'trendyolgo',
                    branchId,
                    deliveryLocation
                });
            }
        }

        if (firebaseResult.success) {
            // Socket.IO: yeni sipariş bildirimi
            io.to(`branch:${branchId}`).emit('order:new', {
                orderId: firebaseResult.orderId,
                platform: 'trendyolgo',
                customerName: `${transformedOrder.Customer?.FirstName || ''} ${transformedOrder.Customer?.LastName || ''}`.trim(),
                totalAmount: transformedOrder.TotalAmount || 0,
                timestamp: new Date().toISOString()
            });
        }

        console.log('[TrendyolGo] ============================');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[TrendyolGo] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// TrendyolGo Cancel Webhook
app.post('/webhook/trendyolgo/cancel', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId;

    metrics.increment('orders_cancelled_total', { platform: 'trendyolgo' });
    metrics.increment('webhook_requests_total', { platform: 'trendyolgo' });

    try {
        const connector = platformRegistry.getConnector('trendyolgo');
        if (connector && order.id) {
            await connector.cancelOrder(order.id, order.cancelReason || 'UNKNOWN');
        }

        if (io && branchId) {
            io.to(`branch:${branchId}`).emit('order:cancelled', {
                orderId: order.id,
                platform: 'trendyolgo',
                reason: order.cancelReason || 'UNKNOWN',
                timestamp: new Date().toISOString()
            });
        }

        console.log(`[TrendyolGo] Order cancelled: ${order.id} (branch: ${branchId})`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[TrendyolGo] Cancel webhook error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== FUUDY WEBHOOKS ====================

app.post('/webhook/fuudy/order', webhookLimiter, authenticatePlatformWebhook, async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId) {
        console.error('[Fuudy] branchId belirlenemedi — siparis reddedildi (multi-tenant guvenlik)');
        return res.status(400).json({ error: 'branchId is required' });
    }
    const branchCheckF = await validateBranchId(branchId, 'fuudy', db);
    if (!branchCheckF.valid) return res.status(403).json({ error: branchCheckF.reason });

    console.log('[Fuudy] ========== NEW ORDER ==========');

    try {
        await processPlatformOrderWebhook('fuudy', order, branchId, {
            deliveryLocation: {
                latitude: order.address?.latitude || 0,
                longitude: order.address?.longitude || 0
            },
            socketCustomerName: order.customer?.name || '',
            socketTotalAmount: order.total || 0,
            platformDisplayName: 'Fuudy'
        });
        console.log('[Fuudy] ============================');
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[Fuudy] Webhook processing error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== MIGROS YEMEK WEBHOOKS ====================

// Basic Auth middleware — Migros webhook'larında zorunlu
function authenticateMigrosWebhook(req, res, next) {
    const expectedUser = process.env.MIGROS_WEBHOOK_USER;
    const expectedPass = process.env.MIGROS_WEBHOOK_PASS;
    if (!expectedUser || !expectedPass) {
        console.error('[MigrosYemek] MIGROS_WEBHOOK_USER/PASS env vars not configured');
        return res.status(503).json({ error: 'Webhook authentication not configured' });
    }
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
        console.error('[MigrosYemek] Missing Basic Auth header');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
        const [username, password] = credentials.split(':');
        if (!timingSafeCompare(username || '', expectedUser) || !timingSafeCompare(password || '', expectedPass)) {
            console.error('[MigrosYemek] Invalid Basic Auth credentials');
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        next();
    } catch (e) {
        console.error('[MigrosYemek] Auth parse error:', e.message);
        return res.status(401).json({ error: 'Invalid auth format' });
    }
}

// Sipariş Oluştu — Migros yeni sipariş push eder
app.post('/webhook/migrosyemek/order-created', webhookLimiter, authenticateMigrosWebhook, async (req, res) => {
    const order = req.body;
    const storeId = order.store?.id;

    // branchId: header, query veya Migros storeId → branchId Firestore eşleme ile belirle
    let branchId = req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId && storeId) {
        // Firestore'da migrosYemek_storeId alanından branchId bul
        try {
            const branchesSnap = await db.collection('branches')
                .where('migrosYemek_storeId', '==', String(storeId))
                .limit(1)
                .get();
            if (!branchesSnap.empty) {
                branchId = branchesSnap.docs[0].id;
                console.log(`[MigrosYemek] storeId ${storeId} → branchId ${branchId} (Firestore lookup)`);
            }
        } catch (lookupErr) {
            console.error(`[MigrosYemek] branchId lookup hatasi: ${lookupErr.message}`);
        }
    }
    if (!branchId) {
        console.error(`[MigrosYemek] branchId belirlenemedi — storeId=${storeId}, siparis reddedildi`);
        return res.status(400).json({ error: 'branchId is required' });
    }
    const branchCheckMY = await validateBranchId(branchId, 'migrosyemek', db);
    if (!branchCheckMY.valid) return res.status(403).json({ error: branchCheckMY.reason });

    console.log(`[MigrosYemek] ========== NEW ORDER: ${order.id} ==========`);

    try {
        // Migros'ta RESTAURANT delivery ise dispatch aktif — aksi halde Migros'un kendi kuryesi (dispatch skip)
        const shouldDispatch = order.deliveryProvider === 'RESTAURANT';
        await processPlatformOrderWebhook('migrosyemek', order, branchId, {
            deliveryLocation: {
                latitude: order.customer?.deliveryAddress?.geoLocation?.latitude || 0,
                longitude: order.customer?.deliveryAddress?.geoLocation?.longitude || 0
            },
            shouldDispatch,
            socketCustomerName: order.customer?.fullName || '',
            socketTotalAmount: (order.prices?.discounted?.amountAsPenny || order.prices?.total?.amountAsPenny || 0) / 100,
            platformDisplayName: 'MigrosYemek'
        });
        console.log(`[MigrosYemek] ============================`);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[MigrosYemek] Order webhook error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Sipariş İptal Edildi — Migros iptal/red bilgisi push eder
app.post('/webhook/migrosyemek/order-cancelled', webhookLimiter, authenticateMigrosWebhook, async (req, res) => {
    const { OrderId, StoreId, UserId } = req.body;
    let branchId = req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId && StoreId) {
        try {
            const snap = await db.collection('branches').where('migrosYemek_storeId', '==', String(StoreId)).limit(1).get();
            if (!snap.empty) branchId = snap.docs[0].id;
        } catch (e) { console.error(`[MigrosYemek] Cancel branchId lookup: ${e.message}`); }
    }

    metrics.increment('webhook_requests_total', { platform: 'migrosyemek', type: 'cancel' });
    console.log(`[MigrosYemek] ORDER CANCELLED: ${OrderId}`);

    try {
        const connector = platformRegistry.getConnector('migrosyemek');
        if (connector) {
            await connector.updateOrderStatus(String(OrderId), 'CANCELLED', { cancelledBy: 'platform' });
        }

        if (branchId) {
            io.to(`branch:${branchId}`).emit('order:cancelled', {
                orderId: String(OrderId),
                platform: 'migrosyemek',
                timestamp: new Date().toISOString()
            });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[MigrosYemek] Cancel webhook error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Kurye Durumu Değişti — Migros kurye durum değişikliği push eder
app.post('/webhook/migrosyemek/delivery-status', webhookLimiter, authenticateMigrosWebhook, async (req, res) => {
    const { orderId, storeId, status, deliveryStatus, isCancelled, deliveryProvider, courierName } = req.body;
    let branchId = req.headers['x-branch-id'] || req.query.branchId;
    if (!branchId && storeId) {
        try {
            const snap = await db.collection('branches').where('migrosYemek_storeId', '==', String(storeId)).limit(1).get();
            if (!snap.empty) branchId = snap.docs[0].id;
        } catch (e) { console.error(`[MigrosYemek] DeliveryStatus branchId lookup: ${e.message}`); }
    }

    metrics.increment('webhook_requests_total', { platform: 'migrosyemek', type: 'delivery_status' });
    console.log(`[MigrosYemek] DELIVERY STATUS: order=${orderId} status=${deliveryStatus} courier=${courierName}`);

    try {
        const connector = platformRegistry.getConnector('migrosyemek');
        if (connector) {
            const updates = {
                deliveryStatus: deliveryStatus || '',
                courierName: courierName || '',
                deliveryProvider: deliveryProvider || '',
                isCancelled: isCancelled || false
            };

            // DELIVERED durumunda siparişi teslim edildi olarak işaretle
            if (deliveryStatus === 'DELIVERED') {
                await connector.updateOrderStatus(String(orderId), 'DELIVERED', updates);
            } else {
                await connector.updateOrderStatus(String(orderId), status || 'IN_PROGRESS', updates);
            }
        }

        if (branchId) {
            io.to(`branch:${branchId}`).emit('order:delivery-status', {
                orderId: String(orderId),
                platform: 'migrosyemek',
                deliveryStatus,
                courierName,
                isCancelled,
                timestamp: new Date().toISOString()
            });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('[MigrosYemek] Delivery status webhook error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== LEGACY POLLING ENDPOINTS ====================

app.get('/api/yemeksepeti/pending-orders', pollingLimiter, async (req, res) => {
    metrics.increment('polling_requests_total', { platform: 'yemeksepeti' });
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const branchId = req.query.branchId;
    if (!branchId) {
        return res.status(400).json({ error: 'branchId query parameter is required' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // O(k) lookup via OrderStore branch index
    const branchOrders = await orderStore.getBranchOrders(branchId);
    const result = [];
    for (const { orderId, orderData } of branchOrders) {
        if (new Date(orderData.createdAt) >= today) {
            const createdAt = orderData.createdAt instanceof Date
                ? orderData.createdAt.toISOString()
                : new Date(orderData.createdAt).toISOString();
            result.push({ ...orderData.order, _railwayKey: orderId, CreatedAt: createdAt });
        }
    }

    if (result.length > 0) {
        console.log(`[YemekSepeti POLL] ${result.length} orders returned to ${req.ip} (branchId: ${branchId})`);
    }

    res.json({ success: true, count: result.length, orders: result });
});

app.delete('/api/yemeksepeti/orders/:orderId', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const orderId = req.params.orderId;
    console.log(`[YemekSepeti DELETE] Order delete request: ${orderId} from ${req.ip}`);

    // Try direct key match first
    const found = await orderStore.has(orderId);
    if (found) {
        await orderStore.delete(orderId);
        console.log(`[YemekSepeti DELETE] Deleted by key: ${orderId}`);
        return res.json({ success: true });
    }

    // Fallback: scan by OrderId or OrderToken field
    const byOrderId = await orderStore.findByField('OrderId', orderId);
    if (byOrderId) {
        await orderStore.delete(byOrderId.orderId);
        console.log(`[YemekSepeti DELETE] Deleted by OrderId match: key=${byOrderId.orderId}, orderId=${orderId}`);
        return res.json({ success: true });
    }

    const byToken = await orderStore.findByField('OrderToken', orderId);
    if (byToken) {
        await orderStore.delete(byToken.orderId);
        console.log(`[YemekSepeti DELETE] Deleted by Token match: key=${byToken.orderId}, orderId=${orderId}`);
        return res.json({ success: true });
    }

    console.log(`[YemekSepeti DELETE] Order not found: ${orderId}`);
    res.status(404).json({ success: false, message: 'Order not found' });
});

app.get('/api/yemeksepeti/cancellations', pollingLimiter, async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const pendingCancellations = await cancellationStore.getAll();
    res.json({ success: true, count: pendingCancellations.length, cancellations: pendingCancellations });
});

app.delete('/api/yemeksepeti/cancellations/:cancellationId', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const deleted = await cancellationStore.delete(req.params.cancellationId);
    if (deleted) {
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.get('/poll/webhooks', pollingLimiter, async (req, res) => {
    metrics.increment('polling_requests_total', { platform: 'getiryemek' });
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.GETIRYEMEK_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const restaurantSecretKey = req.query.restaurantSecretKey;
    const filteredWebhooks = restaurantSecretKey
        ? await webhookStore.getByRestaurantKey(restaurantSecretKey)
        : await webhookStore.getAll();

    res.json({ success: true, webhooks: filteredWebhooks });
});

app.delete('/api/getiryemek/webhooks/:webhookId', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.GETIRYEMEK_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const removed = await webhookStore.deleteById(req.params.webhookId);
    if (removed) {
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

// ==================== METRICS ====================

// Prometheus exposition handler (auth'lu — iç yapı bilgisi sızıntısını önler)
async function metricsHandler(req, res) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const output = await metrics.getMetrics();
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(output);
    } catch (error) {
        console.error('[Metrics] Error generating metrics:', error.message);
        res.status(500).send('# ERROR generating metrics\n');
    }
}

// Eski path (backward compat)
app.get('/api/metrics', metricsHandler);
// Prometheus konvansiyonu (Faz 4.4 — 2026-04-18)
app.get('/metrics', metricsHandler);

// ==================== HEALTH & INFO ====================

app.get('/health', async (req, res) => {
    const redisStatus = getRedisStatus();
    const redisConnected = redisStatus.connected === true;

    // Multi-instance readiness: all critical state must be in Redis
    const instanceLocalState = [];
    if (!redisConnected) {
        instanceLocalState.push('orderStore (memory fallback)');
        instanceLocalState.push('cancellationStore (memory fallback)');
        instanceLocalState.push('webhookStore (memory fallback)');
        instanceLocalState.push('courierState (memory fallback)');
        instanceLocalState.push('dispatchWeightCache (memory fallback)');
    }
    // These are always instance-local but acceptable
    const acceptableLocal = [
        'requestLog (debug, per-instance)',
        'lastLazyCleanup (idempotent)',
        'rateLimiters (per-instance acceptable)',
        'consecutiveFailures (per-instance alerts)'
    ];

    // Circuit breaker statuses
    const circuitBreakers = smartDispatchService
        ? smartDispatchService.getCircuitBreakerStatuses().map(cb => ({
            name: cb.name,
            state: cb.state,
            failureCount: cb.failureCount,
            tripCount: cb.tripCount
        }))
        : [];

    // Enrich redis status with failover info
    const redisInfo = { ...redisStatus };
    const failoverInfo = getRedisFailoverInfo();
    if (failoverInfo.inFailover) {
        redisInfo.failover = {
            active: true,
            startedAt: failoverInfo.failoverStartedAt ? failoverInfo.failoverStartedAt.toISOString() : null,
            durationSeconds: Math.round(failoverInfo.failoverDurationMs / 1000),
            reconnectAttempts: failoverInfo.reconnectAttempts,
        };
    }

    res.json({
        status: 'ok',
        service: 'YemiGO Platform Hub Server',
        version: '4.0.0',
        firebase: firebaseInitialized ? 'connected' : 'disabled',
        platforms: platformRegistry.getAllPlatforms().length,
        connectors: platformRegistry.connectors.size,
        ordersTotal: await orderStore.size(),
        indexedBranches: await orderStore.indexedBranchCount(),
        redis: redisInfo,
        circuitBreakers,
        multiInstance: {
            ready: redisConnected,
            warnings: redisConnected ? acceptableLocal : instanceLocalState.concat(acceptableLocal)
        }
    });
});

// Branch-specific health endpoint (scaling observability)
app.get('/api/health/branch/:branchId', async (req, res) => {
    const { branchId } = req.params;

    // 1. Platform durumları
    const platforms = {};
    for (const platformId of ['yemeksepeti', 'getiryemek', 'trendyolgo']) {
        const enabled = platformRegistry.isPlatformEnabledForBranch(branchId, platformId);
        platforms[platformId] = { enabled };
    }

    // 2. Aktif sipariş sayıları (connector'lardan)
    for (const [platformId, connector] of platformRegistry.connectors.entries()) {
        if (platforms[platformId]?.enabled && connector.getActiveOrders) {
            try {
                const activeOrders = await connector.getActiveOrders(branchId);
                platforms[platformId].activeOrderCount = activeOrders.length;
            } catch {
                platforms[platformId].activeOrderCount = -1;
            }
        }
    }

    // 3. Socket.IO bağlantı durumu
    const branchCouriers = await courierState.getLocationsByBranch(branchId);

    // 4. Kuyruk boyutları
    const branchOrderCount = await orderStore.getBranchOrderCount(branchId);
    const branchCancellations = await cancellationStore.getByBranch(branchId);

    res.json({
        branchId,
        timestamp: new Date().toISOString(),
        status: 'ok',
        platforms,
        realtime: {
            connectedCouriers: branchCouriers.length,
            socketServerConnected: true
        },
        queues: {
            orders: branchOrderCount,
            cancellations: branchCancellations.length
        }
    });
});

app.get('/', async (req, res) => {
    // Hassas bilgileri sızdırmayan minimal root endpoint
    res.json({
        service: 'YemiGO Platform Hub',
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

app.get('/socket/status', async (req, res) => {
    const allConnected = await courierState.getAllConnected();
    const couriers = [];
    for (const { courierId, socketId } of allConnected) {
        const courierSocket = io.sockets.sockets.get(socketId);
        const location = await courierState.getLocation(courierId);
        if (courierSocket) {
            couriers.push({
                courierId,
                name: courierSocket.courierName,
                branchId: courierSocket.branchId,
                location: location || null
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

// ==================== REQUEST LOG ENDPOINT ====================

app.get('/debug/last-getir-webhooks', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY && apiKey !== API_KEYS.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Firestore üzerinden — multi-instance'tan agnostik
    let firestoreWebhooks = [];
    if (db) {
        try {
            const snap = await db.collection('debugGetirWebhooks')
                .orderBy('time', 'desc')
                .limit(20)
                .get();
            firestoreWebhooks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (err) {
            console.error('[GetirDebug] Firestore read failed:', err.message);
        }
    }

    res.json({
        firestoreTotal: firestoreWebhooks.length,
        instanceMemoryTotal: lastGetirWebhooks.length,
        serverStartTime: serverStartTime,
        currentTime: new Date().toISOString(),
        webhooks: firestoreWebhooks, // Firestore is authoritative (cross-instance)
        instanceMemoryWebhooks: lastGetirWebhooks.slice().reverse(),
    });
});

app.get('/debug/requests', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY && apiKey !== API_KEYS.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const filter = req.query.filter; // optional: 'order', 'webhook', 'all'
    let logs = [...requestLog];

    if (filter && filter !== 'all') {
        logs = logs.filter(l => l.path.toLowerCase().includes(filter.toLowerCase()));
    }

    const queueSize = await orderStore.size();
    res.json({
        total: logs.length,
        serverStartTime: serverStartTime,
        currentTime: new Date().toISOString(),
        queueSize,
        logs: logs.slice(-50) // last 50 entries
    });
});

const serverStartTime = new Date().toISOString();

// ==================== CLEANUP ====================

async function cleanupOldOrders() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    let deleted = 0;

    // Orders via OrderStore
    const ordersCleaned = await orderStore.deleteOlderThan(yesterday);
    deleted += ordersCleaned;

    const cancellationsCleaned = await cancellationStore.deleteOlderThan(yesterday);
    deleted += cancellationsCleaned;

    const webhooksCleaned = await webhookStore.deleteOlderThan(yesterday);
    deleted += webhooksCleaned;

    // Stale courier locations (30 min no update = stale)
    const staleCleaned = await courierState.deleteStaleLocations(30 * 60 * 1000);
    deleted += staleCleaned;

    if (deleted > 0) {
        console.log(`[Cleanup] Deleted ${deleted} old items`);
    }

    const remainingOrders = await orderStore.size();
    const remainingCancellations = await cancellationStore.size();
    const remainingWebhooks = await webhookStore.size();
    if (remainingOrders > 0 || remainingCancellations > 0) {
        console.log(`[Cleanup] Remaining: orders=${remainingOrders}, cancellations=${remainingCancellations}, getirWebhooks=${remainingWebhooks}`);
    }
}

setInterval(cleanupOldOrders, 5 * 60 * 1000); // 5 dakikada bir
setTimeout(cleanupOldOrders, 30000);

// ==================== COURIER LOCATION SYNC (Redis → Firestore) ====================

async function syncCourierLocationsToFirestore() {
    if (!db) return;

    try {
        const allLocations = await courierState.getAllLocations();
        if (!allLocations || allLocations.length === 0) return;

        const batch = db.batch();
        let count = 0;

        for (const loc of allLocations) {
            if (!loc.courierId || !loc.latitude || !loc.longitude) continue;

            const courierRef = db.collection('couriers').doc(loc.courierId);
            // set(merge) kullan — doküman yoksa oluşturur, varsa sadece bu alanları günceller
            // batch.update() tek NOT_FOUND'da tüm batch'i fail eder, set(merge) güvenli
            batch.set(courierRef, {
                currentLatitude: loc.latitude,
                currentLongitude: loc.longitude,
                lastLocationUpdate: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            count++;
            if (count >= 500) break; // Firestore batch limit
        }

        if (count > 0) {
            await batch.commit();
            console.log(`[LocationSync] Synced ${count} courier locations to Firestore`);
        }
    } catch (err) {
        console.error('[LocationSync] Firestore sync error:', err.message);
    }
}

setInterval(syncCourierLocationsToFirestore, 10000); // 10 saniyede bir
setTimeout(syncCourierLocationsToFirestore, 15000); // İlk sync 15s sonra

// ==================== SERVER START ====================

const PORT = process.env.PORT || 3000;

async function startServer() {
    if (!WEBHOOK_SECRET) {
        console.warn('WARNING: WEBHOOK_SECRET not set — internal API authentication disabled. Platform webhooks still accepted.');
    }

    // Initialize Platform Hub
    await initializePlatformHub();

    // Initialize Redis client (graceful fallback to in-memory if REDIS_URL not set)
    getRedisClient();
    const redisStatus = getRedisStatus();
    console.log(`[Startup] Redis: ${redisStatus.mode} (connected: ${redisStatus.connected})`);

    server.listen(PORT, () => {
        console.log('');
        console.log('================================================================================');
        console.log('  YEMIGO PLATFORM HUB SERVER v4.0.0');
        console.log('================================================================================');
        console.log(`  Port: ${PORT}`);
        console.log(`  Firebase: ${firebaseInitialized ? '✅ CONNECTED' : '⚠️ DISABLED'}`);
        console.log(`  Redis: ${redisStatus.mode === 'redis' ? '✅ CONNECTED' : '⚡ IN-MEMORY FALLBACK'}`);
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
