// Anti-corruption layer between the BlockFarming ledger model and TFRA FIS / Ruzuku legacy formats.
// Inbound records that cannot be mapped are QUARANTINED (never silently dropped / guessed).

const REGION_CODES = { MOROGORO: 'MOR', MBEYA: 'MBY', DODOMA: 'DOD', 'DAR ES SALAAM': 'DSM', IRINGA: 'IRI', RUVUMA: 'RUV' };
const WALLETS = { MPESA: 'mpesa', 'M-PESA': 'mpesa', TIGOPESA: 'mixx', MIXX: 'mixx', AIRTEL: 'airtel', AIRTELMONEY: 'airtel', HALOPESA: 'halopesa' };
const STATUS = { A: 'ACTIVE', S: 'SUSPENDED', R: 'REVOKED' };

const money = (s) => {
  const n = Number(String(s).replace(/\/=|,|\s|TZS/gi, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`unparseable amount "${s}"`);
  return Math.round(n);
};
const msisdn = (s) => {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '255' + d.slice(1);
  if (!/^255[67]\d{8}$/.test(d)) throw new Error(`invalid MSISDN "${s}"`);
  return d;
};
const dmyToIso = (s) => {
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`invalid date "${s}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
};
const isoToDmy = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const region = (s) => {
  const c = REGION_CODES[String(s).toUpperCase().trim()];
  if (!c) throw new Error(`unknown region "${s}"`);
  return c;
};
const licToId = (lic) => String(lic).replace(/\//g, '-');

function mapInbound(raw) {
  const out = { products: {}, manufacturers: {}, distributors: {}, dealers: {}, quotas: {} };
  const quarantine = [];
  const tryMap = (kind, rec, fn) => {
    try { fn(); } catch (e) { quarantine.push({ kind, record: rec, reason: e.message }); }
  };
  for (const p of raw.products || []) tryMap('product', p, () => {
    out.products[p.PRD_CODE] = { code: p.PRD_CODE, name: p.PRD_NAME, price_ceiling: money(p.PRICE_CEIL), subsidy: money(p.SUBSIDY_AMT) };
  });
  for (const m of raw.manufacturers || []) tryMap('manufacturer', m, () => {
    out.manufacturers[licToId(m.LIC_NO)] = { id: licToId(m.LIC_NO), lic_no: m.LIC_NO, name: m.NAME, status: STATUS[m.LIC_STATUS] || 'UNKNOWN', role: 'MANUFACTURER' };
  });
  for (const x of raw.distributors || []) tryMap('distributor', x, () => {
    out.distributors[licToId(x.LIC_NO)] = { id: licToId(x.LIC_NO), lic_no: x.LIC_NO, name: x.NAME, region: region(x.REGION), status: STATUS[x.LIC_STATUS] || 'UNKNOWN', role: 'DISTRIBUTOR' };
  });
  for (const x of raw.dealers || []) tryMap('dealer', x, () => {
    const wallet = WALLETS[String(x.WALLET).toUpperCase().replace(/\s/g, '')];
    if (!wallet) throw new Error(`unsupported wallet "${x.WALLET}"`);
    out.dealers[licToId(x.LIC_NO)] = {
      id: licToId(x.LIC_NO), lic_no: x.LIC_NO, name: x.NAME, msisdn: msisdn(x.MSISDN), wallet,
      region: region(x.REGION), status: STATUS[x.LIC_STATUS] || 'UNKNOWN', license_expiry: dmyToIso(x.LIC_EXP), role: 'DEALER',
    };
  });
  for (const q of raw.quotas || []) tryMap('quota', q, () => {
    out.quotas[region(q.REGION)] = { region: region(q.REGION), season: q.SEASON, bags: money(q.QUOTA_BAGS) };
  });
  return { registry: out, quarantine };
}

// Ledger event -> Ruzuku legacy record.
function mapOutbound(ev) {
  const base = { EVENT_ID: ev.id, SRC_SYSTEM: 'BLOCKFARMING', TXN_DATE: isoToDmy(ev.at), LEDGER_TX: ev.tx_id || '', BLOCK_NO: ev.block ?? '' };
  switch (ev.type) {
    case 'BATCH_REGISTERED':
      return { ...base, TXN_TYPE: 'STOCK_IN', BATCH_NO: ev.batch_id, PRD_CODE: ev.product_code, MFR_LIC: ev.manufacturer_lic, QTY_BAGS: ev.quantity, BATCH_HASH: ev.batch_hash };
    case 'CUSTODY_TRANSFER':
      return { ...base, TXN_TYPE: 'STOCK_TRANSFER', BATCH_NO: ev.batch_id, FROM_LIC: ev.from_lic, TO_LIC: ev.to_lic, QTY_BAGS: ev.qty, GPS: ev.gps || '' };
    case 'SUBSIDY_REDEEMED':
      return { ...base, TXN_TYPE: 'SUBSIDY_REDEEM', BATCH_NO: ev.batch_id, BAG_SERIAL: ev.serial, PRD_CODE: ev.product_code, DEALER_LIC: ev.dealer_lic, QTY_BAGS: 1, AMT_TZS: Number(ev.subsidy).toFixed(2), FARMER_REF: ev.farmer_ref, REGION_CODE: ev.region || '' };
    case 'SUBSIDY_PAID':
      return { ...base, TXN_TYPE: 'SUBSIDY_PAYMENT', DEALER_LIC: ev.dealer_lic, AMT_TZS: Number(ev.amount).toFixed(2), MNO: String(ev.provider).toUpperCase(), MNO_REF: ev.provider_ref, BF_REF: ev.ref };
    case 'INSPECTION_LOGGED':
      return { ...base, TXN_TYPE: 'FIELD_INSPECTION', INSPECTOR: ev.inspector, DEALER_LIC: ev.dealer_lic, RESULT: ev.result, BAG_SERIAL: ev.bag || '', GPS: ev.gps || '', REMARKS: ev.notes || '' };
    case 'REVIEW_DECISION':
      return { ...base, TXN_TYPE: 'SUBSIDY_REVIEW', BF_REF: ev.ref, DECISION: ev.decision, OFFICER: ev.officer, REMARKS: ev.notes || '' };
    default:
      return { ...base, TXN_TYPE: 'ALERT', ALERT_CODE: ev.type, DETAILS: ev.message || '', REGION_CODE: ev.region || '' };
  }
}

module.exports = { mapInbound, mapOutbound, isoToDmy };
