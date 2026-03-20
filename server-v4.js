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
const GoogleMapsDistanceService = require('./services/google-maps-distance');
const DispatchMetrics = require('./services/dispatch/dispatch-metrics');
const DispatchQueue = require('./services/dispatch/dispatch-queue');
const DispatchAlerts = require('./services/dispatch/dispatch-alerts');

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
let dispatchMetrics = null;
let dispatchAlerts = null;
let dispatchQueue = null;

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

    // Initialize Dispatch Metrics & Alerts
    dispatchMetrics = new DispatchMetrics(db);
    dispatchAlerts = new DispatchAlerts(db);

    // Initialize Smart Dispatch
    smartDispatchService = new SmartDispatchService(db, platformRegistry);
    smartDispatchService.setMetrics(dispatchMetrics);
    smartDispatchService.setAlerts(dispatchAlerts);

    // Initialize Dispatch Queue (retry for failed assignments)
    dispatchQueue = new DispatchQueue(db, smartDispatchService, platformRegistry, dispatchMetrics);
    dispatchQueue.start();

    console.log('[PlatformHub] Initialized with connectors:', Array.from(platformRegistry.connectors.keys()));
}

// ==================== SMART DISPATCH SERVICE ====================
// 5-factor weighted scoring matching WPF CourierScoreCalculator
// Weights: distanceToBranch=0.25, availability=0.25, workload=0.20, deliveryProximity=0.15, performance=0.15
class SmartDispatchService {
    constructor(db, registry) {
        this.db = db;
        this.registry = registry;
        this.googleMaps = new GoogleMapsDistanceService();

        // [FIX-2] Assignment tracking: counter-based, supports multiple assignments per courier
        // Key: courierId, Value: number (pending assignment count within TTL window)
        this.pendingAssignments = new Map();

        // [FIX-3] Mutex: serializes assignBestCourier calls to prevent race conditions
        this._assignmentQueue = Promise.resolve();

        // Default scoring weights (matching WPF DispatchWeights defaults)
        this.defaultWeights = {
            distanceToBranch: 0.25,
            availability: 0.25,
            workload: 0.20,
            deliveryProximity: 0.15,
            performance: 0.15
        };
        this.weights = { ...this.defaultWeights };

        // Dynamic weights cache: branchId → { weights, expiresAt }
        this._weightCache = new Map();
        this._WEIGHT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

    /**
     * Get dispatch weights for a branch — reads from Firestore with 5min TTL cache
     * Falls back to defaults if not found or invalid
     */
    async getWeightsForBranch(branchId) {
        if (!this.db || !branchId) return this.defaultWeights;

        // Check cache
        const cached = this._weightCache.get(branchId);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.weights;
        }

        try {
            const doc = await this.db.doc(`branches/${branchId}/settings/dispatchWeights`).get();

            if (doc.exists) {
                const data = doc.data();
                const weights = this._validateWeights(data);
                if (weights) {
                    this._weightCache.set(branchId, {
                        weights,
                        expiresAt: Date.now() + this._WEIGHT_CACHE_TTL_MS
                    });
                    return weights;
                }
            }
        } catch (error) {
            console.warn('[SmartDispatch] Failed to load branch weights, using defaults:', error.message);
        }

        // Cache defaults too to avoid repeated reads
        this._weightCache.set(branchId, {
            weights: this.defaultWeights,
            expiresAt: Date.now() + this._WEIGHT_CACHE_TTL_MS
        });
        return this.defaultWeights;
    }

