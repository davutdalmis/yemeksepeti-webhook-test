const path = require('path'); const fs = require('fs');
const admin = require('firebase-admin'); const axios = require('axios');
const CredentialVault = require('../secrets/CredentialVault'); const ParasutProvider = require('../providers/ParasutProvider');
const TENANT = 'TIxVr5PYwP9LMUOoxNcV'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.OUT_DIR || '.';
(async () => {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  admin.initializeApp({ credential: admin.credential.cert(sa ? JSON.parse(sa) : require(process.env.GOOGLE_APPLICATION_CREDENTIALS || path.resolve(__dirname, '../../../../../firebase-credentials.json'))) });
  const s = (await admin.firestore().collection('invoicingCredentials').doc(TENANT).collection('providers').doc('parasut').get()).data();
  const d = new CredentialVault().decryptFields(s, ['clientId', 'clientSecret', 'username', 'password'], TENANT);
  const p = new ParasutProvider({ clientId: d.clientId, clientSecret: d.clientSecret, username: d.username, password: process.env.PAROLA || d.password, companyId: s.companyId });
  const { accessToken: t } = await p.authenticate();
  const base = 'https://api.parasut.com/v4/' + s.companyId; const H = { Authorization: 'Bearer ' + t, Accept: 'application/json' };
  const get = async (u, opts = {}) => { try { return await axios.get(u.startsWith('http') ? u : base + u, { headers: H, timeout: 30000, validateStatus: () => true, ...opts }); } catch (e) { return { status: 'ERR', data: e.message, headers: {} }; } };
  const show = (x, cname) => { const a = x.attributes; console.log('  ', x.id, a.issue_date, 'despatch_no=', a.despatch_no, 'status=', a.status, '/', a.status_message, 'legalized_at=', a.legalized_at, 'uuid=', a.uuid, 'type=', a.shipment_document_type, 'plaka=', a.carrier_license_plate, 'drivers=', JSON.stringify(a.drivers_info), 'print_url=', a.print_url, 'printed_at=', a.printed_at, 'contact=', cname || '-'); };
  let r = await get('/shipment_documents?filter[issue_date]=2025-11-16&page[size]=25&include=contact');
  const inc = (r.data && r.data.included) || []; const cn = (x) => { const c = x.relationships && x.relationships.contact && x.relationships.contact.data; const f = c && inc.find((i) => i.id === c.id); return f ? f.attributes.name : ''; };
  console.log('[A] 16.11.2025 irsaliyeler:', r.status); (r.data.data || []).forEach((x) => show(x, cn(x)));
  const target = (r.data.data || []).find((x) => x.attributes.despatch_no === 'BR02025000000705') || (r.data.data || []).find((x) => x.attributes.legalized_at) || (r.data.data || [])[0];
  await sleep(1200);
  r = await get('/shipment_documents/1003498883'); console.log('[B] Yemigo taslagi 1003498883:'); if (r.data && r.data.data) show(r.data.data);
  if (target) {
    console.log('[C] hedef', target.id);
    await sleep(1200); let rr = await get('/shipment_documents/' + target.id + '/pdf'); console.log('  /pdf ->', rr.status, JSON.stringify(rr.data).slice(0, 300));
    if (rr.data && rr.data.data && rr.data.data.attributes && rr.data.data.attributes.url) { const f = await axios.get(rr.data.data.attributes.url, { responseType: 'arraybuffer', validateStatus: () => true }); console.log('  pdf indir ->', f.status, f.headers['content-type'], f.data.length, 'bytes'); if (f.status === 200) fs.writeFileSync(path.join(OUT, 'parasut_irsaliye_' + target.id + '.pdf'), Buffer.from(f.data)); }
    const pu = target.attributes.print_url; if (pu) { await sleep(1200); const f = await get(pu, { responseType: 'arraybuffer' }); console.log('  print_url ->', f.status, f.headers && f.headers['content-type'], f.data && f.data.length); if (f.status === 200) fs.writeFileSync(path.join(OUT, 'parasut_print_' + target.id + (String(f.headers['content-type']).includes('pdf') ? '.pdf' : '.html')), Buffer.from(f.data)); }
    await sleep(1200); rr = await get('/shipment_documents/' + target.id + '?include=e_despatch_response,invoices,warehouse_transfer'); console.log('  include e_despatch_response ->', rr.status, 'included=', (rr.data.included || []).map((i) => i.type + ':' + i.id + ' ' + JSON.stringify(i.attributes).slice(0, 160)).join(' || ') || '(bos)');
  }
})().catch((e) => { console.error('HATA:', e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 300)) : e.stack); process.exit(1); });
