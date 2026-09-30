// 30.09.2026 (F3 bulgu 6) — fatura kuyrugunda takili kalmis irsaliyeleri ('queued'/'failed')
// 'draft'a dondurur. Varsayilan KURU calisma: hicbir sey yazmaz, yalniz ne yapilacagini listeler.
//
//   node scripts/_reset-stuck-queued-shipments.js                 # kuru (varsayilan)
//   node scripts/_reset-stuck-queued-shipments.js --tenant <id>   # firma suzgeci
//   node scripts/_reset-stuck-queued-shipments.js --apply         # YAZAR (Davut onayi ile)
//
// Kimlik: GOOGLE_APPLICATION_CREDENTIALS / ADC (yemigo-prod) ya da FIREBASE_SERVICE_ACCOUNT_JSON.
// Kosullar motorla BIREBIR ayni (ShipmentProcessor.resetStuckToDraft): documentKind=shipment,
// status queued|failed, parasutShipmentId YOK, parasutInvoiceId/invoiceNumber YOK, onaylanmamis.
// Uymayan belge atlanir ve nedeni yazilir. Stok hareketi yazilmaz (bu belgelerde hic olmamisti).
//
// 20.09'da ayni belgeler fatura yolunda Parasut'te SATIS FATURASI acmis olabilir (62a1549 commit
// mesaji); Parasut tarafi bu betikle kontrol EDILMEZ — Davut elle bakmali.

const admin = require('firebase-admin');
const { IdempotencyService } = require('../lib/IdempotencyService');
const { ShipmentProcessor, STUCK_SHIPMENT_STATUSES } = require('../lib/ShipmentProcessor');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tIdx = args.indexOf('--tenant');
const TENANT = tIdx >= 0 ? args[tIdx + 1] : null;

(async () => {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    admin.initializeApp(sa
        ? { credential: admin.credential.cert(JSON.parse(sa)) }
        : { credential: admin.credential.applicationDefault(), projectId: process.env.GCLOUD_PROJECT || 'yemigo-prod' });
    const db = admin.firestore();
    const idempotency = new IdempotencyService({ db });
    const unused = () => { throw new Error('bu betikte kullanilmaz'); };
    const processor = new ShipmentProcessor({
        db, idempotency, tokenManager: { getValidToken: unused }, providerFactory: unused, contextLoader: unused,
    });

    let q = db.collection('invoiceDocuments').where('documentKind', '==', 'shipment')
        .where('status', 'in', [...STUCK_SHIPMENT_STATUSES]);
    if (TENANT) q = q.where('tenantId', '==', TENANT);
    const snap = await q.get();

    console.log(`${APPLY ? 'UYGULA' : 'KURU'} — takili irsaliye adayi: ${snap.size}${TENANT ? ' (firma ' + TENANT + ')' : ''}`);
    const say = { donecek: 0, atlandi: 0, hata: 0 };
    for (const d of snap.docs) {
        const x = d.data() || {};
        const etiket = `${d.id} ${String(x.status).padEnd(7)} ${(x.sourceTransferNumber || '-').padEnd(16)} sube=${x.branchId || '-'} kalem=${(x.items || []).length}`;
        try {
            const r = await processor.resetStuckToDraft(d.id, {
                tenantId: x.tenantId, requestedBy: 'script:_reset-stuck-queued-shipments', dryRun: !APPLY,
            });
            say.donecek++;
            console.log(`  ${APPLY ? 'DONDURULDU' : 'donecek   '} ${etiket} -> draft  hata="${r.lastError || ''}"`);
        } catch (e) {
            if (e && e.code && e.status === 409) {
                say.atlandi++;
                console.log(`  ATLANDI    ${etiket} neden=${e.code}${e.payload ? ' ' + JSON.stringify(e.payload) : ''}`);
            } else {
                say.hata++;
                console.log(`  HATA       ${etiket} ${e && e.message}`);
            }
        }
    }
    console.log('OZET', JSON.stringify(say));
    if (!APPLY && say.donecek > 0) console.log('Yazmak icin: --apply (once Parasut satis faturalari kontrol edilmeli).');
})().catch((e) => { console.error('HATA:', e.stack || e.message); process.exit(1); });
