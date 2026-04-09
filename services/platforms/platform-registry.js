// ==================================================================================
// PLATFORM REGISTRY - Firebase'den dinamik platform konfigürasyonlarını yönetir
// ==================================================================================

// Flat branch field şemasını (getirYemek_restaurantSecretKey ...) nested
// platformSettings yapısına çevirir. WPF/PLATFORM_HARDENING 3.1 ile gelen
// flat şemayı Railway connector'larının beklediği nested şemayla uyumlu kılar.
// Eski nested platformSettings varsa öncelikli — tam geriye uyumlu.
const FLAT_PLATFORM_PREFIXES = {
    getiryemek: 'getirYemek_',
    yemeksepeti: 'yemekSepeti_',
    trendyolgo: 'trendyolGo_',
    fuudy: 'fuudy_',
    migrosyemek: 'migrosYemek_',
};

function flatBranchToPlatformSettings(branchData) {
    const out = {};
    for (const [platformId, prefix] of Object.entries(FLAT_PLATFORM_PREFIXES)) {
        const cfg = {};
        for (const [k, v] of Object.entries(branchData)) {
            if (k.startsWith(prefix)) {
                const subKey = k.slice(prefix.length);
                cfg[subKey.charAt(0).toLowerCase() + subKey.slice(1)] = v;
            }
        }
        if (Object.keys(cfg).length > 0) {
            if (cfg.isEnabled !== undefined && cfg.enabled === undefined) {
                cfg.enabled = cfg.isEnabled === true;
            }
            out[platformId] = cfg;
        }
    }
    return out;
}

function resolvePlatformSettings(branchData) {
    if (branchData.platformSettings && Object.keys(branchData.platformSettings).length > 0) {
        return branchData.platformSettings;
    }
    const built = flatBranchToPlatformSettings(branchData);
    return Object.keys(built).length > 0 ? built : null;
}

class PlatformRegistry {
    constructor(db) {
        this.db = db;
        this.platforms = new Map();          // platformId -> platformDefinition
        this.branchConfigs = new Map();      // branchId -> { platformId -> settings }
        this.connectors = new Map();         // platformId -> connector instance
        this.initialized = false;
    }

    // ==================== INITIALIZATION ====================

    async initialize() {
        if (!this.db) {
            console.log('[PlatformRegistry] Firebase disabled - using static configs');
            this.loadStaticPlatforms();
            this.initialized = true;
            return;
        }

        try {
            // Platform tanımlarını yükle
            await this.loadPlatformDefinitions();

            // Branch konfigürasyonlarını yükle
            await this.loadBranchConfigs();

            // Realtime listener'ları başlat
            this.startRealtimeListeners();

            this.initialized = true;
            console.log(`[PlatformRegistry] Initialized with ${this.platforms.size} platforms`);
        } catch (error) {
            console.error('[PlatformRegistry] Initialization error:', error.message);
            this.loadStaticPlatforms();
            this.initialized = true;
        }
    }

    // Statik platform tanımları (Firebase yoksa fallback)
    loadStaticPlatforms() {
        const staticPlatforms = [
            {
                id: 'yemeksepeti',
                name: 'YemekSepeti',
                type: 'webhook',
                enabled: true,
                webhookEndpoint: '/order/:remoteId',
                pollingEndpoint: '/api/yemeksepeti/pending-orders',
                authType: 'api_key',
                orderTransformer: 'yemeksepeti',
                features: ['orders', 'cancellations', 'status_updates'],
                icon: 'yemeksepeti.png',
                color: '#FA0050'
            },
            {
                id: 'getiryemek',
                name: 'Getir Yemek',
                type: 'webhook',
                enabled: true,
                webhookEndpoint: '/webhook/newOrder',
                pollingEndpoint: '/poll/webhooks',
                authType: 'restaurant_secret',
                orderTransformer: 'getiryemek',
                features: ['orders', 'cancellations', 'courier_arrival', 'status_updates'],
                icon: 'getiryemek.png',
                color: '#5D3EBC'
            },
            {
                id: 'trendyolgo',
                name: 'Trendyol Go',
                type: 'polling',
                enabled: true,
                pollingEndpoint: null, // WPF'de polling yapılıyor
                webhookEndpoint: '/webhook/trendyolgo/order',
                authType: 'api_key',
                orderTransformer: 'trendyolgo',
                features: ['orders', 'cancellations'],
                icon: 'trendyolgo.png',
                color: '#F27A1A'
            },
            {
                id: 'qrmenu',
                name: 'QR Menü',
                type: 'firebase_realtime',
                enabled: true,
                orderTransformer: 'qrmenu',
                features: ['orders', 'table_orders'],
                icon: 'qrmenu.png',
                color: '#4CAF50'
            }
        ];

        staticPlatforms.forEach(p => this.platforms.set(p.id, p));
        console.log('[PlatformRegistry] Loaded static platform definitions');
    }

    // Firebase'den platform tanımlarını yükle
    async loadPlatformDefinitions() {
        const snapshot = await this.db.collection('platformDefinitions').get();

        if (snapshot.empty) {
            console.log('[PlatformRegistry] No platform definitions in Firebase - using static');
            this.loadStaticPlatforms();
            return;
        }

        snapshot.forEach(doc => {
            const platform = { id: doc.id, ...doc.data() };
            this.platforms.set(doc.id, platform);
        });

        console.log(`[PlatformRegistry] Loaded ${this.platforms.size} platform definitions from Firebase`);
    }

