// Mock of the government side: TFRA Fertilizer Information System (FIS) + Ruzuku portal.
// It deliberately speaks a *legacy* format (UPPER_SNAKE fields, "45,000/=" prices,
// DD/MM/YYYY dates, local MSISDNs, one-letter status codes) so the platform's
// integration adapter has to map and validate data in both directions.
//
//   PULL  GET  /fis/v1/registry        prices, licensed dealers, distributors, quotas (signed request)
//   PUSH  POST /ruzuku/v1/events       BlockFarming ledger events (HMAC-signed webhook)
const { PORTS, SECRETS, send, createServer, jsonStore, logger, verifySignature, sha256 } = require('../shared/lib');

const log = logger('TFRA', 'blue');

const seed = () => ({
  up: true,
  products: [
    { PRD_CODE: 'NPK-50', PRD_NAME: 'NPK 20-10-10 (50kg)', PRICE_CEIL: '45,000/=', SUBSIDY_AMT: '25000.00', UOM: 'BAG' },
    { PRD_CODE: 'UREA-50', PRD_NAME: 'UREA 46% (50kg)', PRICE_CEIL: '38,000/=', SUBSIDY_AMT: '22000.00', UOM: 'BAG' },
    { PRD_CODE: 'DAP-50', PRD_NAME: 'DAP 18-46-0 (50kg)', PRICE_CEIL: '52,000/=', SUBSIDY_AMT: '30000.00', UOM: 'BAG' },
  ],
  manufacturers: [
    { LIC_NO: 'MFR/2019/001', NAME: 'Minjingu Mines & Fertilizer Ltd', LIC_STATUS: 'A' },
    { LIC_NO: 'MFR/2017/004', NAME: 'YARA Tanzania Ltd', LIC_STATUS: 'A' },
  ],
  distributors: [
    { LIC_NO: 'DST/MOR/011', NAME: 'Morogoro Agro Distributors', REGION: 'MOROGORO', LIC_STATUS: 'A' },
    { LIC_NO: 'DST/MBY/027', NAME: 'Mbeya Inputs Supply Co.', REGION: 'MBEYA', LIC_STATUS: 'A' },
  ],
  dealers: [
    { LIC_NO: 'AGD/MOR/1001', NAME: 'Mama Neema Agrovet', MSISDN: '0754 111 222', WALLET: 'MPESA', REGION: 'MOROGORO', LIC_STATUS: 'A', LIC_EXP: '31/12/2027' },
    { LIC_NO: 'AGD/MOR/1002', NAME: 'Kilimo Bora Shop', MSISDN: '0713-222-333', WALLET: 'TIGOPESA', REGION: 'MOROGORO', LIC_STATUS: 'A', LIC_EXP: '30/06/2027' },
    { LIC_NO: 'AGD/MBY/2001', NAME: 'Uyole Farm Centre', MSISDN: '+255 688 444 555', WALLET: 'AIRTEL', REGION: 'MBEYA', LIC_STATUS: 'A', LIC_EXP: '31/03/2028' },
    { LIC_NO: 'AGD/MBY/2002', NAME: 'Halo Agro Supplies', MSISDN: '0621666777', WALLET: 'HALOPESA', REGION: 'MBEYA', LIC_STATUS: 'S', LIC_EXP: '31/12/2026' },
    { LIC_NO: 'AGD/DOD/3001', NAME: 'Dodoma Inputs Kiosk', MSISDN: '', WALLET: 'MPESA', REGION: 'DODOMA', LIC_STATUS: 'A', LIC_EXP: '31/12/2027' }, // malformed: no MSISDN
  ],
  quotas: [
    { REGION: 'MOROGORO', SEASON: '2026/27', QUOTA_BAGS: '5,000' },
    { REGION: 'MBEYA', SEASON: '2026/27', QUOTA_BAGS: '4,000' },
  ],
  received: [],
});

const store = jsonStore('tfra.json', seed);
const d = () => store.data;

const routes = [
  ['GET', '/health', (req, res) => d().up ? send(res, 200, { status: 'OK', system: 'TFRA FIS / Ruzuku (mock)' }) : send(res, 503, { error: 'FIS maintenance window' })],

  ['GET', '/fis/v1/registry', (req, res) => {
    if (!d().up) return send(res, 503, { error: 'FIS maintenance window' });
    const v = verifySignature(SECRETS.tfra, req, '');
    if (!v.ok) return send(res, 401, { error: v.reason });
    const { products, manufacturers, distributors, dealers, quotas } = d();
    send(res, 200, { EXTRACT_DATE: new Date().toLocaleDateString('en-GB'), products, manufacturers, distributors, dealers, quotas });
  }],

  ['POST', '/ruzuku/v1/events', (req, res, { body, raw }) => {
    if (!d().up) return send(res, 503, { error: 'Ruzuku portal unavailable' });
    const v = verifySignature(SECRETS.tfra, req, raw);
    if (!v.ok) { log('REJECTED event:', v.reason); return send(res, 401, { error: v.reason }); }
    const dup = d().received.find((r) => r.EVENT_ID === body.EVENT_ID);
    if (dup) return send(res, 200, { ACK_NO: dup.ACK_NO, DUPLICATE: true });
    const ack = 'RZK' + sha256(body.EVENT_ID).slice(0, 8).toUpperCase();
    d().received.unshift({ ...body, ACK_NO: ack, RECEIVED_AT: new Date().toLocaleString('en-GB') });
    d().received = d().received.slice(0, 100);
    store.save();
    log(`Ruzuku received ${body.TXN_TYPE} ${body.EVENT_ID} -> ${ack}`);
    send(res, 200, { ACK_NO: ack });
  }],

  // ---- demo admin ----
  ['GET', '/admin/state', (req, res) => send(res, 200, d())],
  ['POST', '/admin/up', (req, res, { body }) => { d().up = !!body.up; store.save(); log('FIS/Ruzuku is now', d().up ? 'UP' : 'DOWN'); send(res, 200, { up: d().up }); }],
  ['POST', '/admin/price', (req, res, { body }) => {
    const p = d().products.find((x) => x.PRD_CODE === body.code);
    if (!p) return send(res, 404, { error: 'unknown product' });
    p.PRICE_CEIL = Number(body.price).toLocaleString('en-US') + '/=';
    store.save();
    log(`price ceiling ${p.PRD_CODE} -> ${p.PRICE_CEIL}`);
    send(res, 200, p);
  }],
  ['POST', '/admin/dealer-status', (req, res, { body }) => {
    const x = d().dealers.find((y) => y.LIC_NO === body.lic_no);
    if (!x) return send(res, 404, { error: 'unknown dealer' });
    x.LIC_STATUS = body.status;
    store.save();
    log(`dealer ${x.LIC_NO} status -> ${x.LIC_STATUS}`);
    send(res, 200, x);
  }],
  ['POST', '/admin/reset', (req, res) => { store.reset(); send(res, 200, { reset: true }); }],
];

createServer('tfra', routes).listen(PORTS.tfra, () => log(`TFRA FIS / Ruzuku mock on :${PORTS.tfra}`));
