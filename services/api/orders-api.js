// ==================================================================================
// UNIFIED ORDERS API - WPF ve Web için ortak sipariş komut API'si
// ==================================================================================

const express = require('express');
const admin = require('firebase-admin');

function createOrdersApi(registry, smartDispatch, { sendPushNotification, notifyCourierNewOrder, db, dispatchMetrics, dispatchQueue, io } = {}) {
    const router = express.Router();

    // API Key authentication middleware
    const authenticateApiKey = (req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        const branchId = req.headers['x-branch-id'];

        if (!apiKey) {
            return res.status(401).json({ error: 'API key required', code: 'NO_API_KEY' });
        }

        // Validate API key (in production, check against Firebase)
        const validKeys = [
            process.env.YEMEKSEPETI_POLLING_API_KEY,
            process.env.GETIRYEMEK_POLLING_API_KEY,
            process.env.UNIFIED_API_KEY
        ].filter(Boolean);

        if (!validKeys.includes(apiKey)) {
            return res.status(401).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
        }

        req.branchId = branchId;
        next();
    };

    router.use(authenticateApiKey);

    // ==================== ORDER COMMANDS ====================

    /**
     * POST /api/orders/:platformId/:orderId/accept
     * Sipariş kabul et + otomatik kurye ata
     * Body: { autoAssign: true } (opsiyonel, default: true)
     */
    router.post('/:platformId/:orderId/accept', async (req, res) => {
        const { platformId, orderId } = req.params;
        const { autoAssign = true } = req.body || {};
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            const result = await connector.acceptOrder(orderId, branchConfig);

            if (!result.success) {
                return res.status(400).json({
                    success: false,
                    error: result.reason,
                    code: 'ACCEPT_FAILED'
                });
            }

            console.log(`[OrdersAPI] Order accepted: ${platformId}/${orderId}`);

            // Push event: sipariş kabul edildi
            if (io && branchId) {
                io.to(`branch:${branchId}`).emit('order:status_changed', {
                    orderId, platform: platformId, status: 'ACCEPTED', timestamp: new Date().toISOString()
                });
            }

            // Auto-assign courier after successful accept
            let courierInfo = null;
            if (autoAssign !== false && smartDispatch && branchId) {
                try {
                    const order = await connector.getOrder(orderId);
                    if (order) {
                        // Extract delivery coordinates (platform-agnostic)
                        const deliveryLocation = {
                            latitude: order.Customer?.Address?.Latitude ||
                                      order.Latitude ||
                                      order.deliveryLatitude || 0,
                            longitude: order.Customer?.Address?.Longitude ||
                                       order.Longitude ||
                                       order.deliveryLongitude || 0
                        };

                        const courier = await smartDispatch.assignBestCourier(branchId, deliveryLocation);
                        if (courier) {
                            const assignResult = await connector.assignCourier(orderId, courier.id, courier.name);
                            if (assignResult.success) {
                                courierInfo = {
                                    courierId: courier.id,
                                    courierName: courier.name
                                };

                                // Send push notification to courier
                                if (notifyCourierNewOrder) {
                                    await notifyCourierNewOrder(courier, order, platformId);
                                }

                                console.log(`[OrdersAPI] Auto-assigned courier: ${courier.name} -> ${platformId}/${orderId}`);
                            }
                        } else {
                            console.log(`[OrdersAPI] No courier available for auto-assign: ${platformId}/${orderId}`);
                            // Enqueue for retry if dispatch queue is available
                            if (dispatchQueue) {
                                await dispatchQueue.enqueue({
                                    orderId,
                                    platformId,
                                    branchId,
                                    deliveryLocation
                                });
                            }
                        }
                    }
                } catch (assignError) {
                    // Non-fatal: order is accepted even if courier assignment fails
                    console.warn(`[OrdersAPI] Auto-assign failed for ${platformId}/${orderId}:`, assignError.message);
                }
            }

            const response = {
                success: true,
                orderId,
                platform: platformId,
                status: 'ACCEPTED'
            };

            if (courierInfo) {
                response.courierId = courierInfo.courierId;
                response.courierName = courierInfo.courierName;
                response.autoAssigned = true;
            }

            res.json(response);
        } catch (error) {
            console.error(`[OrdersAPI] Accept error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/orders/:platformId/:orderId/reject
     * Sipariş reddet
     */
    router.post('/:platformId/:orderId/reject', async (req, res) => {
        const { platformId, orderId } = req.params;
        const { reason } = req.body;
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            const result = await connector.rejectOrder(orderId, reason || 'OTHER', branchConfig);

            if (result.success) {
                console.log(`[OrdersAPI] Order rejected: ${platformId}/${orderId} - ${reason}`);

                // Push event: sipariş reddedildi
                if (io && branchId) {
                    io.to(`branch:${branchId}`).emit('order:cancelled', {
                        orderId, platform: platformId, reason: reason || 'REJECTED', timestamp: new Date().toISOString()
                    });
                }

                res.json({
                    success: true,
                    orderId,
                    platform: platformId,
                    status: 'REJECTED',
                    reason
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: result.reason,
                    code: 'REJECT_FAILED'
                });
            }
        } catch (error) {
            console.error(`[OrdersAPI] Reject error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/orders/:platformId/:orderId/ready
     * Sipariş hazır
     */
    router.post('/:platformId/:orderId/ready', async (req, res) => {
        const { platformId, orderId } = req.params;
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            const result = await connector.markOrderReady(orderId, branchConfig);

            if (result.success) {
                console.log(`[OrdersAPI] Order ready: ${platformId}/${orderId}`);

                // Push event: sipariş hazır
                if (io && branchId) {
                    io.to(`branch:${branchId}`).emit('order:status_changed', {
                        orderId, platform: platformId, status: 'READY', timestamp: new Date().toISOString()
                    });
                }

                res.json({
                    success: true,
                    orderId,
                    platform: platformId,
                    status: 'READY'
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: result.reason,
                    code: 'READY_FAILED'
                });
            }
        } catch (error) {
            console.error(`[OrdersAPI] Ready error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/orders/:platformId/:orderId/pickup
     * Sipariş teslim alındı (kurye aldı)
     * Platform API + Firestore status + orderStatusHistory kaydı
     */
    router.post('/:platformId/:orderId/pickup', async (req, res) => {
        const { platformId, orderId } = req.params;
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            // Call platform API (non-blocking for Firestore update)
            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            let platformResult = { success: true };
            try {
                platformResult = await connector.markOrderPickedUp(orderId, branchConfig);
            } catch (platformError) {
                console.warn(`[OrdersAPI] Platform pickup API failed (continuing with Firestore): ${platformError.message}`);
                platformResult = { success: false, reason: platformError.message };
            }

            // Always update Firestore status regardless of platform API result
            await connector.updateOrderStatus(orderId, 'PICKED_UP', {
                pickedUpAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Record in orderStatusHistory
            if (db) {
                try {
                    await db.collection('orderStatusHistory').doc(orderId).collection('events').add({
                        status: 'PICKED_UP',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        source: 'orders-api',
                        platformApiSuccess: platformResult.success
                    });
                } catch (historyError) {
                    console.warn(`[OrdersAPI] Status history write failed (non-fatal):`, historyError.message);
                }
            }

            console.log(`[OrdersAPI] Order picked up: ${platformId}/${orderId} (platform API: ${platformResult.success})`);

            // Push event: kurye siparişi aldı
            if (io && branchId) {
                io.to(`branch:${branchId}`).emit('order:status_changed', {
                    orderId, platform: platformId, status: 'PICKED_UP', timestamp: new Date().toISOString()
                });
            }

            res.json({
                success: true,
                orderId,
                platform: platformId,
                status: 'PICKED_UP',
                platformApiSuccess: platformResult.success
            });
        } catch (error) {
            console.error(`[OrdersAPI] Pickup error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/orders/:platformId/:orderId/deliver
     * Sipariş teslim edildi
     * Platform API + isDelivered + activeOrderCount decrement + orderStatusHistory
     */
    router.post('/:platformId/:orderId/deliver', async (req, res) => {
        const { platformId, orderId } = req.params;
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            // Call platform API (non-blocking for Firestore update)
            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            let platformResult = { success: true };
            try {
                platformResult = await connector.markOrderDelivered(orderId, branchConfig);
            } catch (platformError) {
                console.warn(`[OrdersAPI] Platform deliver API failed (continuing with Firestore): ${platformError.message}`);
                platformResult = { success: false, reason: platformError.message };
            }

            // Get order to find assigned courier before updating
            const order = await connector.getOrder(orderId);
            const assignedCourierId = order?.assignedCourierId;

            // Update order status in Firestore
            await connector.updateOrderStatus(orderId, 'DELIVERED', {
                isDelivered: true,
                deliveredAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Decrement courier's activeOrderCount
            if (assignedCourierId && db) {
                try {
                    const courierQuery = await db.collectionGroup('couriers')
                        .where('branchId', '==', branchId || order?.branchId)
                        .where('isActive', '==', true)
                        .get();

                    const courierDoc = courierQuery.docs.find(doc => doc.id === assignedCourierId);
                    if (courierDoc) {
                        const currentCount = courierDoc.data().activeOrderCount || 0;
                        await courierDoc.ref.update({
                            activeOrderCount: Math.max(0, currentCount - 1),
                            dailyDeliveryCount: admin.firestore.FieldValue.increment(1)
                        });
                        console.log(`[OrdersAPI] Courier ${assignedCourierId} activeOrderCount decremented`);
                    }
                } catch (counterError) {
                    console.warn(`[OrdersAPI] Failed to decrement courier counter (non-fatal):`, counterError.message);
                }
            }

            // Record in orderStatusHistory
            if (db) {
                try {
                    await db.collection('orderStatusHistory').doc(orderId).collection('events').add({
                        status: 'DELIVERED',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        source: 'orders-api',
                        courierId: assignedCourierId || null,
                        platformApiSuccess: platformResult.success
                    });
                } catch (historyError) {
                    console.warn(`[OrdersAPI] Status history write failed (non-fatal):`, historyError.message);
                }
            }

            console.log(`[OrdersAPI] Order delivered: ${platformId}/${orderId} (platform API: ${platformResult.success})`);

            // Push event: sipariş teslim edildi
            if (io && branchId) {
                io.to(`branch:${branchId}`).emit('order:status_changed', {
                    orderId, platform: platformId, status: 'DELIVERED', timestamp: new Date().toISOString()
                });
            }

            res.json({
                success: true,
                orderId,
                platform: platformId,
                status: 'DELIVERED',
                platformApiSuccess: platformResult.success
            });
        } catch (error) {
            console.error(`[OrdersAPI] Deliver error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * POST /api/orders/:platformId/:orderId/assign-courier
     * Siparişe kurye ata (WPF'den fire-and-forget olarak çağrılır)
     * Body: { courierId, courierName } (manuel atama) veya
     *       { deliveryLatitude, deliveryLongitude } (otomatik atama - opsiyonel, yoksa Firebase'den okur)
     * autoAssign default true - body'de courierId yoksa otomatik atar
     */
    router.post('/:platformId/:orderId/assign-courier', async (req, res) => {
        const { platformId, orderId } = req.params;
        const { courierId, courierName, autoAssign, deliveryLatitude, deliveryLongitude } = req.body || {};
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            let assignedCourierId = courierId;
            let assignedCourierName = courierName;

            // Auto-assign using smart dispatch (default: true when no courierId provided)
            const shouldAutoAssign = !assignedCourierId && (autoAssign !== false) && smartDispatch && branchId;
            if (shouldAutoAssign) {
                // Use coordinates from request body first, then fall back to order data
                let deliveryLocation = null;

                if (deliveryLatitude && deliveryLongitude) {
                    deliveryLocation = {
                        latitude: deliveryLatitude,
                        longitude: deliveryLongitude
                    };
                } else {
                    // Fall back to reading order from connector
                    const order = await connector.getOrder(orderId);
                    if (order) {
                        deliveryLocation = {
                            latitude: order.Customer?.Address?.Latitude ||
                                      order.Latitude ||
                                      order.deliveryLatitude || 0,
                            longitude: order.Customer?.Address?.Longitude ||
                                       order.Longitude ||
                                       order.deliveryLongitude || 0
                        };
                    }
                }

                if (deliveryLocation) {
                    const bestCourier = await smartDispatch.assignBestCourier(branchId, deliveryLocation);
                    if (bestCourier) {
                        assignedCourierId = bestCourier.id;
                        assignedCourierName = bestCourier.name;
                    }
                }
            }

            if (!assignedCourierId) {
                return res.status(400).json({
                    success: false,
                    error: 'No courier specified or available',
                    code: 'NO_COURIER'
                });
            }

            const result = await connector.assignCourier(orderId, assignedCourierId, assignedCourierName);

            if (result.success) {
                console.log(`[OrdersAPI] Courier assigned: ${platformId}/${orderId} -> ${assignedCourierName}`);

                // Send push notification to assigned courier
                if (notifyCourierNewOrder) {
                    try {
                        const order = await connector.getOrder(orderId);
                        if (order) {
                            await notifyCourierNewOrder({ id: assignedCourierId, name: assignedCourierName }, order, platformId);
                            console.log(`[OrdersAPI] Push notification sent to courier: ${assignedCourierName}`);
                        }
                    } catch (notifError) {
                        console.warn(`[OrdersAPI] Push notification failed for ${assignedCourierName}:`, notifError.message);
                    }
                }

                res.json({
                    success: true,
                    orderId,
                    platform: platformId,
                    courierId: assignedCourierId,
                    courierName: assignedCourierName
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: result.reason,
                    code: 'ASSIGN_FAILED'
                });
            }
        } catch (error) {
            console.error(`[OrdersAPI] Assign courier error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    // ==================== BRANCH OPERATIONS ====================

    /**
     * POST /api/orders/:platformId/restaurant-status
     * Şube açma/kapama (POS web client için).
     * - Mevcut connector.setRestaurantStatus() metodunu kullanır (yeni Getir API çağrısı yok).
     * - Mevcut sipariş akışına dokunmaz, yan kanal.
     * - Audit log Firestore branchOperations koleksiyonuna yazılır.
     *
     * Headers: x-api-key, x-branch-id
     * Body: { status: 'open' | 'closed' | 'busy', performedBy?: string, source?: string }
     */
    router.post('/:platformId/restaurant-status', async (req, res) => {
        const { platformId } = req.params;
        const branchId = req.branchId;
        const { status, performedBy, source } = req.body || {};

        if (!branchId) {
            return res.status(400).json({ success: false, error: 'x-branch-id header required', code: 'NO_BRANCH_ID' });
        }
        if (!['open', 'closed', 'busy'].includes(status)) {
            return res.status(400).json({ success: false, error: "status must be 'open' | 'closed' | 'busy'", code: 'INVALID_STATUS' });
        }

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({ success: false, error: `Platform not found: ${platformId}`, code: 'PLATFORM_NOT_FOUND' });
            }
            if (typeof connector.setRestaurantStatus !== 'function') {
                return res.status(501).json({ success: false, error: `Platform ${platformId} does not support restaurant status toggle`, code: 'NOT_IMPLEMENTED' });
            }

            const branchConfig = registry.getBranchPlatformConfig(branchId, platformId) || {};
            const result = await connector.setRestaurantStatus(status, branchConfig);

            // Audit log + branch doc state cache — best effort, hata atılırsa ana işlemi etkilemez
            if (db) {
                try {
                    await db.collection('branchOperations').add({
                        branchId,
                        platform: platformId,
                        action: 'restaurant_status',
                        value: status,
                        performedBy: performedBy || 'unknown',
                        source: source || 'webpos',
                        success: result.success === true,
                        result: result.success ? null : (result.reason || 'unknown'),
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    });
                } catch (auditErr) {
                    console.warn('[OrdersAPI] Audit log write failed:', auditErr.message);
                }

                // Branch doc'a state cache yaz — POS UI'lar Firestore listener ile anlık görsün
                if (result.success === true) {
                    try {
                        const branchRef = db.collection('branches').doc(branchId);
                        await branchRef.update({
                            [`${platformId}_isRestaurantOpen`]: status === 'open',
                            [`${platformId}_restaurantStatus`]: status,
                            [`${platformId}_restaurantStatusUpdatedAt`]: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    } catch (cacheErr) {
                        console.warn('[OrdersAPI] Branch doc state cache update failed:', cacheErr.message);
                    }
                }
            }

            // Socket.io broadcast — POS UI'lar anlık güncellensin
            if (io && branchId) {
                io.to(`branch:${branchId}`).emit('restaurant:status_changed', {
                    platform: platformId,
                    status,
                    timestamp: new Date().toISOString(),
                });
            }

            if (result.success) {
                console.log(`[OrdersAPI] Restaurant status changed: ${platformId}/${branchId} -> ${status}`);
                return res.json({ success: true, branchId, platform: platformId, status });
            }
            return res.status(400).json({
                success: false,
                error: result.reason || 'setRestaurantStatus failed',
                code: 'STATUS_CHANGE_FAILED',
            });
        } catch (error) {
            console.error('[OrdersAPI] Restaurant status error:', error.message);
            return res.status(500).json({ success: false, error: error.message, code: 'SERVER_ERROR' });
        }
    });

    // ==================== ORDER QUERIES ====================

    /**
     * GET /api/orders/:platformId/:orderId
     * Sipariş detayını getir
     */
    router.get('/:platformId/:orderId', async (req, res) => {
        const { platformId, orderId } = req.params;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            const order = await connector.getOrder(orderId);

            if (order) {
                res.json({
                    success: true,
                    order
                });
            } else {
                res.status(404).json({
                    success: false,
                    error: 'Order not found',
                    code: 'ORDER_NOT_FOUND'
                });
            }
        } catch (error) {
            console.error(`[OrdersAPI] Get order error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * GET /api/orders/active
     * Branch için tüm aktif siparişleri getir
     */
    router.get('/active', async (req, res) => {
        const branchId = req.branchId;

        try {
            const allOrders = [];

            // Her platform connector'dan aktif siparişleri topla
            for (const [platformId, connector] of registry.connectors) {
                const orders = await connector.getActiveOrders(branchId);
                allOrders.push(...orders.map(o => ({ ...o, platform: platformId })));
            }

            // Tarihe göre sırala
            allOrders.sort((a, b) => {
                const dateA = new Date(a.OrderDate || a.CreatedAt);
                const dateB = new Date(b.OrderDate || b.CreatedAt);
                return dateB - dateA;
            });

            res.json({
                success: true,
                branchId,
                totalCount: allOrders.length,
                orders: allOrders
            });
        } catch (error) {
            console.error(`[OrdersAPI] Get active orders error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    /**
     * GET /api/orders/active/:platformId
     * Platform için aktif siparişleri getir
     */
    router.get('/active/:platformId', async (req, res) => {
        const { platformId } = req.params;
        const branchId = req.branchId;

        try {
            const connector = registry.getConnector(platformId);
            if (!connector) {
                return res.status(404).json({
                    success: false,
                    error: `Platform not found: ${platformId}`,
                    code: 'PLATFORM_NOT_FOUND'
                });
            }

            const orders = await connector.getActiveOrders(branchId);

            res.json({
                success: true,
                platform: platformId,
                branchId,
                totalCount: orders.length,
                orders
            });
        } catch (error) {
            console.error(`[OrdersAPI] Get platform orders error:`, error.message);
            res.status(500).json({
                success: false,
                error: error.message,
                code: 'SERVER_ERROR'
            });
        }
    });

    return router;
}

module.exports = createOrdersApi;