    // Branch bazlı konfigürasyonları yükle
    // Hem nested 'platformSettings' hem flat 'getirYemek_*' şemasını destekler
    async loadBranchConfigs() {
        const branchesSnapshot = await this.db.collectionGroup('branches').get();

        branchesSnapshot.forEach(doc => {
            const branchData = doc.data();
            const branchId = branchData.id || doc.id;

            const settings = resolvePlatformSettings(branchData);
            if (settings) {
                this.branchConfigs.set(branchId, settings);
            }
        });

        console.log(`[PlatformRegistry] Loaded configs for ${this.branchConfigs.size} branches`);
    }

    // Realtime listeners for dynamic updates
    startRealtimeListeners() {
        // Platform definitions listener
        this.db.collection('platformDefinitions').onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const platform = { id: change.doc.id, ...change.doc.data() };

                if (change.type === 'added' || change.type === 'modified') {
                    this.platforms.set(platform.id, platform);
                    console.log(`[PlatformRegistry] Platform updated: ${platform.id}`);
                } else if (change.type === 'removed') {
                    this.platforms.delete(platform.id);
                    console.log(`[PlatformRegistry] Platform removed: ${platform.id}`);
                }
            });
        });

        // Branch configs listener (collectionGroup)
        // Hem nested 'platformSettings' hem flat 'getirYemek_*' şemasını destekler
        this.db.collectionGroup('branches').onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                if (change.type === 'added' || change.type === 'modified') {
                    const branchData = change.doc.data();
                    const branchId = branchData.id || change.doc.id;

                    const settings = resolvePlatformSettings(branchData);
                    if (settings) {
                        this.branchConfigs.set(branchId, settings);
                    }
                }
            });
        });
    }

    // ==================== GETTERS ====================

    getPlatform(platformId) {
        return this.platforms.get(platformId.toLowerCase());
    }

    getAllPlatforms() {
        return Array.from(this.platforms.values());
    }

    getEnabledPlatforms() {
        return this.getAllPlatforms().filter(p => p.enabled !== false);
    }

    getBranchPlatformConfig(branchId, platformId) {
        const branchConfig = this.branchConfigs.get(branchId);
        if (!branchConfig) return null;
        return branchConfig[platformId.toLowerCase()] || null;
    }

    isPlatformEnabledForBranch(branchId, platformId) {
        const config = this.getBranchPlatformConfig(branchId, platformId);
        return config && config.enabled === true;
    }

    // ==================== CONNECTOR MANAGEMENT ====================

    registerConnector(platformId, connector) {
        this.connectors.set(platformId.toLowerCase(), connector);
        console.log(`[PlatformRegistry] Connector registered: ${platformId}`);
    }

    getConnector(platformId) {
        return this.connectors.get(platformId.toLowerCase());
    }

    // Branch için aktif connector'ları getir
    getActiveConnectorsForBranch(branchId) {
        const activeConnectors = [];
        const branchConfig = this.branchConfigs.get(branchId);

        if (!branchConfig) return activeConnectors;

        for (const [platformId, settings] of Object.entries(branchConfig)) {
            if (settings.enabled && this.connectors.has(platformId)) {
                activeConnectors.push({
                    platformId,
                    connector: this.connectors.get(platformId),
                    settings
                });
            }
        }

        return activeConnectors;
    }

    // ==================== ORDER ROUTING ====================

    // Sipariş için doğru platformu belirle
    identifyPlatformFromRequest(req) {
        // Header'dan platform belirle
        const platformHeader = req.headers['x-platform'];
        if (platformHeader && this.platforms.has(platformHeader.toLowerCase())) {
            return platformHeader.toLowerCase();
        }

        // URL path'den belirle
        const path = req.path.toLowerCase();

        if (path.includes('yemeksepeti') || path.match(/^\/order\/\d+/)) {
            return 'yemeksepeti';
        }
        if (path.includes('getir') || path.includes('webhook/neworder')) {
            return 'getiryemek';
        }
        if (path.includes('trendyol')) {
            return 'trendyolgo';
        }
        if (path.includes('qrmenu')) {
            return 'qrmenu';
        }

        // Body'den belirle
        if (req.body) {
            if (req.body.token && req.body.products) return 'yemeksepeti';
            if (req.body.client && req.body.products) return 'getiryemek';
            if (req.body.packageId || req.body.lines) return 'trendyolgo';
        }

        return null;
    }

    // ==================== ADMIN API ====================

    // Platform listesini API formatında döndür
    toApiResponse() {
        return {
            platforms: this.getAllPlatforms().map(p => ({
                id: p.id,
                name: p.name,
                type: p.type,
                enabled: p.enabled,
                features: p.features,
                icon: p.icon,
                color: p.color,
                hasWebhook: !!p.webhookEndpoint,
                hasPolling: !!p.pollingEndpoint
            })),
            totalCount: this.platforms.size,
            enabledCount: this.getEnabledPlatforms().length
        };
    }
}

module.exports = PlatformRegistry;
