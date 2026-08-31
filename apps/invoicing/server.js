try { require('dotenv').config(); } catch (e) { }

const express = require('express');

const { admin, db, firebaseInitialized } = require('@yemigo/shared/firestore-admin');
const { getRedisClient, isRedisAvailable, getRedisStatus, MemoryFallback } = require('@yemigo/shared/redis-client');
const { initSentry } = require('@yemigo/shared/sentry-init');

const ParasutProvider = require('./providers/ParasutProvider');
const UyumsoftProvider = require('./providers/UyumsoftProvider');
const ParasutInboxProvider = require('./providers/ParasutInboxProvider');
const { InboxInvoiceService } = require('./lib/InboxInvoiceService');
const { runCloseCycle, MIN_AGE_HOURS } = require('./lib/ProductionOrderCloser');
const TokenManager = require('./auth/TokenManager');
const CredentialVault = require('./secrets/CredentialVault');
const { InvoiceProviderError } = require('./providers/IInvoiceProvider');
const { IdempotencyService } = require('./lib/IdempotencyService');
const RateLimiter = require('./lib/RateLimiter');
const ProviderRefCache = require('./lib/ProviderRefCache');
const { InvoiceQueue } = require('./queue/InvoiceQueue');
const InvoiceWorker = require('./workers/InvoiceWorker');
const StockTransferListener = require('./listeners/StockTransferListener');
const ProductionOrderListener = require('./listeners/ProductionOrderListener');
const { ApprovalProcessor, ApprovalError } = require('./lib/ApprovalProcessor');
const { ShipmentProcessor, ShipmentError } = require('./lib/ShipmentProcessor');

initSentry({ dsn: process.env.SENTRY_DSN, service: 'invoicing-engine' });

const app = express();
app.use(express.json({ limit: '2mb' }));

const INVOICING_API_KEY = process.env.INVOICING_API_KEY || '';

// Plan 30 (sahip kararı 2026-07-20) — stok tetiği İRSALİYE ONAYI; görünürlük logları.
const { invoicingStockWritesEnabled } = require('./lib/stockWritesFlag');
const { canonicalStockEnabled } = require('./lib/CanonicalStockWriter');
console.log(
    canonicalStockEnabled()
        ? '[invoicing] KANONİK STOK AÇIK — irsaliye onayı branchStocks/stockMovements yazar (imalat − / şube +). UYARI: production-domain FEATURE_TRANSFER_STOCK_MOVE KAPALI olmalı (çifte sayım)!'
        : '[invoicing] KANONİK STOK KAPALI (INVOICING_CANONICAL_STOCK_DISABLED=true) — irsaliye onayı stok YAZMAZ',
);
if (invoicingStockWritesEnabled()) {
    console.log('[invoicing] UYARI: legacy INVOICING_STOCK_WRITES=ON — görünmez defter (branchInventory/inventoryMovements) de yazılıyor. Normalde kapalı olmalı.');
}
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

// Plan 27 5.1.1 — MASTER kill-switch: tenants/{id}.features.parasut_isEnabled.
// Admin panel (/admin/parasut-tenants) yönetir. false/eksik/okunamadı → KAPALI (fail-safe).
// Not: test-connection bilerek muaf — rollout Kapı 0'da önce bağlantı test edilir,
// master flag sonra açılır (PARASUT_ROLLOUT_CHECKLIST.md).
async function isParasutMasterFlagEnabled(tenantId) {
    try {
        if (!firebaseInitialized || !db) return false;
        const snap = await db.collection('tenants').doc(tenantId).get();
        return snap.exists && snap.data()?.features?.parasut_isEnabled === true;
    } catch (e) {
        console.warn(`[invoicing-engine] master flag read failed for ${tenantId}: ${e.message}`);
        return false;
    }
}

// Belge-id'li uçlar için guard: invoiceDocuments/{id} → tenantId → master flag.
// Kapalıysa 409 yazar ve null döner; açıksa dokümanın tenantId'sini döner.
async function requireMasterFlagForDoc(req, res) {
    const docId = req.params.id;
    const snap = await db.collection('invoiceDocuments').doc(docId).get();
    if (!snap.exists) {
        res.status(404).json({ error: 'not_found' });
        return null;
    }
    const tenantId = snap.data().tenantId;
    if (!(await isParasutMasterFlagEnabled(tenantId))) {
        res.status(409).json({
            error: 'master_flag_disabled',
            message: `Parasut master flag kapalı (tenants/${tenantId}.features.parasut_isEnabled) — admin panelden açılmalı`,
        });
        return null;
    }
    return tenantId;
}

