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
  const get = async (u, opts = {}) => { try { return await axios.get(base + u, { headers: H, timeout: 30000, validateStatus: () => true, ...opts }); } catch (e) { return { status: 'ERR', data: e.message }; } };
  let r = await get('/shipment_documents?sort=-issue_date&page[size]=25');
  console.log('[A] list ->', r.status, 'count=', r.data && r.data.data ? r.data.data.length : JSON.stringify(r.data).slice(0, 200));
  const rows = (r.data && r.data.data) || [];
  rows.slice(0, 12).forEach((x) => { const a = x.attributes; console.log('  ', x.id, a.issue_date, 'inflow=', a.inflow, 'no=', a.invoice_no || a.procurement_number || '-', 'printed_at=', a.printed_at || '-', 'desc=', (a.description || '').slice(0, 28), '| rel:', Object.keys(x.relationships || {}).join(','), '| attr:', Object.keys(a).join(','));
  });
  if (rows[0]) { await sleep(1200);
    const id = rows[0].id;
    for (const u of ['/shipment_documents/' + id + '?include=stock_movements,contact', '/shipment_documents/' + id + '?include=active_e_document', '/shipment_documents/' + id + '?include=e_despatch', '/shipment_documents/' + id + '/pdf', '/shipment_documents/' + id + '/print']) {
      const rr = await get(u); const body = rr.data; const inc = body && body.included ? [...new Set(body.included.map((x) => x.type))].join(',') : '';
      console.log('[B]', u, '->', rr.status, inc ? 'included=' + inc : JSON.stringify(body).slice(0, 220)); await sleep(1200);
    }
  }
  // Kasim 2025'teki resmi e-irsaliye: BR02025000000705 — sales_invoices icinde e-irsaliyeli fatura mi?
  r = await get('/sales_invoices?filter[issue_date]=2025-11-16&include=active_e_document&page[size]=25');
  console.log('[C] 16.11.2025 sales_invoices ->', r.status, 'count=', r.data && r.data.data ? r.data.data.length : '-', 'included=', r.data && r.data.included ? [...new Set(r.data.included.map((x) => x.type))].join(',') : '-');
  (r.data && r.data.data || []).slice(0, 5).forEach((x) => { const a = x.attributes; console.log('  ', x.id, a.invoice_no, a.item_type, 'shipment_included=', a.shipment_included, 'contact=', (a.contact_name||'').slice(0,30)); });
  r = await get('/shipment_documents?filter[issue_date]=2025-11-16&page[size]=25');
  console.log('[D] 16.11.2025 shipment_documents ->', r.status, 'count=', r.data && r.data.data ? r.data.data.length : JSON.stringify(r.data).slice(0,150));
  (r.data && r.data.data || []).slice(0, 5).forEach((x) => { const a = x.attributes; console.log('  ', x.id, a.invoice_no || a.procurement_number, a.description, '| rel:', Object.keys(x.relationships||{}).join(',')); });
})().catch((e) => { console.error('HATA:', e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300)) : e.stack); process.exit(1); });
