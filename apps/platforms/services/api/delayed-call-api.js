// ==================================================================================
// DELAYED CALL API — POST /api/v2/delayed-call/enqueue
// ==================================================================================
// RAILWAY_DELAYED_QUEUE_PLAN.md Faz 1.5
//
// WPF (NotifyPlatformApiAsync flag=true iken) buradan delayed API call kuyruğa atar.
// Worker (services/queue/delayed-call-queue.js) earliestAt zamanı geldiğinde
// connector.executeAction üzerinden çalıştırır.
// ==================================================================================

const express = require('express');
const { VALID_PLATFORMS, VALID_ACTIONS } = require('../queue/delayed-call-queue');

/**
 * Express factory matching `createOrdersApi` pattern.
 *
 * @param {DelayedCallQueue} delayedCallQueue - constructed queue with worker started
 * @returns {express.Router}
 */
function createDelayedCallApi(delayedCallQueue) {
    const router = express.Router();

    // Service-level guard: queue not initialized → 503 for every route below
    router.use((req, res, next) => {
        if (!delayedCallQueue) {
            return res.status(503).json({
                success: false,
                error: 'DelayedCallQueue not initialized',
                code: 'SERVICE_UNAVAILABLE'
            });
        }
        next();
    });

    // API Key authentication — same shape as orders-api.js
    router.use((req, res, next) => {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(401).json({ error: 'API key required', code: 'NO_API_KEY' });
        }
        const validKeys = [
            process.env.YEMEKSEPETI_POLLING_API_KEY,
            process.env.GETIRYEMEK_POLLING_API_KEY,
            process.env.UNIFIED_API_KEY
        ].filter(Boolean);
        if (validKeys.length > 0 && !validKeys.includes(apiKey)) {
            return res.status(401).json({ error: 'Invalid API key', code: 'INVALID_API_KEY' });
        }
        req.branchIdHeader = req.headers['x-branch-id'] || null;
        next();
    });

    router.post('/enqueue', enqueueHandler(delayedCallQueue));

    return router;
}

/**
 * Exported handler so it can be unit-tested with mock req/res.
 */
function enqueueHandler(delayedCallQueue) {
    return async (req, res) => {
        const { platform, orderId, branchId, action, earliestAt, scheduledAt, payload, maxAttempts } = req.body || {};

        // ---------- Validation ----------
        const errors = [];
        if (!platform || !VALID_PLATFORMS.includes(platform)) {
            errors.push(`platform must be one of: ${VALID_PLATFORMS.join(',')}`);
        }
        if (!action || !VALID_ACTIONS.includes(action)) {
            errors.push(`action must be one of: ${VALID_ACTIONS.join(',')}`);
        }
        if (!orderId || typeof orderId !== 'string') {
            errors.push('orderId required (string)');
        }
        if (!branchId || typeof branchId !== 'string') {
            errors.push('branchId required (string)');
        }
        if (!earliestAt) {
            errors.push('earliestAt required');
        } else {
            const ts = Date.parse(earliestAt);
            if (!ts || Number.isNaN(ts)) errors.push('earliestAt must be ISO date string');
        }
        if (scheduledAt) {
            const ts = Date.parse(scheduledAt);
            if (!ts || Number.isNaN(ts)) errors.push('scheduledAt must be ISO date string');
        }

        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                error: errors.join('; '),
                code: 'VALIDATION_FAILED'
            });
        }

        // ---------- Enqueue ----------
        try {
            const result = await delayedCallQueue.enqueue({
                platform,
                orderId,
                branchId,
                action,
                earliestAt: new Date(earliestAt),
                scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
                payload: payload || {},
                maxAttempts
            });

            if (!result.success) {
                return res.status(500).json({
                    success: false,
                    error: result.error || 'enqueue failed',
                    code: 'ENQUEUE_FAILED'
                });
            }

            // scheduledAt may be a Firestore Timestamp object; normalize to ISO string
            let scheduledIso = null;
            const sa = result.scheduledAt;
            if (sa) {
                if (typeof sa.toDate === 'function') scheduledIso = sa.toDate().toISOString();
                else if (sa instanceof Date) scheduledIso = sa.toISOString();
                else scheduledIso = String(sa);
            }

            return res.status(200).json({
                success: true,
                queueId: result.queueId,
                alreadyQueued: !!result.alreadyQueued,
                scheduledAt: scheduledIso
            });
        } catch (error) {
            console.error('[DelayedCallApi] enqueue error:', error.message);
            return res.status(500).json({
                success: false,
                error: error.message,
                code: 'ENQUEUE_FAILED'
            });
        }
    };
}

module.exports = createDelayedCallApi;
module.exports.enqueueHandler = enqueueHandler;
