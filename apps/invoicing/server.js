try { require('dotenv').config(); } catch (e) { }

const express = require('express');

const { admin, db, firebaseInitialized } = require('@yemigo/shared/firestore-admin');
const { getRedisClient, isRedisAvailable, getRedisStatus } = require('@yemigo/shared/redis-client');
const { initSentry } = require('@yemigo/shared/sentry-init');

const ParasutProvider = require('./providers/ParasutProvider');
const TokenManager = require('./auth/TokenManager');
const CredentialVault = require('./secrets/CredentialVault');
const { InvoiceProviderError } = require('./providers/IInvoiceProvider');

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
