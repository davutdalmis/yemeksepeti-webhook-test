try { require('dotenv').config(); } catch (e) { }

const express = require('express');

const { admin, db, firebaseInitialized } = require('@yemigo/shared/firestore-admin');
const { getRedisClient, isRedisAvailable, getRedisStatus, MemoryFallback } = require('@yemigo/shared/redis-client');
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
const { ApprovalProcessor, ApprovalError } = require('./lib/ApprovalProcessor');

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
// Init iki aşamalı:
//   1. ApprovalProcessor (Plan 28) — sadece Firestore + provider gerektirir, Redis bağımsız.
//   2. Queue/Worker/Listener (Plan 27) — BullMQ gerçek Redis ister. ioredis async bağlanır,
//      bu yüzden ready event'ini bekleriz. Ready gelmeden önce gelen istekler 503 alır
//      (endpoint guard'ları doğal olarak null-check yapıyor).

let idempotency = null;
let rateLimiter = null;
let invoiceQueue = null;
let invoiceWorker = null;
let stockListener = null;
let approvalProcessor = null;

async function waitForRedisReady(redisClient, timeoutMs = 15000) {
    if (redisClient instanceof MemoryFallback) return false;
    if (redisClient.status === 'ready') return true;
    return await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        const onReady = () => { clearTimeout(t); resolve(true); };
        redisClient.once('ready', onReady);
    });
}

async function initRedisDependentLifecycle() {
    if (rateLimiter) return; // already inited
    rateLimiter = new RateLimiter({ redis });
    try {
        invoiceQueue = new InvoiceQueue({ connection: redis });
    } catch (e) {
        console.warn('[invoicing-engine] InvoiceQueue init skipped:', e.message);
        return;
    }
    if (!invoiceQueue || !invoiceQueue.available) {
        console.warn('[invoicing-engine] InvoiceQueue unavailable; worker/listener skipped');
        return;
    }

    invoiceWorker = new InvoiceWorker({
        connection: redis,
        idempotency,
        tokenManager,
        rateLimiter,
        providerFactory,
        tenantSettingsLoader: buildInvoiceContext,
    });

    if (process.env.INVOICING_LISTENER_ENABLED === 'true') {
        stockListener = new StockTransferListener({
            db,
            idempotency,
            queue: invoiceQueue,
            settingsLoader: loadParasutSettings,
            // Plan 28+: listener'a Parasut taslak yazma yetenegi.
            // Default acik; INVOICING_PARASUT_DRAFT_DISABLED=true ile devre disi birakilabilir
            // (dev/staging icin).
            providerFactory: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : providerFactory,
            tokenManager: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : tokenManager,
            contextLoader: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : buildInvoiceContext,
        });
        stockListener.start();
        const draftMode = process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? 'firestore-only' : 'parasut-draft-enabled';
        console.log(`[invoicing-engine] Plan 27 lifecycle ready (queue+worker+listener active, draft mode: ${draftMode})`);
    } else {
        console.log('[invoicing-engine] Plan 27 lifecycle ready (queue+worker active; listener disabled, set INVOICING_LISTENER_ENABLED=true)');
    }
}

async function initLifecycle() {
    if (!firebaseInitialized || !db) {
        console.log('[invoicing-engine] Lifecycle DISABLED (Firebase not available)');
        return;
    }
    idempotency = new IdempotencyService({ db });

    // Plan 28: ApprovalProcessor — Redis gerektirmez
    approvalProcessor = new ApprovalProcessor({
        db,
        idempotency,
        tokenManager,
        providerFactory,
        contextLoader: buildInvoiceContext,
    });
    console.log('[invoicing-engine] ApprovalProcessor ready (Plan 28)');

    // Plan 27: BullMQ queue/worker/listener — gerçek Redis bekler
    if (redis instanceof MemoryFallback) {
        console.log('[invoicing-engine] Plan 27 lifecycle DISABLED (Redis fallback to memory; BullMQ requires real Redis)');
        return;
    }

    const ready = await waitForRedisReady(redis);
    if (!ready) {
        console.warn('[invoicing-engine] Plan 27 lifecycle DEFERRED (Redis not ready within 15s) — will init on next ready event');
        redis.once('ready', () => {
            initRedisDependentLifecycle().catch((e) =>
                console.error('[invoicing-engine] deferred lifecycle init error:', e.message),
            );
        });
        return;
    }

    await initRedisDependentLifecycle();
}

