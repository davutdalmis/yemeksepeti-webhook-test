// ==================================================================================
// PLATFORMS ADMIN API - Platform yönetimi ve konfigürasyon API'si
// ==================================================================================

const express = require('express');

function createPlatformsApi(registry, db) {
    const router = express.Router();

    // Admin authentication middleware
    const authenticateAdmin = (req, res, next) => {
        const adminKey = req.headers['x-admin-key'];

        if (!adminKey) {
            return res.status(401).json({ error: 'Admin key required', code: 'NO_ADMIN_KEY' });
        }

        // Validate admin key (in production, check against Firebase)
        if (adminKey !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Invalid admin key', code: 'INVALID_ADMIN_KEY' });
        }

        next();
    };

    // ==================== PUBLIC ENDPOINTS ====================

    /**
     * GET /api/platforms
     * Tüm platform tanımlarını listele (public)
     */
    router.get('/', (req, res) => {
        res.json(registry.toApiResponse());
    });

    /**
     * GET /api/platforms/:platformId
     * Platform detayını getir (public)
     */
    router.get('/:platformId', (req, res) => {
        const { platformId } = req.params;
        const platform = registry.getPlatform(platformId);

        if (platform) {
            res.json({
                success: true,
                platform
            });
        } else {
            res.status(404).json({
                success: false,
                error: `Platform not found: ${platformId}`,
                code: 'PLATFORM_NOT_FOUND'
            });
        }
    });

    /**
     * GET /api/platforms/branch/:branchId
     * Branch için aktif platformları listele
     */
    router.get('/branch/:branchId', (req, res) => {
        const { branchId } = req.params;

        const activeConnectors = registry.getActiveConnectorsForBranch(branchId);

        res.json({
            success: true,
            branchId,
            platforms: activeConnectors.map(c => ({
                platformId: c.platformId,
                enabled: true,
                settings: {
                    // Hassas bilgileri maskeleyerek döndür
                    ...c.settings,
                    apiKey: c.settings.apiKey ? '***' + c.settings.apiKey.slice(-4) : null,
                    apiSecret: c.settings.apiSecret ? '***' : null,
                    restaurantSecretKey: c.settings.restaurantSecretKey ? '***' + c.settings.restaurantSecretKey.slice(-4) : null
                }
            })),
            totalCount: activeConnectors.length
        });
    });

    // ==================== ADMIN ENDPOINTS ====================

    /**
     * POST /api/platforms/definitions
     * Yeni platform tanımı ekle (admin only)
     */
    router.post('/definitions', authenticateAdmin, async (req, res) => {
        const platformData = req.body;

        if (!platformData.id || !platformData.name) {
            return res.status(400).json({
                success: false,
                error: 'Platform ID and name required',
                code: 'MISSING_FIELDS'
            });
        }

        try {
            // Check if platform already exists
            if (registry.getPlatform(platformData.id)) {
                return res.status(409).json({
                    success: false,
                    error: `Platform already exists: ${platformData.id}`,
                    code: 'PLATFORM_EXISTS'
                });
            }

            // Create platform definition
            const definition = {
                id: platformData.id.toLowerCase(),
                name: platformData.name,
                type: platformData.type || 'webhook',
                enabled: platformData.enabled !== false,
                webhookEndpoint: platformData.webhookEndpoint || null,
                pollingEndpoint: platformData.pollingEndpoint || null,
                authType: platformData.authType || 'api_key',
                orderTransformer: platformData.orderTransformer || 'generic',
                features: platformData.features || ['orders'],
                icon: platformData.icon || null,
                color: platformData.color || '#666666',
                apiBaseUrl: platformData.apiBaseUrl || null,
                requiredFields: platformData.requiredFields || [],
                createdAt: new Date().toISOString()
            };

            // Save to Firebase if available
            if (db) {
                await db.collection('platformDefinitions').doc(definition.id).set(definition);
            }

            // Add to registry
            registry.platforms.set(definition.id, definition);

            console.log(`[PlatformsAPI] Platform created: ${definition.id}`);
            res.status(201).json({
                success: true,
                platform: definition
            });

        } catch (error) {
            console.error('[PlatformsAPI] Create platform error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * PUT /api/platforms/definitions/:platformId
     * Platform tanımını güncelle (admin only)
     */
    router.put('/definitions/:platformId', authenticateAdmin, async (req, res) => {
        const { platformId } = req.params;
        const updates = req.body;

        try {
            const existing = registry.getPlatform(platformId);
            if (!existing) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            // Merge updates
            const updated = {
                ...existing,
                ...updates,
                id: platformId, // ID cannot change
                updatedAt: new Date().toISOString()
            };

            // Save to Firebase if available
            if (db) {
                await db.collection('platformDefinitions').doc(platformId).update(updates);
            }

            // Update registry
            registry.platforms.set(platformId, updated);

            console.log(`[PlatformsAPI] Platform updated: ${platformId}`);
            res.json({
                success: true,
                platform: updated
            });

        } catch (error) {
            console.error('[PlatformsAPI] Update platform error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * DELETE /api/platforms/definitions/:platformId
     * Platform tanımını sil (admin only)
     */
    router.delete('/definitions/:platformId', authenticateAdmin, async (req, res) => {
        const { platformId } = req.params;

        try {
            if (!registry.getPlatform(platformId)) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            // Delete from Firebase if available
            if (db) {
                await db.collection('platformDefinitions').doc(platformId).delete();
            }

            // Remove from registry
            registry.platforms.delete(platformId);
            registry.connectors.delete(platformId);

            console.log(`[PlatformsAPI] Platform deleted: ${platformId}`);
            res.json({
                success: true,
                message: `Platform deleted: ${platformId}`
            });

        } catch (error) {
            console.error('[PlatformsAPI] Delete platform error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * PUT /api/platforms/branch/:branchId/:platformId
     * Branch için platform konfigürasyonunu güncelle (admin only)
     */
    router.put('/branch/:branchId/:platformId', authenticateAdmin, async (req, res) => {
        const { branchId, platformId } = req.params;
        const settings = req.body;

        try {
            // Validate platform exists
            if (!registry.getPlatform(platformId)) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            // Get or create branch config
            let branchConfig = registry.branchConfigs.get(branchId) || {};
            branchConfig[platformId] = {
                ...branchConfig[platformId],
                ...settings,
                updatedAt: new Date().toISOString()
            };

            // Save to Firebase if available
            if (db) {
                const branchQuery = await db.collectionGroup('branches')
                    .where('id', '==', branchId)
                    .limit(1)
                    .get();

                if (!branchQuery.empty) {
                    await branchQuery.docs[0].ref.update({
                        [`platformSettings.${platformId}`]: branchConfig[platformId]
                    });
                }
            }

            // Update registry
            registry.branchConfigs.set(branchId, branchConfig);

            console.log(`[PlatformsAPI] Branch config updated: ${branchId}/${platformId}`);
            res.json({
                success: true,
                branchId,
                platformId,
                settings: {
                    ...branchConfig[platformId],
                    // Mask sensitive fields
                    apiKey: branchConfig[platformId].apiKey ? '***' : null,
                    apiSecret: branchConfig[platformId].apiSecret ? '***' : null
                }
            });

        } catch (error) {
            console.error('[PlatformsAPI] Update branch config error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/platforms/branch/:branchId/:platformId/toggle
     * Branch için platformu aktif/pasif yap
     */
    router.post('/branch/:branchId/:platformId/toggle', authenticateAdmin, async (req, res) => {
        const { branchId, platformId } = req.params;
        const { enabled } = req.body;

        try {
            let branchConfig = registry.branchConfigs.get(branchId) || {};

            if (!branchConfig[platformId]) {
                branchConfig[platformId] = {};
            }

            branchConfig[platformId].enabled = enabled === true;
            branchConfig[platformId].updatedAt = new Date().toISOString();

            // Save to Firebase if available
            if (db) {
                const branchQuery = await db.collectionGroup('branches')
                    .where('id', '==', branchId)
                    .limit(1)
                    .get();

                if (!branchQuery.empty) {
                    await branchQuery.docs[0].ref.update({
                        [`platformSettings.${platformId}.enabled`]: enabled,
                        [`platformSettings.${platformId}.updatedAt`]: new Date().toISOString()
                    });
                }
            }

            // Update registry
            registry.branchConfigs.set(branchId, branchConfig);

            console.log(`[PlatformsAPI] Platform toggled: ${branchId}/${platformId} -> ${enabled}`);
            res.json({
                success: true,
                branchId,
                platformId,
                enabled
            });

        } catch (error) {
            console.error('[PlatformsAPI] Toggle platform error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/platforms/:platformId/test-connection
     * Platform bağlantısını test et
     */
    router.post('/:platformId/test-connection', authenticateAdmin, async (req, res) => {
        const { platformId } = req.params;
        const { settings, branchId } = req.body;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform connector not found: ${platformId}`,
                    code: 'CONNECTOR_NOT_FOUND'
                });
            }

            // Test connection based on platform type
            let testResult;

            if (platformId === 'yemeksepeti') {
                // Test token refresh
                const token = await connector.getToken();
                testResult = {
                    success: !!token,
                    message: token ? 'Token obtained successfully' : 'Failed to get token'
                };
            } else if (platformId === 'getiryemek') {
                // Test restaurant status endpoint
                testResult = await connector.setRestaurantStatus('open', settings);
            } else if (platformId === 'trendyolgo') {
                // Test order fetch
                testResult = await connector.fetchNewOrders(settings);
            } else {
                testResult = {
                    success: true,
                    message: 'Connection test not implemented for this platform'
                };
            }

            res.json({
                success: testResult.success,
                platform: platformId,
                testResult
            });

        } catch (error) {
            console.error('[PlatformsAPI] Test connection error:', error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'TEST_FAILED'
            });
        }
    });

    return router;
}

module.exports = createPlatformsApi;
