// ==================================================================================
// Plan 27 — Lokal mock E2E demo
// ==================================================================================
// Tum pipeline'i (settings -> stockTransfer -> Listener -> draft -> Worker ->
// MockInvoiceProvider -> invoiceDocuments) tek script'te calistir.
// HIC bir external dep gerektirmez (Firebase yok, Redis yok, Parasut yok).
// Calistirma: cd apps/invoicing && node scripts/local-e2e.js
// ==================================================================================

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { IdempotencyService, buildIdempotencyKey } = require('../lib/IdempotencyService');
const RetryPolicy = require('../lib/RetryPolicy');
const InvoiceWorker = require('../workers/InvoiceWorker');
const StockTransferListener = require('../listeners/StockTransferListener');
const MockInvoiceProvider = require('../providers/MockInvoiceProvider');
const CredentialVault = require('../secrets/CredentialVault');
const TokenManager = require('../auth/TokenManager');

// ==================== ANSI Renkler ====================
const c = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const log = {
    section: (n, t) => console.log(`\n${c.bold}${c.cyan}━━ Adim ${n}: ${t} ${'━'.repeat(Math.max(2, 60 - t.length))}${c.reset}`),
    info:    (m) => console.log(`  ${c.gray}${m}${c.reset}`),
    ok:      (m) => console.log(`  ${c.green}OK${c.reset}  ${m}`),
    warn:    (m) => console.log(`  ${c.yellow}WARN${c.reset} ${m}`),
    err:     (m) => console.log(`  ${c.red}ERR${c.reset}  ${m}`),
    field:   (k, v) => console.log(`       ${c.dim}${k.padEnd(20)}${c.reset} ${c.bold}${v}${c.reset}`),
    arrow:   (m) => console.log(`  ${c.magenta}>>${c.reset}   ${m}`),
};

// ==================== Fake Firestore ====================
function isArrayUnionSentinel(v) {
    if (!v || typeof v !== 'object') return false;
    const ctor = v.constructor && v.constructor.name;
    return ctor === 'ArrayUnionTransform' || '_elements' in v;
}
function isServerTimestampSentinel(v) {
    if (!v || typeof v !== 'object') return false;
    const ctor = v.constructor && v.constructor.name;
    return ctor === 'ServerTimestampTransform';
}
function applyMutate(existing, patch) {
    const out = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
        if (isArrayUnionSentinel(v)) {
            const elements = v._elements || v.elements || [];
            const cur = Array.isArray(out[k]) ? out[k] : [];
            out[k] = [...cur, ...elements];
        } else if (isServerTimestampSentinel(v)) {
            out[k] = Date.now();
        } else {
            out[k] = v;
        }
    }
    return out;
}

class FakeFirestore {
    constructor() {
        this._docs = new Map();      // path -> data
        this._listeners = [];        // { collection, predicate, callback }
    }
    collection(name) { return new FakeCollection(this, name); }
    _docKey(coll, id) { return `${coll}/${id}`; }
    _emit(coll, docId) {
        const key = this._docKey(coll, docId);
        for (const l of this._listeners) {
            if (l.collection !== coll) continue;
            const data = this._docs.get(key);
            if (!data) continue;
            if (l.predicate(data)) {
                queueMicrotask(() => l.fire(docId, data));
            }
        }
    }
}
class FakeCollection {
    constructor(db, name) { this.db = db; this.name = name; this._wheres = []; this._orderBy = null; this._limit = null; }
    doc(id) { return new FakeDocRef(this.db, this.name, id); }
    where(field, op, value) {
        const c = new FakeCollection(this.db, this.name);
        c._wheres = [...this._wheres, { field, op, value }];
        c._orderBy = this._orderBy; c._limit = this._limit;
        return c;
    }
    orderBy(field, dir = 'asc') {
        const c = new FakeCollection(this.db, this.name);
        c._wheres = [...this._wheres]; c._orderBy = { field, dir }; c._limit = this._limit;
        return c;
    }
    limit(n) {
        const c = new FakeCollection(this.db, this.name);
        c._wheres = [...this._wheres]; c._orderBy = this._orderBy; c._limit = n;
        return c;
    }
    onSnapshot(callback, errorCallback) {
        const predicate = (data) => this._wheres.every(w => {
            if (w.op === '==') return data[w.field] === w.value;
            if (w.op === '!=') return data[w.field] !== w.value;
            return true;
        });
        const fire = (docId, data) => {
            const docSnap = {
                id: docId,
                exists: true,
                data: () => data,
                ref: this.doc(docId),
            };
            const change = { type: 'added', doc: docSnap };
            callback({ docChanges: () => [change], forEach: (fn) => fn(docSnap), size: 1 });
        };
        const listener = { collection: this.name, predicate, fire };
        this.db._listeners.push(listener);
        return () => {
            const idx = this.db._listeners.indexOf(listener);
            if (idx >= 0) this.db._listeners.splice(idx, 1);
        };
    }
}
class FakeDocRef {
    constructor(db, coll, id) { this.db = db; this.coll = coll; this.id = id; this.ref = this; }
    async get() {
        const data = this.db._docs.get(this.db._docKey(this.coll, this.id));
        return { exists: !!data, id: this.id, data: () => data };
    }
    async create(data) {
        const key = this.db._docKey(this.coll, this.id);
        if (this.db._docs.has(key)) {
            const e = new Error('already exists'); e.code = 6; throw e;
        }
        this.db._docs.set(key, applyMutate({}, data));
        this.db._emit(this.coll, this.id);
    }
    async set(data, opts) {
        const key = this.db._docKey(this.coll, this.id);
        const existing = this.db._docs.get(key);
        const merged = (opts && opts.merge && existing) ? applyMutate(existing, data) : applyMutate({}, data);
        this.db._docs.set(key, merged);
        this.db._emit(this.coll, this.id);
    }
    async update(data) {
        const key = this.db._docKey(this.coll, this.id);
        const existing = this.db._docs.get(key);
        if (!existing) throw new Error('not found');
        this.db._docs.set(key, applyMutate(existing, data));
        this.db._emit(this.coll, this.id);
    }
    collection(sub) { return new FakeCollection(this.db, `${this.coll}/${this.id}/${sub}`); }
}

