try { require('dotenv').config(); } catch (e) { }

const express = require('express');

const { admin, db, firebaseInitialized } = require('@yemigo/shared/firestore-admin');
const { getRedisClient, isRedisAvailable, getRedisStatus } = require('@yemigo/shared/redis-client');
const { initSentry } = require('@yemigo/shared/sentry-init');

const ParasutProvider = require('./providers/ParasutProvider');
const TokenManager = require('./auth/TokenManager');
const CredentialVault = require('./secrets/CredentialVault');
const { InvoiceProviderError } = require('./providers/IInvoiceProvider');
const { IdempotencyService } = require('./lib/IdempotencyService');
const RateLimiter = require('./lib/RateLimiter');
const { InvoiceQueue } = require('./queue/InvoiceQueue');
const InvoiceWorker = require('./workers/InvoiceWorker');
const StockTransferListener = require('./listeners/StockTransferListener');

initSentry({ dsn: process.env.SENTRY_DSN, service: 'invoicing-engine' });

const app = express();
app.use(express.json({ limit: '2mb' }));

const INVOICING_API_KEY = process.env.INVOICING_API_KEY || '';
const ENCRYPTED_FIELDS = ['clientId', 'clientSecret', 'username', 'password'];

// ---------------- Vault + TokenManager bootstrap ----------------

let vault = null;
try {
    vault = new CredentialVault();
    console.log('[invoicing-engine] CredentialVault initialized');
} catch (e) {
    console.warn('[invoicing-engine] CredentialVault init skipped:', e.message);
}

const redis = getRedisClient();

async function loadParasutSettings(tenantId) {
    if (!firebaseInitialized || !db) {
        throw new Error('Firestore not initialized — cannot load tenant settings');
    }
    const ref = db.collection('invoicingCredentials').doc(tenantId).collection('providers').doc('parasut');
    const snap = await ref.get();
    if (!snap.exists) {
        const err = new Error(`No Parasut settings for tenant "${tenantId}"`);
        err.code = 'TENANT_SETTINGS_MISSING';
        err.status = 404;
        throw err;
    }
    return snap.data();
}

async function providerFactory(tenantId) {
    if (!vault) throw new Error('CredentialVault not initialized (INVOICING_AES_MASTER_KEY missing)');
    const settings = await loadParasutSettings(tenantId);
    if (settings.isEnabled === false) {
        const err = new Error(`Parasut integration disabled for tenant "${tenantId}"`);
        err.code = 'TENANT_DISABLED';
        err.status = 409;
        throw err;
    }
    const decrypted = vault.decryptFields(settings, ENCRYPTED_FIELDS, tenantId);
    return new ParasutProvider({
        clientId: decrypted.clientId,
        clientSecret: decrypted.clientSecret,
        username: decrypted.username,
        password: decrypted.password,
        companyId: settings.companyId,
    });
}

const tokenManager = new TokenManager({ redis, providerFactory });

// ---------------- Auth middleware ----------------

function requireApiKey(req, res, next) {
    if (!INVOICING_API_KEY) {
        return res.status(500).json({ error: 'INVOICING_API_KEY not configured on server' });
    }
    const provided = req.get('X-Invoicing-Api-Key');
    if (provided !== INVOICING_API_KEY) {
        return res.status(401).json({ error: 'invalid_api_key' });
    }
    next();
}

// ---------------- Public health ----------------

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'invoicing-engine',
        version: require('./package.json').version,
        node: process.version,
        uptime: process.uptime(),
        firebase: firebaseInitialized ? 'ready' : 'disabled',
        redis: getRedisStatus(),
        vault: vault ? 'ready' : 'disabled',
        timestamp: new Date().toISOString(),
    });
});

// ---------------- Credentials write (Plan 27 1.5/1.6) ----------------