// 2026-07-29: Parasut isim->ID onbellegi. initLifecycle() icinde (db hazir olunca)
// atanir; atanmazsa provider eski davranisiyla calisir.
let providerRefCache = null;

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
        // 2026-07-29: isim->Parasut ID onbellegi. Firestore hazir degilse null kalir
        // ve provider eski davranisina (her cagri arama) doner.
        refCache: providerRefCache,
        tenantId,
        // Istek-basina hiz limiti (10/10 sn). Redis hazir degilse null kalir.
        rateLimiter,
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
            // Plan 28+/Plan 28++: belge tipi ayri ayri kontrol.
            invoiceDraftMode = 'enabled',
            shipmentMode = 'disabled',
            // Plan 28+++: imalat (gonderici) bilgileri - e-Irsaliye sevk cikis adresi
            manufacturerName = '',
            manufacturerTaxNumber = '',
            manufacturerTaxOffice = '',
            manufacturerAddress = '',
            manufacturerCity = '',
            manufacturerDistrict = '',
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
            // Plan 28++++: 'auto' → ApprovalProcessor VKN'ye göre e_invoice/e_archive seçer.
            // Bilinmeyen değer → 'sales_invoice' (geriye uyumlu fallback).
            defaultDocumentType: ['sales_invoice', 'e_archive', 'e_invoice', 'auto'].includes(defaultDocumentType) ? defaultDocumentType : 'sales_invoice',
            defaultVatRate,
            invoiceSeriesPrefix,
            shipmentIncludedDefault: !!shipmentIncludedDefault,
            invoiceDraftMode: ['enabled', 'disabled'].includes(invoiceDraftMode) ? invoiceDraftMode : 'enabled',
            shipmentMode: ['disabled', 'manual', 'auto'].includes(shipmentMode) ? shipmentMode : 'disabled',
            manufacturerName: String(manufacturerName || ''),
            manufacturerTaxNumber: String(manufacturerTaxNumber || ''),
            manufacturerTaxOffice: String(manufacturerTaxOffice || ''),
            manufacturerAddress: String(manufacturerAddress || ''),
            manufacturerCity: String(manufacturerCity || ''),
            manufacturerDistrict: String(manufacturerDistrict || ''),
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

// Test sonucunu kalıcı yaz — panel "✓ Bağlı / son doğrulama" rozetini buradan okur.
// Yalnız mevcut credentials dokümanına merge edilir (yoksa hayalet doküman açılmaz).
// Sır içermez; hata olursa test yanıtını etkilemez.
async function persistConnectionStatus(tenantId, patch) {
    try {
        if (!firebaseInitialized || !db) return;
        const ref = db.collection('invoicingCredentials').doc(tenantId).collection('providers').doc('parasut');
        const snap = await ref.get();
        if (!snap.exists) return;
        await ref.set({ ...patch, lastVerifiedAt: Date.now() }, { merge: true });
    } catch (e) {
        console.warn('[invoicing-engine] connection status persist failed:', e.message);
    }
}

