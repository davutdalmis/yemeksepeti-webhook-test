const path = require('path'); const admin = require('firebase-admin'); const axios = require('axios');
const CredentialVault = require('../secrets/CredentialVault'); const ParasutProvider = require('../providers/ParasutProvider');
const TENANT = 'TIxVr5PYwP9LMUOoxNcV'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  admin.initializeApp({ credential: admin.credential.cert(sa ? JSON.parse(sa) : require(process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../../../../../firebase-credentials.json'))) });
  const db = admin.firestore();
  const s = (await db.collection('invoicingCredentials').doc(TENANT).collection('providers').doc('parasut').get()).data();
  const d = new CredentialVault().decryptFields(s, ['clientId', 'clientSecret', 'username', 'password'], TENANT);
  const p = new ParasutProvider({ clientId: d.clientId, clientSecret: d.clientSecret, username: d.username, password: process.env.PAROLA || d.password, companyId: s.companyId });
  const { accessToken: t } = await p.authenticate();
  const base = 'https://api.parasut.com/v4/' + s.companyId; const H = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const docs = await db.collection('invoiceDocuments').where('tenantId', '==', TENANT).where('documentKind', '==', 'shipment').get();
  const rows = docs.docs.map((x) => ({ id: x.id, ...x.data() })).filter((x) => ['sent', 'pending_approval'].includes(x.status));
  console.log('Yemigo irsaliye (sent+pending_approval):', rows.length);
  const say = { legalized: 0, taslak: 0, silinmis: 0 };
  for (const r of rows.sort((a, b) => (a.status > b.status ? 1 : -1))) {
    if (!r.parasutShipmentId) { console.log(' ', r.status, r.sourceTransferNumber, 'parasutShipmentId YOK'); continue; }
    const rr = await axios.get(base + '/shipment_documents/' + r.parasutShipmentId, { headers: H, validateStatus: () => true, timeout: 30000 });
    const a = rr.status === 200 ? rr.data.data.attributes : null;
    const durum = rr.status === 404 ? 'SILINMIS' : (a && a.legalized_at ? 'LEGALIZED ' + a.despatch_no : 'TASLAK');
    say[rr.status === 404 ? 'silinmis' : (a && a.legalized_at ? 'legalized' : 'taslak')]++;
    console.log(' ', r.status.padEnd(16), (r.sourceTransferNumber || '').padEnd(15), 'parasut=', r.parasutShipmentId, durum, a ? ('plaka=' + a.carrier_license_plate + ' sofor=' + JSON.stringify(a.drivers_info)) : '');
    await sleep(700);
  }
  console.log('OZET', JSON.stringify(say));
})().catch((e) => { console.error('HATA:', e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300)) : e.stack); process.exit(1); });