app.post('/invoicing/credentials', requireApiKey, async (req, res) => {
    try {
        if (!vault) return res.status(500).json({ error: 'vault_not_initialized' });
        if (!firebaseInitialized || !db) return res.status(500).json({ error: 'firestore_not_initialized' });

        const {
            tenantId,
            companyId,
            clientId,
            clientSecret,
            username,
            password,
            isEnabled = true,
            automationMode = 'manual',
            defaultDocumentType = 'sales_invoice',
            defaultVatRate = 20,
            invoiceSeriesPrefix = 'A',
            shipmentIncludedDefault = false,
            updatedBy = 'panel',
        } = req.body || {};

        if (!tenantId || !companyId || !clientId || !clientSecret || !username || !password) {
            return res.status(400).json({
                error: 'missing_fields',
                required: ['tenantId', 'companyId', 'clientId', 'clientSecret', 'username', 'password'],
            });
        }

        const encrypted = vault.encryptFields(
            { clientId, clientSecret, username, password },
            ENCRYPTED_FIELDS,
            tenantId
        );

        const payload = {
            ...encrypted,
            companyId: String(companyId),
            isEnabled: !!isEnabled,
            automationMode,
            defaultDocumentType,
            defaultVatRate,
            invoiceSeriesPrefix,
            shipmentIncludedDefault: !!shipmentIncludedDefault,
            provider: 'parasut',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: String(updatedBy),
        };

        const ref = db.collection('invoicingCredentials').doc(tenantId).collection('providers').doc('parasut');
        await ref.set(payload, { merge: true });

        // Invalidate token cache so next call uses fresh creds
        await tokenManager.invalidateToken(tenantId);

        res.json({
            ok: true,
            tenantId,
            provider: 'parasut',
            companyId: payload.companyId,
            isEnabled: payload.isEnabled,
        });
    } catch (e) {
        console.error('[invoicing-engine] credentials write error:', e);
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

// ---------------- Test connection (Plan 27 1.6) ----------------

app.post('/invoicing/test-connection', requireApiKey, async (req, res) => {
    try {
        const { tenantId } = req.body || {};
        if (!tenantId) return res.status(400).json({ error: 'missing_tenantId' });

        const provider = await providerFactory(tenantId);
        const token = await tokenManager.getValidToken(tenantId);
        const ping = await provider.ping(token);

        if (ping.ok) {
            return res.json({ ok: true, provider: provider.providerName, parasutCompany: ping.company });
        }
        return res.status(502).json({ ok: false, error: ping.error || 'ping_failed', code: ping.code });
    } catch (e) {
        console.error('[invoicing-engine] test-connection error:', e.message);
        const status = e.status || (e instanceof InvoiceProviderError && e.status) || 500;
        res.status(status).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

// ---------------- Tenant settings read (no secrets) ----------------

app.get('/invoicing/tenants/:tenantId', requireApiKey, async (req, res) => {
    try {
        if (!firebaseInitialized || !db) return res.status(500).json({ error: 'firestore_not_initialized' });
        const settings = await loadParasutSettings(req.params.tenantId);
        const safe = {};
        for (const [k, v] of Object.entries(settings)) {
            if (k.startsWith('encrypted')) safe[k] = '****';
            else safe[k] = v;
        }
        res.json({ ok: true, tenantId: req.params.tenantId, settings: safe });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

// ---------------- Faz 2: Lifecycle (queue + worker + listener) ----------------

let idempotency = null;
let rateLimiter = null;
let invoiceQueue = null;
let invoiceWorker = null;
let stockListener = null;

if (firebaseInitialized && db) {
    idempotency = new IdempotencyService({ db });
}

if (isRedisAvailable() && idempotency) {
    rateLimiter = new RateLimiter({ redis });
    try {
        invoiceQueue = new InvoiceQueue({ connection: redis });
    } catch (e) {
        console.warn('[invoicing-engine] InvoiceQueue init skipped:', e.message);
    }

    if (invoiceQueue && invoiceQueue.available) {
        invoiceWorker = new InvoiceWorker({
            connection: redis,
            idempotency,
            tokenManager,
            rateLimiter,
            providerFactory,
            tenantSettingsLoader: buildInvoiceContext,
        });

        // Auto-start listener only if explicitly enabled (avoids accidental Firestore subscriptions in dev)
        if (process.env.INVOICING_LISTENER_ENABLED === 'true') {
            stockListener = new StockTransferListener({
                db,
                idempotency,
                queue: invoiceQueue,
                settingsLoader: loadParasutSettings,
            });
            stockListener.start();
        } else {
            console.log('[invoicing-engine] StockTransferListener NOT started (set INVOICING_LISTENER_ENABLED=true to enable)');
        }
    }
} else {
    console.log('[invoicing-engine] Faz 2 lifecycle DISABLED (Redis or Firebase not available)');
}

/**
 * Build the invoice context (branch + items + settings) from a draft document.
 * Reads stockTransfers/{sourceId} for items + branches/{branchId} for tax info.
 */
async function buildInvoiceContext(tenantId, doc) {
    if (!firebaseInitialized || !db) {
        throw new Error('Firestore unavailable for invoice context build');
    }
    const settings = await loadParasutSettings(tenantId);

    let sourceData = null;
    if (doc.sourceType === 'stockTransfer' && doc.sourceId) {
        const snap = await db.collection('stockTransfers').doc(doc.sourceId).get();
        if (snap.exists) sourceData = snap.data();
    }

    let branchData = null;
    const branchId = doc.branchId || (sourceData && (sourceData.destinationBranchId || sourceData.branchId));
    if (branchId) {
        const bSnap = await db.collection('branches').doc(branchId).get();
        if (bSnap.exists) branchData = bSnap.data();
    }

    const items = ((sourceData && sourceData.items) || []).map((it) => ({
        name: it.productName || it.name,
        productName: it.productName || it.name,
        productId: it.productId,
        sku: it.sku,
        quantity: Number(it.quantity || 1),
        unitPrice: Number(it.unitPrice || 0),
        vatRate: typeof it.vatRate === 'number' ? it.vatRate : settings.defaultVatRate || 20,
        unit: it.unit || 'Adet',
    }));

    return {
        branch: branchData || { name: 'Sube', taxNumber: '' },
        items,
        currency: doc.currency || sourceData?.currency || 'TRL',
        issueDate: new Date().toISOString().slice(0, 10),
        shipmentIncluded: doc.shipmentIncluded != null ? doc.shipmentIncluded : !!settings.shipmentIncludedDefault,
        documentType: doc.documentType || settings.defaultDocumentType || 'sales_invoice',
        description: sourceData ? `Sevkiyat: ${sourceData.transferNumber || sourceData.code || doc.sourceId}` : '',
        invoiceSeriesPrefix: settings.invoiceSeriesPrefix || 'A',
    };
}

// ---------------- Faz 2: Admin endpoints ----------------

app.get('/invoicing/queue/stats', requireApiKey, async (_req, res) => {
    if (!invoiceQueue) return res.status(503).json({ error: 'queue_unavailable' });
    res.json(await invoiceQueue.stats());
});

app.get('/invoicing/jobs/dlq', requireApiKey, async (req, res) => {
    if (!invoiceQueue) return res.status(503).json({ error: 'queue_unavailable' });
    const start = parseInt(req.query.start || '0', 10);
    const end = parseInt(req.query.end || '50', 10);
    const failed = await invoiceQueue.listFailed(start, end);
    res.json({
        ok: true,
        items: failed.map((j) => ({
            id: j.id,
            data: j.data,
            attemptsMade: j.attemptsMade,
            failedReason: j.failedReason,
            stacktrace: j.stacktrace ? j.stacktrace.slice(0, 3) : [],
            timestamp: j.timestamp,
        })),
    });
});

app.post('/invoicing/jobs/:id/retry', requireApiKey, async (req, res) => {
    if (!invoiceQueue) return res.status(503).json({ error: 'queue_unavailable' });
    res.json(await invoiceQueue.retry(req.params.id));
});

app.post('/invoicing/jobs/:id/cancel', requireApiKey, async (req, res) => {
    if (!invoiceQueue) return res.status(503).json({ error: 'queue_unavailable' });
    const result = await invoiceQueue.cancel(req.params.id);
    if (result.ok && idempotency) {
        await idempotency.update(req.params.id, { status: 'cancelled' }).catch(() => {});
        await idempotency.appendAudit(req.params.id, 'manually_cancelled', 'admin').catch(() => {});
    }
    res.json(result);
});

// Manual mode: panel triggers send for an existing draft
app.post('/invoicing/draft/:id/send', requireApiKey, async (req, res) => {
    if (!invoiceQueue || !idempotency) return res.status(503).json({ error: 'lifecycle_unavailable' });
    try {
        const doc = await idempotency.getById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'not_found' });
        if (doc.status === 'sent') return res.status(409).json({ error: 'already_sent' });

        await idempotency.update(req.params.id, { status: 'queued' });
        const job = await invoiceQueue.add({
            documentId: req.params.id,
            tenantId: doc.tenantId,
            sourceTransferId: doc.sourceId,
        });
        await idempotency.appendAudit(req.params.id, 'manually_queued', req.body.by || 'panel');
        res.json({ ok: true, jobId: job.id });
    } catch (e) {
        res.status(500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

// Graceful shutdown
async function shutdown() {
    console.log('[invoicing-engine] Graceful shutdown...');
    if (stockListener) stockListener.stop();
    if (invoiceWorker) await invoiceWorker.close().catch(() => {});
    if (invoiceQueue) await invoiceQueue.close().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------- 404 ----------------

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// ---------------- Boot ----------------

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('================================================================================');
    console.log(`  YEMIGO INVOICING ENGINE v${require('./package.json').version}`);
    console.log('================================================================================');
    console.log(`  Port: ${PORT}`);
    console.log(`  Firebase: ${firebaseInitialized ? 'ready' : 'DISABLED'}`);
    console.log(`  Vault:    ${vault ? 'ready' : 'DISABLED (INVOICING_AES_MASTER_KEY missing)'}`);
    console.log(`  Redis:    ${isRedisAvailable() ? 'connected' : 'memory fallback'}`);
    console.log(`  ApiKey:   ${INVOICING_API_KEY ? 'set' : 'NOT SET — protected endpoints will 500'}`);
    console.log('================================================================================');
});