    /**
     * Validate weights object — must have all 5 keys, values must be numbers summing to ~1.0
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

        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1.0) > 0.05) {
            console.warn(`[SmartDispatch] Weights sum ${sum.toFixed(2)} != 1.0, using defaults`);
            return null;
        }

        return weights;
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
                        fcmToken: data.fcmToken || null
                    };
                })
                .filter(c => c.isApproved); // Only approved couriers
        } catch (error) {
            console.error('[SmartDispatch] Get couriers error:', error.message);
            return [];
        }
    }

    async getActiveOrderCount(courierId) {
        if (!this.db) return this._getPendingCount(courierId);

        try {
            const platforms = ['yemekSepetiOrders', 'getirYemekOrders', 'trendyolGoOrders'];
            let totalActive = 0;

            // [FIX-1] Include 'NEW' and 'PREPARING' statuses — orders assigned during
            // webhook flow keep Status:'NEW', accept flow keeps Status:'ACCEPTED'
            for (const platform of platforms) {
                const ordersSnapshot = await this.db.collectionGroup(platform)
                    .where('assignedCourierId', '==', courierId)
                    .where('Status', 'in', ['NEW', 'PREPARING', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'ON_THE_WAY'])
                    .get();
                totalActive += ordersSnapshot.size;
            }

            // [FIX-2] Add ALL pending assignments not yet reflected in Firestore
            totalActive += this._getPendingCount(courierId);

            return totalActive;
        } catch (error) {
            // On error, still return pending count as best-effort
            return this._getPendingCount(courierId);
        }
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
     */
    _calcWorkloadScore(activeOrderCount) {
        if (activeOrderCount === 0) return 0;
        return Math.min(activeOrderCount / this.MAX_ACTIVE_ORDERS, 1.0) * 100;
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
    calculateCourierScore(courier, deliveryLocation, branchLocation, deliveryDistanceInfo, branchDistanceInfo, weights) {
        const w = weights || this.defaultWeights;
        const distanceToBranchScore = this._calcDistanceToBranchScore(courier, branchLocation, branchDistanceInfo);
        const availabilityScore = this._calcAvailabilityScore(courier, branchLocation, branchDistanceInfo);
        const workloadScore = this._calcWorkloadScore(courier.activeOrderCount);
        const deliveryProximityScore = this._calcDeliveryProximityScore(courier, deliveryLocation, deliveryDistanceInfo);
        const performanceScore = this._calcPerformanceScore(courier);

        const totalScore =
            (distanceToBranchScore * w.distanceToBranch) +
            (availabilityScore * w.availability) +
            (workloadScore * w.workload) +
            (deliveryProximityScore * w.deliveryProximity) +
            ((100 - performanceScore) * w.performance); // Performance inverted

        return {
            totalScore,
            details: {
                distanceToBranch: distanceToBranchScore,
                availability: availabilityScore,
                workload: workloadScore,
                deliveryProximity: deliveryProximityScore,
                performance: performanceScore
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
     */
    _getPendingCount(courierId) {
        return this.pendingAssignments.get(courierId) || 0;
    }

    /**
     * Track a new assignment — increments counter, auto-decrements after TTL
     */
    _trackAssignment(courierId) {
        const current = this.pendingAssignments.get(courierId) || 0;
        this.pendingAssignments.set(courierId, current + 1);

        // Auto-decrement after TTL (Firestore should have caught up by then)
        setTimeout(() => {
            const count = this.pendingAssignments.get(courierId) || 0;
            if (count <= 1) {
                this.pendingAssignments.delete(courierId);
            } else {
                this.pendingAssignments.set(courierId, count - 1);
            }
        }, this.ASSIGNMENT_TRACKING_TTL_MS);
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
     */
    assignBestCourier(branchId, deliveryLocation) {
        return this._enqueue(() => this._assignBestCourierInternal(branchId, deliveryLocation));
    }

    async _assignBestCourierInternal(branchId, deliveryLocation) {
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

            const scoredCouriers = await Promise.all(
                couriers.map(async (courier) => {
                    const activeOrders = await this.getActiveOrderCount(courier.id);
                    courier.activeOrderCount = activeOrders;

                    const deliveryDistInfo = deliveryDistances ? deliveryDistances.get(courier.id) : null;
                    const branchDistInfo = branchDistances ? branchDistances.get(courier.id) : null;

                    const { totalScore, details } = this.calculateCourierScore(
                        courier, deliveryLocation, branchLocation, deliveryDistInfo, branchDistInfo, weights
                    );

                    return { courier, score: totalScore, details, source: deliveryDistInfo?.source || 'geolib' };
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
                `R:${bestMatch.details.performance.toFixed(0)}, source: ${bestMatch.source}, ${scoreTimeMs}ms)`);

            if (scoredCouriers.length > 1) {
                const runner = scoredCouriers[1];
                console.log(`[SmartDispatch] Runner-up: ${runner.courier.name} (score: ${runner.score.toFixed(1)})`);
            }

            // [FIX-2] Track assignment with counter (not single entry)
            this._trackAssignment(bestMatch.courier.id);

            // Record metric
            if (this.dispatchMetrics) {
                await this.dispatchMetrics.recordAssignment(branchId, bestMatch.courier.id, scoreTimeMs, true, {
                    score: bestMatch.score
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
}, createOrdersApi(platformRegistry, smartDispatchService, {
    sendPushNotification,
    notifyCourierNewOrder,
    db,
    dispatchMetrics,
    dispatchQueue
}));

app.use('/api/v2/platforms', createPlatformsApi(platformRegistry, db));

// ==================== YEMEKSEPETI WEBHOOKS (LEGACY COMPATIBILITY) ====================

app.post('/order/:remoteId', authenticateWebhook, async (req, res) => {
    const { remoteId } = req.params;
    const order = req.body;
    // remoteId = POS Vendor ID = Firestore branch document ID (e.g. QgNkbMyFVgDWGqbHG1ZS)
    // DH sends webhooks to /order/{remoteId} where remoteId maps directly to branchId
    const branchId = remoteId || req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;

    // Şube doğrulama (soft validation — sadece loglama, siparişi engellemez)
    try {
        const branchRef = db.collection('branches').doc(branchId);
        const branchSnap = await branchRef.get();
        if (!branchSnap.exists) {
            console.error(`[YemekSepeti] ALERT: Branch ${branchId} does NOT exist in Firestore!`);
        } else {
            const branchData = branchSnap.data();
            if (branchData.yemekSepeti_isEnabled === false) {
                console.warn(`[YemekSepeti] WARNING: YemekSepeti DISABLED for branch ${branchId}`);
            }
        }
    } catch (err) {
        console.error(`[YemekSepeti] Branch validation error:`, err.message);
    }

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
        const transformedOrder = connector ? connector.transformOrder(order, branchId) : order;
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
        orders.set(orderId, { order: transformedOrder, status: 'NEW', createdAt: new Date() });
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

    // Socket.IO: sipariş iptal bildirimi
    const branchId = req.headers['x-branch-id'] || req.query.branchId || process.env.DEFAULT_BRANCH_ID;
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

// ==================== LEGACY POLLING ENDPOINTS ====================

app.get('/api/yemeksepeti/pending-orders', (req, res) => {
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

    let newOrders = Array.from(orders.entries())
        .filter(([key, item]) => new Date(item.createdAt) >= today)
        .filter(([key, item]) => item.order.branchId === branchId);

    const result = newOrders.map(([key, item]) => ({ ...item.order, _railwayKey: key, CreatedAt: item.createdAt.toISOString() }));

    if (result.length > 0) {
        console.log(`[YemekSepeti POLL] ${result.length} orders returned to ${req.ip} (branchId: ${branchId})`);
    }

    res.json({ success: true, count: result.length, orders: result });
});

app.delete('/api/yemeksepeti/orders/:orderId', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const orderId = req.params.orderId;
    console.log(`[YemekSepeti DELETE] Order delete request: ${orderId} from ${req.ip}`);

    if (orders.has(orderId)) {
        console.log(`[YemekSepeti DELETE] Deleted by key: ${orderId}`);
        orders.delete(orderId);
        return res.json({ success: true });
    }

    for (const [key, item] of orders.entries()) {
        if (item.order.OrderId === orderId || item.order.OrderToken === orderId) {
            console.log(`[YemekSepeti DELETE] Deleted by OrderId/Token match: key=${key}, orderId=${orderId}`);
            orders.delete(key);
            return res.json({ success: true });
        }
    }

    console.log(`[YemekSepeti DELETE] Order not found: ${orderId}`);
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
    const branchCouriers = [...courierLocations.entries()]
        .filter(([_, loc]) => loc.branchId === branchId);

    // 4. Kuyruk boyutları (in-memory)
    const branchOrders = [...orders.values()].filter(o => o.branchId === branchId);
    const branchCancellations = [...cancellations.values()].filter(c => c.branchId === branchId);

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
            orders: branchOrders.length,
            cancellations: branchCancellations.length
        }
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

// ==================== REQUEST LOG ENDPOINT ====================

app.get('/debug/requests', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEYS.YEMEKSEPETI_POLLING_KEY && apiKey !== API_KEYS.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const filter = req.query.filter; // optional: 'order', 'webhook', 'all'
    let logs = [...requestLog];

    if (filter && filter !== 'all') {
        logs = logs.filter(l => l.path.toLowerCase().includes(filter.toLowerCase()));
    }

    res.json({
        total: logs.length,
        serverStartTime: serverStartTime,
        currentTime: new Date().toISOString(),
        queueSize: orders.size,
        logs: logs.slice(-50) // last 50 entries
    });
});

const serverStartTime = new Date().toISOString();

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