// firebase-admin'in arrayUnion / serverTimestamp sentinel'lerini simule et
const originalAdminRequire = require('module').prototype.require;
require('firebase-admin').firestore = Object.assign(require('firebase-admin').firestore || {}, {
    FieldValue: {
        arrayUnion: (...elements) => ({ _elements: elements, constructor: { name: 'ArrayUnionTransform' } }),
        serverTimestamp: () => ({ constructor: { name: 'ServerTimestampTransform' } }),
    },
});

// ==================== Fake Redis (BullMQ-bypass) ====================
class FakeRedis {
    constructor() { this.s = new Map(); }
    async get(k) { return this.s.get(k) || null; }
    async set(k, v, ...flags) {
        const upper = flags.map(f => String(f).toUpperCase());
        if (upper.includes('NX') && this.s.has(k)) return null;
        this.s.set(k, v); return 'OK';
    }
    async setex(k, _ttl, v) { this.s.set(k, v); return 'OK'; }
    async del(k) { return this.s.delete(k) ? 1 : 0; }
    async zadd() { return 1; }
    async zcard() { return 0; }
    async zremrangebyscore() { return 0; }
    async zrange() { return []; }
    async expire() { return 1; }
    duplicate() { return new FakeRedis(); }
}

// ==================== Demo Akisi ====================
async function main() {
    console.log(`\n${c.bold}${c.magenta}╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  Plan 27 — Lokal Mock E2E Demo                              ║`);
    console.log(`║  invoicing-engine pipeline'inin tum kod path'leri            ║`);
    console.log(`║  (HIC external dep yok: Firebase / Redis / Parasut mock)     ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝${c.reset}`);

    const db = new FakeFirestore();
    const redis = new FakeRedis();

    // ----- Adim 1: Vault & TokenManager kur -----
    log.section(1, 'Bagimlilik kur (Vault + TokenManager + Provider factory)');
    const vault = new CredentialVault({ masterKeyHex: 'a'.repeat(64) });
    log.ok('CredentialVault hazir (test master key)');

    const mock = new MockInvoiceProvider({ companyId: 'demo-co' });
    log.ok('MockInvoiceProvider hazir');

    const tokenManager = new TokenManager({
        redis,
        providerFactory: async () => mock,
    });
    log.ok('TokenManager + Redis (in-memory) hazir');

    // ----- Adim 2: Tenant settings'i seed et -----
    log.section(2, 'Tenant Parasut ayarlarini Firestore`a yaz');
    const tenantId = 'demo-tenant';
    const settingsRef = db.collection('invoicingCredentials').doc(tenantId)
        .collection('providers').doc('parasut');
    const encrypted = vault.encryptFields(
        { clientId: 'demo-cid', clientSecret: 'demo-sec', username: 'demo-user', password: 'demo-pw' },
        ['clientId', 'clientSecret', 'username', 'password'],
        tenantId,
    );
    await settingsRef.set({
        ...encrypted,
        companyId: 'demo-co',
        isEnabled: true,
        automationMode: 'auto',  // <-- otomatik mod (sevkiyat cikar cikmaz kes)
        defaultDocumentType: 'sales_invoice',
        defaultVatRate: 20,
        invoiceSeriesPrefix: 'IM',
        shipmentIncludedDefault: true,
        provider: 'parasut',
        updatedAt: Date.now(),
        updatedBy: 'demo',
    });
    log.ok('invoicingCredentials/demo-tenant/providers/parasut yazildi');
    log.field('automationMode', 'auto (otomatik kesim)');
    log.field('isEnabled', 'true');
    log.field('defaultVatRate', '%20');

    // ----- Adim 3: Idempotency + Listener kur -----
    log.section(3, 'IdempotencyService + StockTransferListener baslat');
    const idempotency = new IdempotencyService({ db });
    const fakeQueue = {
        available: true,
        add: async (data) => { log.arrow(`InvoiceQueue.add() cagrildi: ${JSON.stringify(data)}`); return { id: data.documentId }; },
    };
    const listener = new StockTransferListener({
        db,
        idempotency,
        queue: fakeQueue,
        settingsLoader: async (tid) => {
            const snap = await db.collection('invoicingCredentials').doc(tid).collection('providers').doc('parasut').get();
            return snap.data();
        },
    });
    listener.start();
    log.ok('StockTransferListener subscribe edildi (status==shipped, parasutQueued==false)');

    // ----- Adim 4: Test stockTransfer ekle -----
    log.section(4, 'Test stockTransfer dokumanini Firestore`a yaz');
    const transferId = 'TR-DEMO-001';
    await db.collection('stockTransfers').doc(transferId).set({
        tenantId,
        destinationBranchId: 'demo-branch-A',
        transferNumber: 'TRF-2026-0001',
        totalAmount: 2500,
        currency: 'TRL',
        status: 'shipped',           // <-- listener bunu yakalar
        parasutQueued: false,
        items: [
            { productId: 'p1', name: 'Mozzarella 1kg', quantity: 5, unitPrice: 250, vatRate: 20 },
            { productId: 'p2', name: 'Un Tipo 00 25kg', quantity: 2, unitPrice: 625, vatRate: 10 },
        ],
    });
    log.ok(`stockTransfers/${transferId} yazildi (status=shipped, 2 kalem, 2500 TRL)`);

    // Listener async — bekle
    await new Promise(r => setTimeout(r, 50));

    // ----- Adim 5: Listener sonucu kontrol -----
    log.section(5, 'Listener etkisini kontrol et (draft + queue)');
    const transferAfter = (await db.collection('stockTransfers').doc(transferId).get()).data();
    log.field('parasutQueued', transferAfter.parasutQueued);
    log.field('parasutDocumentId', transferAfter.parasutDocumentId);

    const docId = transferAfter.parasutDocumentId;
    const draftDoc = await idempotency.getById(docId);
    if (!draftDoc) {
        log.err('Draft dokuman olusturulamadi!');
        return;
    }
    log.ok(`invoiceDocuments/${docId.slice(0, 16)}... draft yazildi`);
    log.field('status', draftDoc.status);
    log.field('amount', draftDoc.amount);
    log.field('idempotencyKey', docId.slice(0, 32) + '...');
    log.field('audit events', draftDoc.audit.length);

    // ----- Adim 6: Worker'i manuel calistir -----
    log.section(6, 'InvoiceWorker._handler() — pipeline');
    log.info('Worker normalde BullMQ tarafindan tetiklenir; lokal demoda direkt cagiriyoruz.');

    const worker = new InvoiceWorker({
        connection: {},
        idempotency,
        tokenManager,
        rateLimiter: null,
        providerFactory: async () => mock,
        tenantSettingsLoader: async (tid, doc) => {
            const settings = (await db.collection('invoicingCredentials').doc(tid).collection('providers').doc('parasut').get()).data();
            const transfer = (await db.collection('stockTransfers').doc(doc.sourceId).get()).data();
            return {
                branch: { name: 'Sube A', taxNumber: '1234567890' },
                items: transfer.items.map(it => ({
                    name: it.name, productId: it.productId,
                    quantity: it.quantity, unitPrice: it.unitPrice, vatRate: it.vatRate,
                })),
                currency: doc.currency || 'TRL',
                issueDate: new Date().toISOString().slice(0, 10),
                shipmentIncluded: doc.shipmentIncluded,
                documentType: doc.documentType,
                description: `Sevkiyat: ${transfer.transferNumber}`,
                invoiceSeriesPrefix: settings.invoiceSeriesPrefix,
            };
        },
    });
    log.info('Worker olusturuldu (BullMQ disable, _handler direkt cagrilacak).');

    const result = await worker._handler({
        id: docId,
        data: { documentId: docId, tenantId, sourceTransferId: transferId },
        attemptsMade: 1,
    });
    log.ok(`Worker tamamlandi: invoiceId=${result.invoiceId}`);

    // ----- Adim 7: Final state -----
    log.section(7, 'Final invoiceDocuments state');
    const final = await idempotency.getById(docId);
    log.field('status', `${c.green}${final.status}${c.reset}`);
    log.field('parasutInvoiceId', final.parasutInvoiceId);
    log.field('invoiceNumber', final.invoiceNumber);
    log.field('pdfUrl', final.pdfUrl);
    log.field('parasutContactId', final.parasutContactId);

    log.info(`Audit log (${final.audit.length} events):`);
    for (const ev of final.audit) {
        const dt = new Date(ev.ts).toISOString().slice(11, 19);
        console.log(`         ${c.dim}[${dt}]${c.reset} ${c.cyan}${ev.event.padEnd(22)}${c.reset} by=${ev.by}`);
    }

    log.info(`MockInvoiceProvider call counts:`);
    for (const [m, n] of Object.entries(mock.calls)) {
        if (n > 0) console.log(`         ${m.padEnd(20)} ${c.bold}${n}${c.reset}`);
    }

    // ----- Adim 8: Idempotency kontrolu -----
    log.section(8, 'Idempotency dogrulamasi (ayni transfer 2. kez tetiklenirse)');
    log.info("Listener'a aynisini tekrar gonderecegiz, yeni belge olusmamali.");
    await db.collection('stockTransfers').doc(transferId).update({ parasutQueued: false });
    await new Promise(r => setTimeout(r, 50));
    const finalAgain = await idempotency.getById(docId);
    if (finalAgain.status === 'sent') {
        log.ok('Mevcut belge degismedi (idempotency korundu, status=sent kaldi).');
    } else {
        log.err(`Idempotency BOZULDU! Yeni status=${finalAgain.status}`);
    }

    // ----- Adim 9: Hata yolunu test et -----
    log.section(9, 'Hata akisini test et (provider 503 dondurursa retry-able)');
    const transferId2 = 'TR-DEMO-002';
    await db.collection('stockTransfers').doc(transferId2).set({
        tenantId, destinationBranchId: 'demo-branch-A',
        transferNumber: 'TRF-2026-0002', totalAmount: 999, currency: 'TRL',
        status: 'shipped', parasutQueued: false,
        items: [{ productId: 'p3', name: 'Test', quantity: 1, unitPrice: 999, vatRate: 20 }],
    });
    await new Promise(r => setTimeout(r, 50));
    const transferAfter2 = (await db.collection('stockTransfers').doc(transferId2).get()).data();
    const docId2 = transferAfter2.parasutDocumentId;

    // Provider'i 503'e zorla
    const origCreate = mock.createInvoice.bind(mock);
    mock.createInvoice = async () => { const e = new Error('mock 503'); e.status = 503; throw e; };
    try {
        await worker._handler({
            id: docId2, data: { documentId: docId2, tenantId, sourceTransferId: transferId2 }, attemptsMade: 1,
        });
    } catch (e) {
        const cls = RetryPolicy.classify(e);
        log.ok(`Hata firlatildi (BullMQ otomatik retry yapacak): status=${e.status}, retryable=${cls.retryable}, kind=${cls.kind}`);
    }
    const failedDoc = await idempotency.getById(docId2);
    log.field('status', failedDoc.status);
    log.field('errorCount', failedDoc.errorCount);
    log.field('lastError.message', failedDoc.lastError?.message);
    mock.createInvoice = origCreate;

    // ----- Adim 10: Ozet -----
    log.section(10, 'Ozet');
    const allDocs = [...db._docs.entries()].filter(([k]) => k.startsWith('invoiceDocuments/'));
    log.info(`Firestore'da ${allDocs.length} adet invoiceDocuments mevcut:`);
    for (const [path, data] of allDocs) {
        const status = data.status === 'sent' ? `${c.green}${data.status}${c.reset}` : `${c.yellow}${data.status}${c.reset}`;
        console.log(`         ${path.slice(0, 40)}... ${status} ${data.amount} ${data.currency}`);
    }

    listener.stop();

    console.log(`\n${c.bold}${c.green}E2E akis basariyla tamamlandi!${c.reset}`);
    console.log(`${c.dim}Bu test, gercek Parasut API yerine MockInvoiceProvider kullaniyor.${c.reset}`);
    console.log(`${c.dim}Pipeline'in tum kod path'leri (Listener, Idempotency, TokenManager, Worker, Vault) calisti.${c.reset}\n`);
}

main().catch(err => {
    console.error(`\n${c.red}${c.bold}DEMO HATASI:${c.reset}`, err);
    process.exit(1);
});