app.post('/invoicing/test-connection', requireApiKey, async (req, res) => {
    try {
        const { tenantId } = req.body || {};
        if (!tenantId) return res.status(400).json({ error: 'missing_tenantId' });

        const provider = await providerFactory(tenantId);
        const token = await tokenManager.getValidToken(tenantId);
        const ping = await provider.ping(token);

        if (ping.ok) {
            await persistConnectionStatus(tenantId, {
                lastConnectionStatus: 'ok',
                lastVerifiedCompany: ping.company?.name || null,
                lastVerifyError: null,
            });
            return res.json({ ok: true, provider: provider.providerName, parasutCompany: ping.company });
        }
        await persistConnectionStatus(tenantId, {
            lastConnectionStatus: 'failed',
            lastVerifyError: ping.error || 'ping_failed',
        });
        return res.status(502).json({ ok: false, error: ping.error || 'ping_failed', code: ping.code });
    } catch (e) {
        console.error('[invoicing-engine] test-connection error:', e.message);
        if (req.body?.tenantId) {
            await persistConnectionStatus(req.body.tenantId, {
                lastConnectionStatus: 'failed',
                lastVerifyError: e.message || String(e.code || 'internal_error'),
            });
        }
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
        // Panel /settings/parasut master-flag uyarısı bunu bekler (data.featureEnabled).
        const featureEnabled = await isParasutMasterFlagEnabled(req.params.tenantId);
        res.json({ ok: true, tenantId: req.params.tenantId, featureEnabled, settings: safe });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

// ---------------- Paraşüt 'person' contacts (driver candidates) ----------------

app.get('/invoicing/parasut/:tenantId/contacts/persons', requireApiKey, async (req, res) => {
    try {
        const { tenantId } = req.params;
        if (!tenantId) return res.status(400).json({ error: 'missing_tenantId' });

        const provider = await providerFactory(tenantId);
        const token = await tokenManager.getValidToken(tenantId);
        const contacts = await provider.listPersonContacts(token, { limit: 200 });
        res.json({ ok: true, count: contacts.length, contacts });
    } catch (e) {
        console.error('[invoicing-engine] persons contacts error:', e.message);
        const status = e.status || (e instanceof InvoiceProviderError && e.status) || 500;
        res.status(status).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

// ---------------- GELEN e-fatura (inbox) uclari (2026-08-03; Parasut 2026-08-31) ----------------
// Akis: sync -> incomingInvoices -> panel onay -> INVOICE_ENTRY stok girisi.
// Panel bu uclara admin CF invoicingProxy uzerinden erisir (statik export, API route yok).
//
// Saglayici artik TENANT BASINA secilir (2026-08-31). Onceden Uyumsoft sabit kodluydu;
// Parasut kullanan tenant'ta gelen kutusu akisi hic calisamiyordu.

const UYUMSOFT_ENCRYPTED_FIELDS = ['username', 'password'];
const PARASUT_ENCRYPTED_FIELDS = ['clientId', 'clientSecret', 'username', 'password'];
// Secim sirasi: tenant'in acikca yazdigi inboxProvider > uyumsoft > parasut.
// Uyumsoft'un onde olmasi BILINCLIDIR: daha once Uyumsoft ile kurulmus bir tenant'ta
// davranis degismesin — o tenant'lar icin akis birebir eskisi gibi kalir.
const INBOX_PROVIDER_ORDER = ['uyumsoft', 'parasut'];

/**
 * Tenant icin kullanilacak gelen-kutusu saglayicisini ve ayarlarini bulur.
 * @returns {Promise<{provider:string, settings:object, ref:object}>}
 */
async function loadInboxProviderSettings(tenantId) {
    if (!firebaseInitialized || !db) {
        throw new Error('Firestore not initialized — cannot load tenant settings');
    }
    const root = db.collection('invoicingCredentials').doc(tenantId);

    let preferred = '';
    try {
        const rootSnap = await root.get();
        preferred = rootSnap.exists ? String((rootSnap.data() || {}).inboxProvider || '') : '';
    } catch (e) {
        preferred = '';
    }
    const order = preferred && INBOX_PROVIDER_ORDER.includes(preferred)
        ? [preferred, ...INBOX_PROVIDER_ORDER.filter((p) => p !== preferred)]
        : INBOX_PROVIDER_ORDER;

    const disabled = [];
    for (const name of order) {
        const snap = await root.collection('providers').doc(name).get();
        if (!snap.exists) continue;
        const settings = snap.data() || {};
        if (settings.isEnabled === false) { disabled.push(name); continue; }
        return { provider: name, settings, ref: snap.ref };
    }
    if (disabled.length > 0) {
        const err = new Error(`Inbox integration disabled for tenant "${tenantId}" (${disabled.join(', ')})`);
        err.code = 'TENANT_DISABLED';
        err.status = 409;
        throw err;
    }
    const err = new Error(`No inbox provider settings for tenant "${tenantId}"`);
    err.code = 'TENANT_SETTINGS_MISSING';
    err.status = 404;
    throw err;
}

async function inboxProviderFactory(tenantId) {
    if (!vault) throw new Error('CredentialVault not initialized (INVOICING_AES_MASTER_KEY missing)');
    const { provider, settings } = await loadInboxProviderSettings(tenantId);

    if (provider === 'parasut') {
        if (!settings.companyId) {
            const err = new Error(`Parasut companyId missing for tenant "${tenantId}"`);
            err.code = 'TENANT_SETTINGS_MISSING';
            err.status = 404;
            throw err;
        }
        const d = vault.decryptFields(settings, PARASUT_ENCRYPTED_FIELDS, tenantId);
        return new ParasutInboxProvider({
            clientId: d.clientId,
            clientSecret: d.clientSecret,
            username: d.username,
            password: d.password,
            companyId: settings.companyId,
            baseUrl: settings.baseUrl || undefined,
        });
    }

    const d = vault.decryptFields(settings, UYUMSOFT_ENCRYPTED_FIELDS, tenantId);
    return new UyumsoftProvider({
        username: d.username,
        password: d.password,
        baseUrl: settings.baseUrl || undefined,
    });
}

const inboxService = (firebaseInitialized && db)
    ? new InboxInvoiceService({
        db,
        Timestamp: admin.firestore.Timestamp,
        providerFactory: inboxProviderFactory,
    })
    : null;

function requireInbox(res) {
    if (!inboxService) {
        res.status(500).json({ error: 'firestore_not_initialized' });
        return false;
    }
    return true;
}

function inboxErrorStatus(e) {
    return e.status || (e instanceof InvoiceProviderError && e.status) || 500;
}

/** Uyumsoft kimlik kaydi — Parasut credentials ile ayni vault deseni. */
app.post('/invoicing/inbox/credentials', requireApiKey, async (req, res) => {
    try {
        if (!vault) return res.status(500).json({ error: 'vault_not_initialized' });
        if (!firebaseInitialized || !db) return res.status(500).json({ error: 'firestore_not_initialized' });
        const { tenantId, username, password, isEnabled = true, updatedBy = 'panel' } = req.body || {};
        if (!tenantId || !username || !password) {
            return res.status(400).json({ error: 'missing_fields', required: ['tenantId', 'username', 'password'] });
        }
        const encrypted = vault.encryptFields({ username, password }, UYUMSOFT_ENCRYPTED_FIELDS, tenantId);
        const ref = db.collection('invoicingCredentials').doc(tenantId).collection('providers').doc('uyumsoft');
        await ref.set({
            ...encrypted,
            provider: 'uyumsoft',
            isEnabled: !!isEnabled,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: String(updatedBy),
        }, { merge: true });
        res.json({ ok: true, tenantId, provider: 'uyumsoft', isEnabled: !!isEnabled });
    } catch (e) {
        console.error('[invoicing-engine] uyumsoft credentials write error:', e);
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

/** Uyumsoft baglanti testi (1 kayitlik liste sorgusu). Sonuc rozet icin kalici yazilir. */
app.post('/invoicing/inbox/test-connection', requireApiKey, async (req, res) => {
    try {
        const { tenantId } = req.body || {};
        if (!tenantId) return res.status(400).json({ error: 'missing_tenantId' });
        const { provider: providerName, ref: providerRef } = await loadInboxProviderSettings(tenantId);
        const provider = await inboxProviderFactory(tenantId);
        const ping = await provider.ping();
        try {
            const ref = providerRef;
            await ref.set({
                lastConnectionStatus: ping.ok ? 'ok' : 'failed',
                lastVerifyError: ping.ok ? null : (ping.error || 'ping_failed'),
                lastVerifiedAt: Date.now(),
            }, { merge: true });
        } catch (persistErr) {
            console.warn('[invoicing-engine] uyumsoft status persist failed:', persistErr.message);
        }
        if (ping.ok) return res.json({ ok: true, provider: providerName, totalInboxCount: ping.totalCount });
        return res.status(502).json({ ok: false, error: ping.error || 'ping_failed' });
    } catch (e) {
        console.error('[invoicing-engine] uyumsoft test-connection error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** Maskeli Uyumsoft ayarlari (panel form doldurma + rozet). */
app.get('/invoicing/inbox/:tenantId/settings', requireApiKey, async (req, res) => {
    try {
        const { provider, settings } = await loadInboxProviderSettings(req.params.tenantId);
        const safe = {};
        for (const [k, v] of Object.entries(settings)) {
            safe[k] = k.startsWith('encrypted') ? '****' : v;
        }
        res.json({ ok: true, tenantId: req.params.tenantId, provider, settings: safe });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.code || 'internal_error', message: e.message });
    }
});

/** Gelen kutusu senkronu -> incomingInvoices (yalniz yeni dokumanlar yazilir). */
app.post('/invoicing/inbox/:tenantId/sync', requireApiKey, async (req, res) => {
    try {
        if (!requireInbox(res)) return;
        const { createStartDate, createEndDate, days } = req.body || {};
        // Tarih verilmezse son 30 gun taranir. Penceresiz senkron tum gecmisi
        // (bu tenant'ta 6000+ belge) gelen kutusuna dokerdi ve maxPages tavani
        // sessizce devreye girerdi. Gerekirse body.days ile genisletilir.
        const lookbackDays = Number(days) > 0 ? Math.min(Number(days), 365) : 30;
        const startDate = createStartDate
            || new Date(Date.now() - (lookbackDays * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
        const r = await inboxService.syncInbox({
            tenantId: req.params.tenantId,
            createStartDate: startDate,
            createEndDate,
        });
        res.json(r);
    } catch (e) {
        console.error('[invoicing-engine] inbox sync error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** incomingInvoices listesi (panel tablo). Bellekte siralanir — composite index gerekmez. */
app.get('/invoicing/inbox/:tenantId/list', requireApiKey, async (req, res) => {
    try {
        if (!requireInbox(res)) return;
        let q = db.collection('incomingInvoices').where('tenantId', '==', req.params.tenantId);
        if (req.query.status) q = q.where('status', '==', String(req.query.status));
        const snap = await q.limit(500).get();
        const items = snap.docs
            .map((d) => {
                const { parsed, ...rest } = d.data();
                return { ...rest, hasLines: !!parsed };
            })
            .sort((a, b) => String(b.invoiceCreateDateUtc).localeCompare(String(a.invoiceCreateDateUtc)));
        res.json({ ok: true, count: items.length, items });
    } catch (e) {
        console.error('[invoicing-engine] inbox list error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** UBL cek + parse + eslesme onerileri (detay ekrani). */
app.post('/invoicing/inbox/:tenantId/:invoiceId/lines', requireApiKey, async (req, res) => {
    try {
        if (!requireInbox(res)) return;
        const r = await inboxService.loadInvoiceLines({
            tenantId: req.params.tenantId,
            invoiceId: req.params.invoiceId,
            force: req.body && req.body.force === true,
        });
        res.json({ ok: true, invoice: r });
    } catch (e) {
        console.error('[invoicing-engine] inbox lines error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** Fatura PDF onizleme (base64). */
app.get('/invoicing/inbox/:tenantId/:invoiceId/pdf', requireApiKey, async (req, res) => {
    try {
        const provider = await inboxProviderFactory(req.params.tenantId);
        const r = await provider.getInboxInvoicePdf(req.params.invoiceId);
        res.json({ ok: true, invoiceId: r.invoiceId, pdfBase64: r.pdfBase64 });
    } catch (e) {
        console.error('[invoicing-engine] inbox pdf error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** Sube onayi -> INVOICE_ENTRY stok girisi + (ticari faturada) Uyumsoft Approve. */
app.post('/invoicing/inbox/:tenantId/:invoiceId/approve', requireApiKey, async (req, res) => {
    try {
        if (!requireInbox(res)) return;
        const { branchId, items, approvedBy } = req.body || {};
        const r = await inboxService.approveInvoice({
            tenantId: req.params.tenantId,
            invoiceId: req.params.invoiceId,
            branchId,
            items,
            approvedBy,
        });
        res.json(r);
    } catch (e) {
        console.error('[invoicing-engine] inbox approve error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
    }
});

/** Red — stok yazilmaz; (ticari faturada) Uyumsoft Decline. */
app.post('/invoicing/inbox/:tenantId/:invoiceId/decline', requireApiKey, async (req, res) => {
    try {
        if (!requireInbox(res)) return;
        const { reason, declinedBy } = req.body || {};
        const r = await inboxService.declineInvoice({
            tenantId: req.params.tenantId,
            invoiceId: req.params.invoiceId,
            reason,
            declinedBy,
        });
        res.json(r);
    } catch (e) {
        console.error('[invoicing-engine] inbox decline error:', e.message);
        res.status(inboxErrorStatus(e)).json({ ok: false, error: e.code || 'internal_error', message: e.message });
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
let productionOrderListener = null;
let approvalProcessor = null;
let shipmentProcessor = null;

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
    // Parasut'un belgelenmis limiti: 10 istek / 10 saniye (swagger "Genel Bilgiler").
    // Eski sabit 60/60 sn hem yanlis hem de tehlikeliydi: kayan pencere t=0'da
    // 60 istegin tamamina aninda izin veriyordu.
    // Bu ayni limiter iki yerde kullanilir:
    //   - InvoiceWorker: is basina kaba kabul kapisi (eskiden tek koruma buydu)
    //   - ParasutProvider._get/_post/_put/_delete: HER istek icin jeton (asil koruma)
    // Ikisi ust uste binerek biraz fazla sayar; bu bilincli ve guvenli yondedir.
    rateLimiter = new RateLimiter({
        redis,
        limit: Number(process.env.PARASUT_RATE_LIMIT) || 10,
        windowSec: Number(process.env.PARASUT_RATE_WINDOW_SEC) || 10,
    });
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
            // Plan 27 5.1.1: master kill-switch — kapalıysa yeni shipped transferler işlenmez.
            masterFlagLoader: isParasutMasterFlagEnabled,
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

    // 2026-07-29 (429 olayi): kimlik cozumleme isteklerini eleyen kalici onbellek.
    // providerFactory bunu ParasutProvider'a enjekte eder.
    providerRefCache = new ProviderRefCache({ db });
    console.log('[invoicing-engine] ProviderRefCache ready (Parasut ref cache)');

    // Plan 28: ApprovalProcessor — Redis gerektirmez
    approvalProcessor = new ApprovalProcessor({
        db,
        idempotency,
        tokenManager,
        providerFactory,
        contextLoader: buildInvoiceContext,
    });
    console.log('[invoicing-engine] ApprovalProcessor ready (Plan 28)');

    // Plan 28++: ShipmentProcessor — e-irsaliye akisi (Redis gerektirmez)
    shipmentProcessor = new ShipmentProcessor({
        db,
        idempotency,
        tokenManager,
        providerFactory,
        contextLoader: buildInvoiceContext,
    });
    console.log('[invoicing-engine] ShipmentProcessor ready (Plan 28++)');

    // Plan 29: sipariş-anı irsaliye taslağı — Redis/queue GEREKTIRMEZ, Firestore yeter.
    // WPF imalat siparişi (productionOrders, status=PENDING) oluştuğu anda shipment DRAFT
    // yaratır; kurye zimmeti beklenmez. StockTransferListener'ın shipped akışı aynı
    // orderNumber için ikinci taslak üretmez (çift-taslak önleme).
    if (process.env.INVOICING_LISTENER_ENABLED === 'true') {
        productionOrderListener = new ProductionOrderListener({
            db,
            idempotency,
            settingsLoader: loadParasutSettings,
            providerFactory: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : providerFactory,
            tokenManager: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : tokenManager,
            contextLoader: process.env.INVOICING_PARASUT_DRAFT_DISABLED === 'true' ? null : buildInvoiceContext,
            masterFlagLoader: isParasutMasterFlagEnabled,
        });
        productionOrderListener.start();
        console.log('[invoicing-engine] Plan 29 ProductionOrderListener ready (order-time shipment drafts)');
    }

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
    } else if (doc.sourceType === 'productionOrder' && doc.sourceId) {
        // Plan 29: sipariş-anı taslakları. Kalemler productionOrders.items'tan gelir
        // ({productId, productName, quantity, unit, unitPrice}) — aşağıdaki miktar
        // öncelik zinciri shipped/approved/requested alanlarını bulamayınca düz
        // `quantity`ye düşer, sipariş kalemleri için doğru olan da bu.
        const snap = await db.collection('productionOrders').doc(doc.sourceId).get();
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
        // stockTransfers kalemleri miktarı shippedQuantity/approvedQuantity/requestedQuantity
        // alanlarında taşır (StockTransferListener snapshot'ı ile aynı öncelik) — düz `quantity`
        // çoğu transferde yok; eski `|| 1` fallback'i miktarı sessizce 1'e düşürüyordu.
        quantity: Number(
            it.shippedQuantity != null ? it.shippedQuantity :
            it.approvedQuantity != null ? it.approvedQuantity :
            it.requestedQuantity != null ? it.requestedQuantity :
            it.quantity || 1
        ),
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
        description: sourceData ? `Sevkiyat: ${sourceData.transferNumber || sourceData.orderNumber || sourceData.code || doc.sourceId}` : '',
        invoiceSeriesPrefix: settings.invoiceSeriesPrefix || 'A',
        // Plan 28++++ Görev B: e-arşiv internet_sale ctx override (default null → ParasutProvider fallback).
        // Tenant ileride özelleştirebilsin diye settings'ten okur; UI henüz yok.
        internetSale: settings.eArchiveInternetSale || null,
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
            // Firestore undefined kabul etmez — sebep/not seçilmediyse alanı hiç yazma (2026-07-15).
            const entry = {
                itemIndex: idx,
                productId: original.productId,
                originalQty: original.originalQuantity,
                finalQty,
            };
            if (diffReason) entry.diffReason = diffReason;
            if (typeof e.note === 'string' && e.note.length > 0) entry.note = e.note.slice(0, 500);
            cleanEdits.push(entry);
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
            ...(note ? { note: String(note).slice(0, 500) } : {}),
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
        if (!(await requireMasterFlagForDoc(req, res))) return;
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

// ---------------- Plan 28++ Shipment (e-irsaliye) endpoint'leri ----------------

// Manual modda yetkili "İrsaliye Oluştur" basinca: Parasut'a shipment_document POST
app.post('/invoicing/shipment/:id/create', requireApiKey, async (req, res) => {
    if (!shipmentProcessor) {
        return res.status(503).json({ error: 'shipment_processor_unavailable' });
    }
    try {
        if (!(await requireMasterFlagForDoc(req, res))) return;
        const result = await shipmentProcessor.create(req.params.id, req.body || {});
        res.json(result);
    } catch (e) {
        if (e instanceof ShipmentError) {
            return res.status(e.status || 500).json({
                error: e.code || 'shipment_error',
                message: e.message,
                ...(e.payload ? { payload: e.payload } : {}),
            });
        }
        console.error('[invoicing-engine] shipment create unexpected error:', e);
        res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// Yetkili kalem duzenleme (eksik fire vb.) — Parasut update + Firestore approvalMeta
app.post('/invoicing/shipment/:id/save-edits', requireApiKey, async (req, res) => {
    if (!shipmentProcessor) {
        return res.status(503).json({ error: 'shipment_processor_unavailable' });
    }
    try {
        const result = await shipmentProcessor.saveEdits(req.params.id, req.body || {});
        res.json(result);
    } catch (e) {
        if (e instanceof ShipmentError) {
            return res.status(e.status || 500).json({
                error: e.code || 'shipment_error',
                message: e.message,
                ...(e.payload ? { payload: e.payload } : {}),
            });
        }
        console.error('[invoicing-engine] shipment save-edits unexpected error:', e);
        res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// Yetkili "Onayla" — Firestore transaction (status='sent', inventory, stockTransfer.completed)
app.post('/invoicing/shipment/:id/finalize', requireApiKey, async (req, res) => {
    if (!shipmentProcessor) {
        return res.status(503).json({ error: 'shipment_processor_unavailable' });
    }
    try {
        if (!(await requireMasterFlagForDoc(req, res))) return;
        const result = await shipmentProcessor.finalize(req.params.id, req.body || {});
        res.json(result);
    } catch (e) {
        if (e instanceof ShipmentError) {
            return res.status(e.status || 500).json({
                error: e.code || 'shipment_error',
                message: e.message,
                ...(e.payload ? { payload: e.payload } : {}),
            });
        }
        console.error('[invoicing-engine] shipment finalize unexpected error:', e);
        res.status(500).json({ error: 'internal_error', message: e.message });
    }
});

// Manual mode: panel triggers send for an existing draft
app.post('/invoicing/draft/:id/send', requireApiKey, async (req, res) => {
    if (!invoiceQueue || !idempotency) return res.status(503).json({ error: 'lifecycle_unavailable' });
    try {
        if (!(await requireMasterFlagForDoc(req, res))) return;
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

// ---------------- Gelen kutusu zamanlanmis senkronu (2026-08-31) ----------------
// Railway servisi surekli ayakta oldugu icin zamanlayici motorun icinde; Cloud Scheduler
// gerekmiyor. syncInbox idempotenttir (var olan dokumani ASLA ezmez), bu yuzden birden
// fazla replika kosarsa bile zarar vermez — yalniz bosa istek olur.
//
// Acma/kapama ortam degiskeniyle (mevcut INVOICING_LISTENER_ENABLED deseni):
//   INVOICING_INBOX_SYNC_ENABLED=true      zorunlu, varsayilan KAPALI
//   INVOICING_INBOX_SYNC_INTERVAL_MIN=30   tur araligi (dakika)
//   INVOICING_INBOX_SYNC_DAYS=30           geriye bakis penceresi (gun)
//
// Parasut'te suzme alani issue_date'tir (faturanin KESIM tarihi); gec ulasan bir fatura
// dar pencerede kacabilir. 30 gunluk pencere bunu tolere eder, tekrarli tur maliyetsizdir
// cunku var olan dokumanlar 'skipped' sayilir.

let inboxSyncTimer = null;
let inboxSyncRunning = false;

async function runInboxSyncCycle() {
    if (!inboxService || !db) return;
    if (inboxSyncRunning) {
        console.warn('[inbox-sync] onceki tur hala suruyor, bu tur atlandi');
        return;
    }
    inboxSyncRunning = true;
    const days = Number(process.env.INVOICING_INBOX_SYNC_DAYS) > 0
        ? Math.min(Number(process.env.INVOICING_INBOX_SYNC_DAYS), 365)
        : 30;
    const createStartDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    try {
        // listDocuments(): ust dokuman bos olsa bile alt koleksiyonu olan tenant'lari verir.
        const tenants = await db.collection('invoicingCredentials').listDocuments();
        for (const t of tenants) {
            try {
                const r = await inboxService.syncInbox({ tenantId: t.id, createStartDate });
                if (r.created > 0 || r.truncated) {
                    console.log(`[inbox-sync] ${t.id}: ${r.created} yeni fatura, ${r.scanned} belge tarandi${r.truncated ? ' — SAYFA TAVANINA CARPTI' : ''}`);
                }
            } catch (e) {
                // Saglayicisi olmayan/kapali tenant beklenen durum; gurultu yapma.
                if (e.code === 'TENANT_SETTINGS_MISSING' || e.code === 'TENANT_DISABLED') continue;
                console.warn(`[inbox-sync] ${t.id} basarisiz: ${e.code || ''} ${e.message}`);
            }
        }
    } catch (e) {
        console.error('[inbox-sync] tur hatasi:', e.message);
    } finally {
        inboxSyncRunning = false;
    }
}

function startInboxSyncScheduler() {
    if (process.env.INVOICING_INBOX_SYNC_ENABLED !== 'true') {
        console.log('[inbox-sync] KAPALI (INVOICING_INBOX_SYNC_ENABLED != true) — senkron yalniz elle');
        return;
    }
    if (!inboxService) {
        console.warn('[inbox-sync] inboxService yok (Firestore hazir degil) — zamanlayici baslatilmadi');
        return;
    }
    const minutes = Number(process.env.INVOICING_INBOX_SYNC_INTERVAL_MIN) > 0
        ? Number(process.env.INVOICING_INBOX_SYNC_INTERVAL_MIN)
        : 30;
    console.log(`[inbox-sync] ACIK — her ${minutes} dakikada bir gelen kutusu taranacak`);
    // Ilk tur 60 sn gecikmeli: acilista Firestore/Redis baglantilari otursun.
    setTimeout(() => { void runInboxSyncCycle(); }, 60000).unref();
    inboxSyncTimer = setInterval(() => { void runInboxSyncCycle(); }, minutes * 60 * 1000);
}

// ---------------- Irsaliyesi kesilen imalat siparisini kapatma (2026-08-31) ----------------
// Yetkili panelde irsaliyeyi onaylayinca stok hareket ediyordu ama siparis PENDING
// kaliyor, imalat-web "Bugun" sayfasinda birikiyordu (31.08 olcumu: 70 siparis,
// 21 ayri gun, hepsinin irsaliyesi kesilmis).
//
// Neden zamanlayici, neden finalize'in icinde DEGIL: gercek yetkili siparisi ERTESI
// SABAH ~11:00'de onayliyor, uretim daha yapilmadan. Onay aninda kapatmak isi imalatin
// ekranindan gun ortasinda silerdi. Ayrinti + canli saat tablosu: lib/ProductionOrderCloser.js
//
// Acil kapatma: INVOICING_ORDER_CLOSE_DISABLED=true (varsayilan ACIK).
// Tur araligi:  INVOICING_ORDER_CLOSE_INTERVAL_MIN (varsayilan 60 dk)

let orderCloseTimer = null;
let orderCloseRunning = false;

async function runOrderCloseCycle() {
    if (!db) return;
    if (orderCloseRunning) {
        console.warn('[order-close] onceki tur hala suruyor, bu tur atlandi');
        return;
    }
    orderCloseRunning = true;
    try {
        const r = await runCloseCycle(db, { now: Date.now() });
        if (r.closed > 0 || r.errors > 0) {
            console.log(`[order-close] tur bitti: ${r.closed} kapandi, ${r.skipped} atlandi, ${r.errors} hata (${r.scanned} aktif siparis tarandi)`);
        }
    } catch (e) {
        console.error('[order-close] tur hatasi:', e.message);
    } finally {
        orderCloseRunning = false;
    }
}

function startOrderCloseScheduler() {
    if (process.env.INVOICING_ORDER_CLOSE_DISABLED === 'true') {
        console.log('[order-close] KAPALI (INVOICING_ORDER_CLOSE_DISABLED=true)');
        return;
    }
    if (!firebaseInitialized) {
        console.warn('[order-close] Firestore hazir degil — zamanlayici baslatilmadi');
        return;
    }
    const minutes = Number(process.env.INVOICING_ORDER_CLOSE_INTERVAL_MIN) > 0
        ? Number(process.env.INVOICING_ORDER_CLOSE_INTERVAL_MIN)
        : 60;
    console.log(`[order-close] ACIK — her ${minutes} dakikada bir, onayindan ${MIN_AGE_HOURS} saat gecmis irsaliyelerin siparisleri kapatilacak`);
    // Ilk tur 90 sn gecikmeli: acilista Firestore baglantisi otursun.
    setTimeout(() => { void runOrderCloseCycle(); }, 90000).unref();
    orderCloseTimer = setInterval(() => { void runOrderCloseCycle(); }, minutes * 60 * 1000);
}

// Graceful shutdown
async function shutdown() {
    console.log('[invoicing-engine] Graceful shutdown...');
    if (inboxSyncTimer) clearInterval(inboxSyncTimer);
    if (orderCloseTimer) clearInterval(orderCloseTimer);
    if (stockListener) stockListener.stop();
    if (productionOrderListener) productionOrderListener.stop();
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

    startInboxSyncScheduler();
    startOrderCloseScheduler();
});