initLifecycle().catch((e) => console.error('[invoicing-engine] initLifecycle error:', e.message));

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

// Plan 28: panel saves owner-edited line items + diffReason for an existing draft.
// status: draft|pending_approval -> pending_approval; idempotent on repeated saves.
const { validateTransition } = require('./lib/StatusTransitionValidator');

app.post('/invoicing/draft/:id/save-edits', requireApiKey, async (req, res) => {
    if (!idempotency) return res.status(503).json({ error: 'lifecycle_unavailable' });
    try {
        const { tenantId, edits, editedBy, note } = req.body || {};
        if (!tenantId) return res.status(400).json({ error: 'missing_tenantId' });
        if (!Array.isArray(edits)) return res.status(400).json({ error: 'edits_not_array' });

        const doc = await idempotency.getById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'not_found' });
        if (doc.tenantId !== tenantId) return res.status(403).json({ error: 'tenant_mismatch' });

        const transition = validateTransition(doc.status, 'pending_approval');
        if (!transition.ok) {
            return res.status(409).json({ error: 'invalid_transition', from: doc.status, reason: transition.reason });
        }

        // Item-level validation: finalQty in [0, originalQty], itemIndex valid.
        const itemsByIdx = new Map((doc.items || []).map((it) => [it.itemIndex, it]));
        const cleanEdits = [];
        let fireTotal = 0;
        for (const e of edits) {
            const idx = Number(e.itemIndex);
            const original = itemsByIdx.get(idx);
            if (!original) {
                return res.status(400).json({ error: 'unknown_itemIndex', itemIndex: idx });
            }
            const finalQty = Number(e.finalQty);
            if (!Number.isFinite(finalQty) || finalQty < 0 || finalQty > original.originalQuantity) {
                return res.status(400).json({
                    error: 'finalQty_out_of_range',
                    itemIndex: idx,
                    originalQuantity: original.originalQuantity,
                    received: finalQty,
                });
            }
            const diffReason = ['fire', 'iade', 'duzeltme'].includes(e.diffReason) ? e.diffReason : undefined;
            cleanEdits.push({
                itemIndex: idx,
                productId: original.productId,
                originalQty: original.originalQuantity,
                finalQty,
                diffReason,
                note: typeof e.note === 'string' ? e.note.slice(0, 500) : undefined,
            });
            const diff = original.originalQuantity - finalQty;
            if (diff > 0 && diffReason === 'fire') fireTotal += diff;
        }

        await idempotency.update(req.params.id, {
            status: 'pending_approval',
            approvalMeta: {
                edits: cleanEdits,
                fireQuantityTotal: fireTotal,
                lastEditedAt: Date.now(),
                lastEditedBy: editedBy || 'panel',
            },
        });
        await idempotency.appendAudit(req.params.id, 'edited', editedBy || 'panel', {
            editsCount: cleanEdits.length,
            fireTotal,
            note: note ? String(note).slice(0, 500) : undefined,
        });

        res.json({ ok: true, status: 'pending_approval', edits: cleanEdits, fireQuantityTotal: fireTotal });
    } catch (e) {
        console.error('[invoicing-engine] save-edits error:', e.message);
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

// Plan 28 Faz 3: atomik onay — Paraşüt createInvoice (e_archive) + Firestore transaction.
// Body: { tenantId, approvedBy, edits?, fireRecords? }
// edits: [{ itemIndex, finalQty, diffReason? }] — opsiyonel; verilmezse approvalMeta'dakini kullanır.
// approvalProcessor initLifecycle() içinde init edilir.
app.post('/invoicing/draft/:id/approve', requireApiKey, async (req, res) => {
    if (!approvalProcessor) {
        return res.status(503).json({ error: 'approval_processor_unavailable', message: 'firebase or idempotency not initialized' });
    }
    try {
        const result = await approvalProcessor.approve(req.params.id, req.body || {});
        res.json(result);
    } catch (e) {
        if (e instanceof ApprovalError) {
            return res.status(e.status || 500).json({
                error: e.code || 'approval_error',
                message: e.message,
                ...(e.payload ? { payload: e.payload } : {}),
            });
        }
        console.error('[invoicing-engine] approve unexpected error:', e);
        res.status(500).json({ error: 'internal_error', message: e.message });
    }
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
