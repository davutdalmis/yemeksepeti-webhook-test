// SALT OKUNUR probe: Parasut API'de shipment_document -> e-Irsaliye / PDF erisimi var mi?
const path = require('path');
const admin = require('firebase-admin');
const axios = require('axios');
const CredentialVault = require('../secrets/CredentialVault');
const ParasutProvider = require('../providers/ParasutProvider');
const TENANT = 'TIxVr5PYwP9LMUOoxNcV';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  admin.initializeApp({ credential: admin.credential.cert(sa ? JSON.parse(sa) : require(process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../../../../../firebase-credentials.json'))) });
  const s = (await admin.firestore().collection('invoicingCredentials').doc(TENANT).collection('providers').doc('parasut').get()).data();
  const d = new CredentialVault().decryptFields(s, ['clientId', 'clientSecret', 'username', 'password'], TENANT);
  const p = new ParasutProvider({ clientId: d.clientId, clientSecret: d.clientSecret, username: d.username, password: process.env.PAROLA || d.password, companyId: s.companyId });
  const { accessToken: t } = await p.authenticate();
  const base = 'https://api.parasut.com/v4/' + s.companyId;
  const H = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const get = async (u, opts = {}) => { try { const r = await axios.get(base + u, { headers: H, timeout: 30000, validateStatus: () => true, ...opts }); return r; } catch (e) { return { status: 'ERR', data: e.message }; } };
  // 1) Yemigo'nun actigi irsaliye
  let r = await get('/shipment_documents/1003456808?include=stock_movements,contact,active_e_document');
  console.log('[1] shipment 1003456808 ->', r.status);
  if (r.data && r.data.data) { const a = r.data.data.attributes || {}; console.log('  attr keys:', Object.keys(a).join(',')); console.log('  rel keys:', Object.keys(r.data.data.relationships || {}).join(',')); console.log('  included types:', (r.data.included || []).map((x) => x.type).join(',')); console.log('  invoice_no=', a.invoice_no, 'procurement_number=', a.procurement_number, 'printed_at=', a.printed_at); }
  else console.log('  body:', JSON.stringify(r.data).slice(0, 300));
  await sleep(1200);
  // 2) son irsaliyeler: e-belgesi olan var mi?
  r = await get('/shipment_documents?sort=-issue_date&page[size]=25&include=active_e_document');
  console.log('[2] list ->', r.status, 'count=', r.data && r.data.data ? r.data.data.length : '-');
  if (r.data && r.data.data) { const inc = r.data.included || []; console.log('  included types:', [...new Set(inc.map((x) => x.type))].join(',') || '(yok)');
    r.data.data.slice(0, 8).forEach((x) => { const a = x.attributes; const rel = x.relationships || {}; const ed = rel.active_e_document && rel.active_e_document.data; console.log('  ', x.id, a.issue_date, 'no=', a.invoice_no || a.procurement_number, 'desc=', (a.description || '').slice(0, 30), 'e_doc=', ed ? ed.type + ':' + ed.id : '-', 'relkeys=', Object.keys(rel).join('|')); });
    const withE = r.data.data.find((x) => x.relationships && x.relationships.active_e_document && x.relationships.active_e_document.data);
    if (withE) { const ed = withE.relationships.active_e_document.data; await sleep(1200);
      for (const u of ['/' + ed.type + '/' + ed.id, '/' + ed.type + '/' + ed.id + '/pdf']) { const rr = await get(u); console.log('  [2b]', u, '->', rr.status, JSON.stringify(rr.data).slice(0, 250)); await sleep(1200); } }
  }
  // 3) olasi e-irsaliye uclari
  for (const u of ['/e_despatches?page[size]=1', '/e_shipments?page[size]=1', '/e_dispatches?page[size]=1', '/e_waybills?page[size]=1', '/e_despatches/3799122', '/e_despatches/3799122/pdf', '/shipment_documents/3799122', '/e_archives/3799122/pdf']) {
    const rr = await get(u); console.log('[3]', u, '->', rr.status, typeof rr.data === 'string' ? rr.data.slice(0, 120) : JSON.stringify(rr.data).slice(0, 200)); await sleep(1200);
  }
})().catch((e) => { console.error('HATA:', e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300)) : e.stack); process.exit(1); });
