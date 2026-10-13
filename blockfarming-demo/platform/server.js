// BlockFarming Core Platform
//  - Factory batch registration (codes hashed with keyed SHA-256, only hashes leave the factory)
//  - Custody transfers (distributor -> agro-dealer), licence + quota enforcement
//  - USSD (*150*00#) + SMS (15000) verification: FAST PATH answers from cache in < 1s
//  - Settlement queue (ASYNC PATH): smart-contract redeem -> MNO payout -> signed callback, with retries
//  - TFRA FIS pull sync + Ruzuku push webhooks through an outbox (mapping + quarantine)
const path = require('path');
const crypto = require('crypto');
const L = require('../shared/lib');
const { mapInbound, mapOutbound } = require('./tfra-mapper');

const log = L.logger('PLATFORM', 'green');
const store = L.jsonStore('platform.json', () => ({
  registry: null, registry_synced_at: null, registry_source: 'NONE', quarantine: [],
  batches: {}, tokens: {}, sessions: [], settlements: [], sms: [], outbox: [], alerts: [], custody: [], feed: [],
  aggregators: {
    africastalking: { name: "Africa's Talking", up: true, handled: 0 },
    beem: { name: 'Beem Africa', up: true, handled: 0 },
  },
  fails: {}, seq: 0,
}));
const printRuns = L.jsonStore('print-runs.json', () => ({}));
const S = () => store.data;
const save = () => store.save();
const now = () => new Date().toISOString();

// ---------------- helpers ----------------
function feed(kind, msg) {
  S().feed.unshift({ at: now(), kind, msg });
  S().feed = S().feed.slice(0, 80);
  save();
  log(`${kind}: ${msg}`);
}
function alert(type, message, extra = {}) {
  const a = { id: 'ALT-' + (++S().seq), at: now(), type, message, ...extra };
  S().alerts.unshift(a);
  S().alerts = S().alerts.slice(0, 60);
  feed('ALERT', `${type} — ${message}`);
  pushEvent({ type, message, region: extra.region });
  return a;
}
function sms(to, text, kind = 'INFO') {
  S().sms.unshift({ id: 'SMS-' + (++S().seq), at: now(), to, from: 'BLOCKFARM', text, kind });
  S().sms = S().sms.slice(0, 100);
  save();
}
const newRef = () => 'BF-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const farmerRef = (phone) => 'FRM-' + L.hmac(L.SECRETS.pepper, phone).slice(0, 8).toUpperCase(); // anonymised farmer id
const fmt = (n) => Number(n).toLocaleString('en-US');

// 12-digit numeric codes (feature-phone friendly): 11 random digits + Luhn check digit
function luhnDigit(s) {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = +s[s.length - 1 - i];
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
function luhnValid(code) { return /^\d{12}$/.test(code) && luhnDigit(code.slice(0, 11)) === code[11]; }
function genCode() {
  let s = '';
  const buf = crypto.randomBytes(11);
  for (const b of buf) s += String(b % 10);
  return s + luhnDigit(s);
}
const tokenHash = (code) => L.hmac(L.SECRETS.pepper, code); // keyed SHA-256: brute forcing hashes is useless without the pepper
const bagLabel = (batch_id, serial) => `${batch_id}-${String(serial).padStart(4, '0')}`;

function party(id) {
  const r = S().registry;
  if (!r) return null;
  return r.manufacturers[id] || r.distributors[id] || r.dealers[id] || null;
}

// ---------------- blockchain client ----------------
async function chainTx(type, payload) {
  const body = JSON.stringify({ type, payload });
  const r = await L.http_json('POST', L.URLS.chain + '/tx', null, { rawBody: body, headers: L.signedHeaders(L.SECRETS.chain, body) });
  if (r.status === 409) { const e = new Error(r.data.error); e.contract = true; throw e; }
  if (!r.ok) throw new Error('chain error ' + r.status);
  return r.data;
}
async function chainAdmin(pathname) {
  const body = '{}';
  return (await L.http_json('POST', L.URLS.chain + pathname, null, { rawBody: body, headers: L.signedHeaders(L.SECRETS.chain, body) })).data;
}
const pendingTx = {}; // tx_id -> callback(blockNo)
function watchTx(tx_id, cb) { pendingTx[tx_id] = cb; }

// ---------------- TFRA integration ----------------
function pushEvent(ev) {
  const e = { id: 'EVT-' + Date.now().toString(36).toUpperCase() + '-' + (++S().seq), at: now(), ...ev };
  S().outbox.unshift({ id: e.id, type: e.type, legacy: mapOutbound(e), status: 'PENDING', attempts: 0, next_at: 0, created_at: e.at });
  S().outbox = S().outbox.slice(0, 150);
  save();
}

async function syncRegistry() {
  try {
    const r = await L.http_json('GET', L.URLS.tfra + '/fis/v1/registry', undefined, { headers: L.signedHeaders(L.SECRETS.tfra, '') });
    if (!r.ok) throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
    const { registry, quarantine } = mapInbound(r.data);
    const old = S().registry;
    if (old) {
      for (const p of Object.values(registry.products)) {
        const o = old.products[p.code];
        if (o && o.price_ceiling !== p.price_ceiling) feed('TFRA', `price ceiling ${p.code} changed ${fmt(o.price_ceiling)} → ${fmt(p.price_ceiling)} (live on USSD now)`);
      }
      for (const d of Object.values(registry.dealers)) {
        const o = old.dealers[d.id];
        if (o && o.status !== d.status) feed('TFRA', `dealer ${d.name} licence ${o.status} → ${d.status}`);
      }
    }
    S().registry = registry;
    S().quarantine = quarantine;
    S().registry_synced_at = now();
    S().registry_source = 'LIVE';
    save();
    return { ok: true, quarantined: quarantine.length };
  } catch (e) {
    S().registry_source = S().registry ? 'CACHED (FIS unreachable: ' + e.message + ')' : 'NONE';
    save();
    return { ok: false, error: e.message };
  }
}

// ---------------- factory ----------------
async function createBatch({ product_code, manufacturer_id, quantity, mfg_date, exp_date }, { seeding = false } = {}) {
  const reg = S().registry;
  if (!reg) throw new Error('Registry not synced from TFRA FIS yet');
  const prod = reg.products[product_code];
  const mfr = reg.manufacturers[manufacturer_id];
  quantity = parseInt(quantity, 10);
  if (!prod) throw new Error('Unknown product code (not in TFRA registry)');
  if (!mfr || mfr.status !== 'ACTIVE') throw new Error('Manufacturer not licensed by TFRA');
  if (!(quantity >= 1 && quantity <= 200)) throw new Error('Demo limit: 1–200 bags per batch');
  if (!seeding && new Date(exp_date) <= new Date()) throw new Error('Expiry date must be in the future');

  const initials = mfr.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const yy = String(new Date(mfg_date).getFullYear()).slice(2);
  const n = Object.values(S().batches).filter((b) => b.batch_id.startsWith(initials + yy)).length + 1;
  const batch_id = `${initials}${yy}${String(n).padStart(3, '0')}`;

  const codes = [];
  const seen = new Set();
  while (codes.length < quantity) {
    const c = genCode();
    if (!seen.has(c) && !S().tokens[tokenHash(c)]) { seen.add(c); codes.push(c); }
  }
  const hashes = codes.map(tokenHash);
  const meta = { batch_id, product_code, manufacturer: manufacturer_id, mfg_date, exp_date, quantity };
  const batch_hash = L.sha256(JSON.stringify(meta) + '|' + L.sha256(hashes.join('')));

  const r = await chainTx('REGISTER_BATCH', { ...meta, batch_hash, token_hashes: hashes });
  const b = { ...meta, product_name: prod.name, manufacturer_name: mfr.name, batch_hash, hashes, tx_id: r.tx_id, block: null, created_at: now() };
  S().batches[batch_id] = b;
  hashes.forEach((h, i) => (S().tokens[h] = { batch_id, serial: i + 1, status: 'UNREDEEMED', holder: manufacturer_id, flagged: false }));
  // Plain codes go ONLY to the secure label printer. Kept here for the demo "scratch cards".
  printRuns.data[batch_id] = codes.map((code, i) => ({ serial: i + 1, label: bagLabel(batch_id, i + 1), code }));
  printRuns.save();
  save();
  watchTx(r.tx_id, (blk) => { b.block = blk; save(); });
  feed('FACTORY', `${mfr.name} registered batch ${batch_id}: ${quantity} × ${prod.name} (hash ${batch_hash.slice(0, 12)}…)`);
  pushEvent({ type: 'BATCH_REGISTERED', batch_id, product_code, manufacturer_lic: mfr.lic_no, quantity, batch_hash, tx_id: r.tx_id });
  return { batch_id, batch_hash, tx_id: r.tx_id, quantity, sample_label: bagLabel(batch_id, 1) };
}

// ---------------- custody ----------------
async function custodyTransfer({ batch_id, from, to, serial_from, serial_to, gps }) {
  const b = S().batches[batch_id];
  if (!b) throw new Error('Unknown batch');
  const pf = party(from), pt = party(to);
  if (!pf) throw new Error('Sender not in TFRA registry');
  if (!pt) throw new Error('Receiver not in TFRA registry');
  if (pt.role === 'MANUFACTURER') throw new Error('Cannot transfer back to a manufacturer');
  if (pt.status !== 'ACTIVE') {
    alert('UNLICENSED_TRANSFER', `${pf.name} tried to ship ${batch_id} to ${pt.name} (licence ${pt.status})`, { region: pt.region });
    throw new Error(`Receiver licence is ${pt.status} — transfer blocked`);
  }
  serial_from = parseInt(serial_from, 10); serial_to = parseInt(serial_to, 10);
  const qty = serial_to - serial_from + 1;
  if (pt.role === 'DEALER') {
    const q = S().registry.quotas[pt.region];
    if (q) {
      const inRegion = Object.values(S().tokens).filter((t) => { const p = party(t.holder); return p && p.role === 'DEALER' && p.region === pt.region; }).length
        + Object.values(S().tokens).filter((t) => t.status !== 'UNREDEEMED' && t.region === pt.region).length;
      if (inRegion + qty > q.bags) {
        alert('QUOTA_EXCEEDED', `${pt.region} quota ${fmt(q.bags)} bags would be exceeded`, { region: pt.region });
        throw new Error('Regional subsidy quota exceeded');
      }
    }
  }
  const r = await chainTx('CUSTODY_TRANSFER', { batch_id, from, to, serial_from, serial_to, gps: gps || '' });
  for (let s = serial_from; s <= serial_to; s++) S().tokens[b.hashes[s - 1]].holder = to;
  const rec = { id: 'CUS-' + (++S().seq), at: now(), batch_id, from, from_name: pf.name, to, to_name: pt.name, serial_from, serial_to, qty, gps: gps || '', tx_id: r.tx_id, block: null };
  S().custody.unshift(rec);
  S().custody = S().custody.slice(0, 1000);
  save();
  watchTx(r.tx_id, (blk) => { rec.block = blk; save(); });
  feed('CUSTODY', `${qty} bags of ${batch_id} ${pf.name} → ${pt.name}`);
  pushEvent({ type: 'CUSTODY_TRANSFER', batch_id, from_lic: pf.lic_no, to_lic: pt.lic_no, qty, gps, tx_id: r.tx_id });
  return rec;
}

// ---------------- verification core (shared by USSD + SMS) ----------------
const FAIL_LIMIT = 5;
function recentFails(phone) {
  const cutoff = Date.now() - 3600e3;
  S().fails[phone] = (S().fails[phone] || []).filter((t) => t > cutoff);
  return S().fails[phone];
}
function regionOfCell(cell) { return cell ? String(cell).split('-')[0] : null; }

function verifyCode({ phone, input, channel, cell_id }) {
  const code = String(input || '').replace(/\D/g, '');
  if (recentFails(phone).length >= FAIL_LIMIT) {
    return { outcome: 'RATE_LIMITED', message: 'Too many wrong codes from this number. Try again after 1 hour or call TFRA 0800 110 042.' };
  }
  if (!luhnValid(code)) {
    recentFails(phone).push(Date.now());
    return { outcome: 'TYPO', message: 'Code not valid. Check the 12 digits under the scratch panel and try again.' };
  }
  const h = tokenHash(code);
  const t = S().tokens[h];
  if (!t) {
    const f = recentFails(phone);
    f.push(Date.now());
    alert('COUNTERFEIT_ATTEMPT', `Unknown code entered by ${farmerRef(phone)} via ${channel}${cell_id ? ' @ ' + cell_id : ''}`, { region: regionOfCell(cell_id) });
    if (f.length === FAIL_LIMIT) alert('BRUTE_FORCE_BLOCKED', `${farmerRef(phone)} blocked after ${FAIL_LIMIT} invalid codes`, { region: regionOfCell(cell_id) });
    return { outcome: 'COUNTERFEIT', message: 'WARNING! Code NOT registered. This bag may be FAKE. Do NOT buy. Report: 0800 110 042' };
  }
  const b = S().batches[t.batch_id];
  const prod = S().registry.products[b.product_code];
  const label = bagLabel(t.batch_id, t.serial);

  if (t.status !== 'UNREDEEMED') {
    if (t.phone === phone) {
      const job = S().settlements.find((j) => j.ref === t.ref);
      return { outcome: 'ALREADY_VERIFIED_BY_YOU', ref: t.ref, message: `Already verified by you. Ref ${t.ref}. Dealer payment: ${job ? job.state : 'processing'}.` };
    }
    alert('DUPLICATE_REDEMPTION', `Bag ${label} code re-used by ${farmerRef(phone)} (first used ${t.at.slice(0, 16)})`, { region: regionOfCell(cell_id) });
    return { outcome: 'ALREADY_USED', message: `WARNING! Code already USED on ${t.at.slice(0, 10)}. Do NOT buy this bag - possible fraud. Report: 0800 110 042` };
  }
  if (t.flagged) {
    return { outcome: 'TAMPER_FLAGGED', message: `WARNING! Bag ${label} was reported with a broken/VOID label. Do NOT buy. Report: 0800 110 042` };
  }
  if (new Date(b.exp_date) < new Date()) {
    alert('EXPIRED_STOCK', `Expired bag ${label} offered for sale by ${(party(t.holder) || {}).name || t.holder}`);
    return { outcome: 'EXPIRED', message: `GENUINE but EXPIRED (${b.exp_date}). Do NOT buy. Dealer reported to TFRA.` };
  }

  // ---- reserve atomically (single-threaded event loop) then hand over to async settlement ----
  const dealer = party(t.holder);
  const ref = newRef();
  t.status = 'PENDING';
  t.ref = ref; t.phone = phone; t.at = now();
  t.region = dealer && dealer.region;
  if (dealer && dealer.role === 'DEALER' && cell_id && regionOfCell(cell_id) !== dealer.region) {
    alert('GEO_ANOMALY', `Bag ${label} (dealer ${dealer.name}, ${dealer.region}) verified from tower ${cell_id} — possible diversion`, { region: regionOfCell(cell_id) });
  }
  S().settlements.unshift({
    ref, token_hash: h, batch_id: t.batch_id, serial: t.serial, label, product_code: b.product_code,
    farmer_ref: farmerRef(phone), channel, cell_id, state: 'QUEUED', attempts: 0, next_at: 0,
    created_at: now(), updated_at: now(), history: [{ at: now(), state: 'QUEUED', note: `reserved via ${channel}` }],
  });
  S().settlements = S().settlements.slice(0, 1000);
  save();
  feed('VERIFY', `GENUINE ${label} verified by ${farmerRef(phone)} via ${channel} → settlement ${ref} queued`);
  const dealerName = dealer ? dealer.name : t.holder;
  return {
    outcome: 'GENUINE', ref,
    message: `GENUINE: ${prod.name}\n${b.manufacturer_name.split(' ')[0]}, exp ${b.exp_date.slice(0, 7)}\nPAY MAX TZS ${fmt(prod.price_ceiling)}\nDealer: ${dealerName}\nRef ${ref}`,
  };
}

async function reportTamper({ phone, input, channel, cell_id }) {
  const m = String(input || '').toUpperCase().replace(/\s/g, '').match(/^([A-Z]{2}\d{5})-?(\d{1,4})$/);
  if (!m || !S().batches[m[1]]) return { outcome: 'BAD_SERIAL', message: 'Bag number not found. It is printed next to the scratch label, e.g. MM26001-0007.' };
  const b = S().batches[m[1]];
  const serial = +m[2];
  if (serial < 1 || serial > b.quantity) return { outcome: 'BAD_SERIAL', message: 'Bag number not found.' };
  const t = S().tokens[b.hashes[serial - 1]];
  t.flagged = true;
  const ref = 'RPT-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  try { await chainTx('TAMPER_REPORT', { batch_id: b.batch_id, serial }); } catch (e) {}
  const holder = party(t.holder);
  alert('TAMPER_REPORT', `VOID/broken label on ${bagLabel(b.batch_id, serial)} at ${holder ? holder.name : t.holder} (reported by ${farmerRef(phone)}, ${ref})`, { region: holder && holder.region });
  return { outcome: 'REPORTED', ref, message: `Thank you. Report ${ref}. This bag is now blocked and TFRA inspectors are notified. Do NOT buy it.` };
}

// ---------------- USSD (Africa's Talking-style callback) ----------------
async function handleUssd(aggregator, b) {
  const t0 = Date.now();
  const phone = String(b.phoneNumber || '').replace(/\D/g, '');
  const text = String(b.text || '');
  const parts = text === '' ? [] : text.split('*');
  let res;
  let outcome = 'MENU';
  if (parts.length === 0) {
    res = 'CON BlockFarming *150*00#\n1. Verify bag (Hakiki)\n2. Official prices\n3. Report VOID/broken label\n4. Check payment ref';
  } else if (parts[0] === '1' && parts.length === 1) {
    res = 'CON Enter 12-digit code under the scratch panel:';
  } else if (parts[0] === '1') {
    const r = verifyCode({ phone, input: parts[1], channel: 'USSD', cell_id: b.cellId });
    outcome = r.outcome;
    res = 'END ' + r.message;
    if (r.outcome === 'GENUINE') sms(phone, `BlockFarming receipt: ${r.message.replace(/\n/g, ' | ')}. Keep this SMS as proof.`, 'RECEIPT');
  } else if (parts[0] === '2') {
    const ps = Object.values(S().registry.products).map((p) => `${p.name.replace(' (50kg)', '')}: ${fmt(p.price_ceiling)}`).join('\n');
    res = 'END TFRA max prices (TZS/50kg)\n' + ps;
  } else if (parts[0] === '3' && parts.length === 1) {
    res = 'CON Enter bag number printed beside the label (e.g. MM26001-0007):';
  } else if (parts[0] === '3') {
    const r = await reportTamper({ phone, input: parts[1], channel: 'USSD', cell_id: b.cellId });
    outcome = r.outcome;
    res = 'END ' + r.message;
  } else if (parts[0] === '4' && parts.length === 1) {
    res = 'CON Enter BlockFarming ref (e.g. BF-1A2B3C):';
  } else if (parts[0] === '4') {
    const q = String(parts[1]).toUpperCase().replace(/^BF-?/, 'BF-');
    const j = S().settlements.find((x) => x.ref === q);
    res = j ? `END Ref ${j.ref}: ${j.state}${j.dealer_name ? '\nDealer: ' + j.dealer_name : ''}${j.amount ? '\nSubsidy TZS ' + fmt(j.amount) : ''}` : 'END Reference not found.';
  } else {
    res = 'END Invalid choice.';
  }
  const ms = Date.now() - t0;
  S().aggregators[aggregator].handled++;
  S().sessions.unshift({ at: now(), session_id: b.sessionId, aggregator, network: b.networkCode, phone, cell_id: b.cellId, input: text.replace(/(\d{4})\d{4}(\d{4})/, '$1****$2'), outcome, response: res, ms });
  S().sessions = S().sessions.slice(0, 80);
  save();
  return res;
}

// ---------------- settlement worker (async path) ----------------
const BACKOFF = [2000, 4000, 8000, 16000];
const FINAL_STATES = ['PAID', 'MANUAL_REVIEW', 'BLOCKED_DOUBLE_SPEND', 'REJECTED'];
function setState(j, state, note) {
  j.state = state; j.updated_at = now();
  j.history.push({ at: now(), state, note });
  save();
}

async function processSettlement(j) {
  const t = S().tokens[j.token_hash];
  switch (j.state) {
    case 'QUEUED': {
      try {
        const r = await chainTx('REDEEM', { token_hash: j.token_hash, ref: j.ref });
        j.tx_id = r.tx_id;
        j.holder = r.result.holder;
        setState(j, 'CHAIN_PENDING', `smart contract REDEEM accepted (${r.tx_id.slice(0, 14)}…), waiting for block`);
      } catch (e) {
        if (e.contract) {
          setState(j, 'BLOCKED_DOUBLE_SPEND', `smart contract rejected: ${e.message}`);
          alert('DOUBLE_SPEND_BLOCKED', `Ledger rejected second redemption of ${j.label} (${e.message})`);
        } else {
          j.next_at = Date.now() + 3000;
          if (!j.chain_offline_noted) { j.chain_offline_noted = true; j.history.push({ at: now(), state: 'QUEUED', note: 'ledger node unreachable — kept in durable queue, will retry' }); save(); }
        }
      }
      return;
    }
    case 'CHAIN_PENDING': {
      const r = await L.http_json('GET', L.URLS.chain + '/tx/' + j.tx_id).catch(() => null);
      if (!r || !r.ok || r.data.status !== 'CONFIRMED') { j.next_at = Date.now() + 800; return; }
      j.block = r.data.block;
      t.status = 'REDEEMED';
      setState(j, 'CONFIRMED', `REDEEMED=TRUE written in block #${j.block}`);
      return;
    }
    case 'CONFIRMED': {
      const dealer = party(j.holder);
      const prod = S().registry.products[j.product_code];
      if (!dealer || dealer.role !== 'DEALER') {
        setState(j, 'MANUAL_REVIEW', `bag was still held by ${dealer ? dealer.name : j.holder} (not a licensed agro-dealer) — no automatic payout`);
        alert('DIVERSION_SUSPECTED', `${j.label} sold to a farmer while custody shows ${dealer ? dealer.name : j.holder}`, { region: dealer && dealer.region });
        return;
      }
      if (dealer.status !== 'ACTIVE') {
        setState(j, 'MANUAL_REVIEW', `dealer licence ${dealer.status} — payout held for TFRA review`);
        return;
      }
      Object.assign(j, { dealer_id: dealer.id, dealer_name: dealer.name, dealer_lic: dealer.lic_no, msisdn: dealer.msisdn, provider: dealer.wallet, amount: prod.subsidy });
      pushEvent({ type: 'SUBSIDY_REDEEMED', batch_id: j.batch_id, serial: j.serial, product_code: j.product_code, dealer_lic: dealer.lic_no, subsidy: prod.subsidy, farmer_ref: j.farmer_ref, region: dealer.region, tx_id: j.tx_id, block: j.block });
      setState(j, 'PAYOUT_READY', `payee resolved from custody ledger: ${dealer.name} (${dealer.wallet})`);
      return;
    }
    case 'PAYOUT_READY':
    case 'RETRYING': {
      const body = JSON.stringify({ provider: j.provider, msisdn: j.msisdn, amount: j.amount, reference: j.ref, narrative: `Fertilizer subsidy ${j.label}` });
      let r;
      try {
        r = await L.http_json('POST', L.URLS.mno + '/v1/payouts', null, { rawBody: body, headers: L.signedHeaders(L.SECRETS.mno, body, { 'Idempotency-Key': j.ref }) });
      } catch (e) { r = { ok: false, status: 0, data: { error: 'gateway unreachable' } }; }
      j.attempts++;
      if (r.ok) {
        j.payout_id = r.data.payout_id;
        j.sent_at = Date.now();
        if (r.data.status === 'SUCCESS') return completePayout(j, r.data);
        setState(j, 'PAYOUT_SENT', `HMAC-signed payout accepted by ${j.provider} (${r.data.payout_id}), Idempotency-Key ${j.ref}`);
      } else if (j.attempts > BACKOFF.length) {
        setState(j, 'MANUAL_REVIEW', `payout failed ${j.attempts}× (${r.data && r.data.error}) — escalated`);
        sms(j.msisdn, `BlockFarming: subsidy TZS ${fmt(j.amount)} for ${j.label} is delayed and escalated to TFRA. Ref ${j.ref}.`, 'DEALER');
      } else {
        j.next_at = Date.now() + BACKOFF[j.attempts - 1];
        setState(j, 'RETRYING', `attempt ${j.attempts} failed: ${(r.data && r.data.error) || r.status} — retry in ${BACKOFF[j.attempts - 1] / 1000}s`);
        if (j.attempts === 1) sms(j.msisdn, `BlockFarming: subsidy TZS ${fmt(j.amount)} for ${j.label} is queued (mobile money delay). Ref ${j.ref}. No action needed.`, 'DEALER');
      }
      return;
    }
    case 'PAYOUT_SENT': {
      if (Date.now() - j.sent_at > 20000) setState(j, 'RETRYING', 'no callback in 20s — re-sending with SAME Idempotency-Key (cannot double pay)');
      else j.next_at = Date.now() + 1000;
      return;
    }
  }
}

function completePayout(j, cb) {
  if (j.state === 'PAID') return;
  j.provider_ref = cb.provider_ref;
  setState(j, 'PAID', `signed callback verified: ${cb.provider} ref ${cb.provider_ref}`);
  sms(j.msisdn, `BlockFarming: You received TZS ${fmt(j.amount)} subsidy for bag ${j.label}. ${String(j.provider).toUpperCase()} ref ${cb.provider_ref}. BF ref ${j.ref}.`, 'DEALER');
  feed('PAYOUT', `TZS ${fmt(j.amount)} paid to ${j.dealer_name} via ${j.provider} (${cb.provider_ref})`);
  pushEvent({ type: 'SUBSIDY_PAID', dealer_lic: j.dealer_lic, amount: j.amount, provider: j.provider, provider_ref: cb.provider_ref, ref: j.ref, tx_id: j.tx_id, block: j.block });
}

const OUTBOX_BACKOFF = [2000, 5000, 10000, 20000, 30000];
async function processOutbox(o) {
  const body = JSON.stringify(o.legacy);
  try {
    const r = await L.http_json('POST', L.URLS.tfra + '/ruzuku/v1/events', null, { rawBody: body, headers: L.signedHeaders(L.SECRETS.tfra, body) });
    o.attempts++;
    if (r.ok) { o.status = 'DELIVERED'; o.ack = r.data.ACK_NO; o.delivered_at = now(); }
    else throw new Error((r.data && r.data.error) || 'HTTP ' + r.status);
  } catch (e) {
    if (o.status !== 'DELIVERED') {
      o.status = 'RETRYING'; o.last_error = e.message;
      o.next_at = Date.now() + OUTBOX_BACKOFF[Math.min(o.attempts, OUTBOX_BACKOFF.length - 1)];
    }
  }
  save();
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const [tx, cb] of Object.entries(pendingTx)) {
      const r = await L.http_json('GET', L.URLS.chain + '/tx/' + tx).catch(() => null);
      if (r && r.ok && r.data.status === 'CONFIRMED') { delete pendingTx[tx]; cb(r.data.block); }
    }
    const due = S().settlements.filter((j) => !FINAL_STATES.includes(j.state) && (j.next_at || 0) <= Date.now());
    for (const j of due.reverse()) await processSettlement(j);
    const outs = S().outbox.filter((o) => o.status !== 'DELIVERED' && o.next_at <= Date.now()).reverse().slice(0, 10);
    for (const o of outs) await processOutbox(o);
  } catch (e) { log('worker error', e.message); }
  busy = false;
}

// ---------------- health ----------------
let health = {};
async function refreshHealth() {
  const ping = async (u) => { try { const r = await L.http_json('GET', u + '/health', undefined, { timeoutMs: 1500 }); return r.ok ? { up: true, ...r.data } : { up: false }; } catch (e) { return { up: false }; } };
  const [chain, mno, tfra] = await Promise.all([ping(L.URLS.chain), ping(L.URLS.mno), ping(L.URLS.tfra)]);
  health = { chain, mno, tfra };
}

// ---------------- seed ----------------
async function seed() {
  if (Object.keys(S().batches).length) return;
  log('seeding demo supply chain…');
  const b1 = await createBatch({ product_code: 'NPK-50', manufacturer_id: 'MFR-2019-001', quantity: 20, mfg_date: '2026-08-01', exp_date: '2028-08-01' });
  await custodyTransfer({ batch_id: b1.batch_id, from: 'MFR-2019-001', to: 'DST-MOR-011', serial_from: 1, serial_to: 20, gps: '-6.8211,37.6612' });
  await custodyTransfer({ batch_id: b1.batch_id, from: 'DST-MOR-011', to: 'AGD-MOR-1001', serial_from: 1, serial_to: 10, gps: '-6.8235,37.6610' });
  await custodyTransfer({ batch_id: b1.batch_id, from: 'DST-MOR-011', to: 'AGD-MOR-1002', serial_from: 11, serial_to: 15, gps: '-6.8302,37.6555' });
  const b2 = await createBatch({ product_code: 'UREA-50', manufacturer_id: 'MFR-2017-004', quantity: 12, mfg_date: '2026-07-15', exp_date: '2028-07-15' });
  await custodyTransfer({ batch_id: b2.batch_id, from: 'MFR-2017-004', to: 'DST-MBY-027', serial_from: 1, serial_to: 12, gps: '-8.9094,33.4608' });
  await custodyTransfer({ batch_id: b2.batch_id, from: 'DST-MBY-027', to: 'AGD-MBY-2001', serial_from: 1, serial_to: 8, gps: '-8.9310,33.4170' });
  const b3 = await createBatch({ product_code: 'DAP-50', manufacturer_id: 'MFR-2019-001', quantity: 5, mfg_date: '2024-01-10', exp_date: '2026-01-10' }, { seeding: true });
  await custodyTransfer({ batch_id: b3.batch_id, from: 'MFR-2019-001', to: 'DST-MOR-011', serial_from: 1, serial_to: 5 });
  await custodyTransfer({ batch_id: b3.batch_id, from: 'DST-MOR-011', to: 'AGD-MOR-1001', serial_from: 1, serial_to: 5 });
  try { await custodyTransfer({ batch_id: b2.batch_id, from: 'DST-MBY-027', to: 'AGD-MBY-2002', serial_from: 9, serial_to: 12 }); } catch (e) { /* blocked: suspended licence (shows an alert) */ }
  log('seed complete');
}

async function boot() {
  for (let i = 0; i < 30; i++) {
    await refreshHealth();
    if (health.chain.up && health.tfra.up) break;
    await L.sleep(500);
  }
  const s = await syncRegistry();
  log('registry sync:', JSON.stringify(s));
  if (S().registry) await seed().catch((e) => log('seed failed:', e.message));
}

// ---------------- API ----------------
const ok = (res, d) => L.send(res, 200, d);
const bad = (res, e) => L.send(res, 400, { error: e.message || e });

const routes = [
  // ----- telecom side -----
  ['POST', '/ussd/:agg', async (req, res, { params, body }) => {
    if (!S().aggregators[params.agg]) return L.send(res, 404, { error: 'unknown aggregator' });
    L.sendText(res, 200, await handleUssd(params.agg, body));
  }],
  // Simulates the MNO USSD switch: routes the session to the first healthy aggregator.
  ['POST', '/telco/ussd', async (req, res, { body }) => {
    const order = ['africastalking', 'beem'];
    const agg = order.find((a) => S().aggregators[a].up);
    if (!agg) return ok(res, { network_error: 'USSD service temporarily unavailable. Send your code by SMS to 15000.' });
    const failedOver = agg !== order[0];
    const form = new URLSearchParams({ sessionId: body.sessionId, serviceCode: '*150*00#', phoneNumber: body.phone, text: body.text || '', networkCode: body.network || '', cellId: body.cell_id || '' }).toString();
    const t0 = Date.now();
    const r = await fetch(`${L.URLS.platform}/ussd/${agg}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const text = await r.text();
    const ms = Date.now() - t0;
    if (body.drop && text.startsWith('END')) {
      // Session dropped by congested network AFTER the platform processed it -> SMS fallback.
      const phone = String(body.phone).replace(/\D/g, '');
      const fbText = 'BlockFarming (USSD session dropped, result by SMS): ' + text.slice(4).replace(/\n/g, ' | ');
      const receipt = S().sms.find((m) => m.to === phone && m.kind === 'RECEIPT' && Date.now() - Date.parse(m.at) < 5000);
      if (receipt) { receipt.kind = 'FALLBACK'; receipt.text = fbText; save(); } else sms(phone, fbText, 'FALLBACK');
      feed('REDUNDANCY', `USSD session ${body.sessionId} dropped by network — result delivered by SMS fallback`);
      return ok(res, { dropped: true, aggregator: agg, failed_over: failedOver, ms });
    }
    ok(res, { response: text, aggregator: agg, failed_over: failedOver, ms });
  }],
  // SMS channel (shortcode 15000) — works when USSD is congested.
  ['POST', '/telco/sms', async (req, res, { body }) => {
    const phone = String(body.phone || '').replace(/\D/g, '');
    const text = String(body.text || '').trim();
    let r;
    if (/^(RIPOTI|REPORT)\s+/i.test(text)) r = await reportTamper({ phone, input: text.split(/\s+/)[1], channel: 'SMS', cell_id: body.cell_id });
    else r = verifyCode({ phone, input: text, channel: 'SMS', cell_id: body.cell_id });
    sms(phone, 'BlockFarming: ' + r.message.replace(/\n/g, ' | '), 'REPLY');
    ok(res, { accepted: true, outcome: r.outcome });
  }],
  ['POST', '/webhooks/mno', async (req, res, { body, raw }) => {
    const v = L.verifySignature(L.SECRETS.mno, req, raw);
    if (!v.ok) { alert('FORGED_WEBHOOK', `MNO callback rejected: ${v.reason}`); return L.send(res, 401, { error: v.reason }); }
    const j = S().settlements.find((x) => x.ref === body.idempotency_key);
    if (!j) return L.send(res, 404, { error: 'unknown reference' });
    if (body.status === 'SUCCESS') completePayout(j, body);
    else setState(j, 'RETRYING', `provider reported ${body.status}`);
    ok(res, { received: true });
  }],

  // ----- dashboard API -----
  ['GET', '/api/state', (req, res) => {
    const s = S();
    const tokens = Object.values(s.tokens);
    const paid = s.settlements.filter((j) => j.state === 'PAID');
    const batches = Object.values(s.batches).map((b) => {
      const holders = {};
      b.hashes.forEach((h, i) => {
        const t = s.tokens[h];
        const k = t.status === 'UNREDEEMED' ? ((party(t.holder) || {}).name || t.holder) : 'Sold to farmers';
        (holders[k] = holders[k] || []).push(i + 1);
      });
      return { ...b, hashes: undefined, holders, expired: new Date(b.exp_date) < new Date() };
    });
    ok(res, {
      now: now(), health, aggregators: s.aggregators,
      kpi: {
        batches: batches.length, bags: tokens.length,
        verified: tokens.filter((t) => t.status !== 'UNREDEEMED').length,
        counterfeit: s.alerts.filter((a) => a.type === 'COUNTERFEIT_ATTEMPT').length,
        subsidy_paid: paid.reduce((a, j) => a + j.amount, 0), payouts: paid.length,
        queue: s.settlements.filter((j) => !FINAL_STATES.includes(j.state)).length,
        review: s.settlements.filter((j) => j.state === 'MANUAL_REVIEW').length,
        outbox_pending: s.outbox.filter((o) => o.status !== 'DELIVERED').length,
        alerts: s.alerts.length,
      },
      registry: s.registry, registry_synced_at: s.registry_synced_at, registry_source: s.registry_source, quarantine: s.quarantine,
      batches, custody: s.custody.slice(0, 30), settlements: s.settlements.slice(0, 40), sessions: s.sessions.slice(0, 30),
      sms: s.sms.slice(0, 50), outbox: s.outbox.slice(0, 40), alerts: s.alerts.slice(0, 40), feed: s.feed.slice(0, 40),
    });
  }],
  ['GET', '/api/print-runs', (req, res) => {
    const out = [];
    for (const [bid, list] of Object.entries(printRuns.data)) {
      const b = S().batches[bid];
      if (!b) continue;
      for (const c of list) {
        const t = S().tokens[b.hashes[c.serial - 1]];
        out.push({ ...c, batch_id: bid, product: b.product_name, holder: (party(t.holder) || {}).name || t.holder, status: t.status, flagged: t.flagged, expired: new Date(b.exp_date) < new Date() });
      }
    }
    ok(res, out);
  }],
  ['POST', '/api/factory/batches', async (req, res, { body }) => { try { ok(res, await createBatch(body)); } catch (e) { bad(res, e); } }],
  ['POST', '/api/custody', async (req, res, { body }) => { try { ok(res, await custodyTransfer(body)); } catch (e) { bad(res, e); } }],
  ['POST', '/api/registry/sync', async (req, res) => ok(res, await syncRegistry())],
  ['POST', '/api/aggregators/:id', (req, res, { params, body }) => {
    const a = S().aggregators[params.id];
    if (!a) return bad(res, 'unknown');
    a.up = !!body.up; save();
    feed('REDUNDANCY', `${a.name} aggregator ${a.up ? 'restored' : 'DOWN'}`);
    ok(res, a);
  }],
  ['POST', '/api/settlements/:ref/retry', (req, res, { params }) => {
    const j = S().settlements.find((x) => x.ref === params.ref);
    if (!j) return bad(res, 'unknown ref');
    j.attempts = 0; j.next_at = 0;
    setState(j, j.amount ? 'PAYOUT_READY' : 'CONFIRMED', 'manually re-queued by TFRA officer');
    ok(res, j);
  }],
  ['GET', '/api/chain', async (req, res) => {
    const [c, v] = await Promise.all([L.http_json('GET', L.URLS.chain + '/chain?limit=40'), L.http_json('GET', L.URLS.chain + '/verify')]);
    ok(res, { ...c.data, verify: v.data });
  }],
  ['POST', '/api/chain/tamper', async (req, res) => ok(res, await chainAdmin('/admin/tamper'))],
  ['POST', '/api/chain/restore', async (req, res) => ok(res, await chainAdmin('/admin/restore'))],
  ['GET', '/api/ext', async (req, res) => {
    const [m, t] = await Promise.all([L.http_json('GET', L.URLS.mno + '/admin/state').catch(() => ({})), L.http_json('GET', L.URLS.tfra + '/admin/state').catch(() => ({}))]);
    ok(res, { mno: m.data, tfra: t.data });
  }],
  ['POST', '/api/ext/mno/:p', async (req, res, { params, body }) => {
    const r = await L.http_json('POST', `${L.URLS.mno}/admin/provider/${params.p}`, body);
    feed('REDUNDANCY', `${params.p} wallet rail ${body.up ? 'restored' : 'DOWN'}`);
    ok(res, r.data);
  }],
  ['POST', '/api/ext/tfra/:action', async (req, res, { params, body }) => {
    const r = await L.http_json('POST', `${L.URLS.tfra}/admin/${params.action}`, body);
    if (params.action === 'up') feed('TFRA', `FIS/Ruzuku ${body.up ? 'back online' : 'OFFLINE'}`);
    if (params.action !== 'up') await syncRegistry();
    ok(res, r.data);
  }],
  // Attack simulations for the judges: forged + replayed payout requests.
  ['POST', '/api/security/attack', async (req, res, { body }) => {
    const payload = JSON.stringify({ provider: 'mpesa', msisdn: '255700000666', amount: 25000, reference: 'FAKE-' + Date.now() });
    let headers;
    if (body.kind === 'replay') {
      const ts = String(Date.now() - 10 * 60 * 1000);
      headers = { 'Content-Type': 'application/json', 'X-BF-Timestamp': ts, 'X-BF-Signature': L.hmac(L.SECRETS.mno, ts + '.' + payload), 'Idempotency-Key': 'REPLAY-' + Date.now() };
    } else {
      headers = { ...L.signedHeaders('attacker-guessed-secret', payload), 'Idempotency-Key': 'FORGED-' + Date.now() };
    }
    const r = await L.http_json('POST', L.URLS.mno + '/v1/payouts', null, { rawBody: payload, headers });
    feed('SECURITY', `${body.kind === 'replay' ? 'Replayed' : 'Forged'} payout request → MNO answered ${r.status} ${r.data && r.data.error}`);
    ok(res, { status: r.status, response: r.data });
  }],
  ['POST', '/api/admin/reset', async (req, res) => {
    await chainAdmin('/admin/reset');
    await L.http_json('POST', L.URLS.mno + '/admin/reset', {});
    await L.http_json('POST', L.URLS.tfra + '/admin/reset', {});
    for (const k of Object.keys(pendingTx)) delete pendingTx[k];
    store.reset(); printRuns.reset();
    await syncRegistry();
    await seed();
    ok(res, { reset: true });
  }],
];

// Limited public feed for the Live Demo page (no registry, outbox, sessions or alert details).
routes.push(['GET', '/api/demo/state', (req, res) => {
  const s = S();
  ok(res, {
    health, aggregators: Object.fromEntries(Object.entries(s.aggregators).map(([k, a]) => [k, { name: a.name, up: a.up }])),
    settlements: s.settlements.slice(0, 3).map((j) => ({ ref: j.ref, label: j.label, channel: j.channel, state: j.state, dealer_name: j.dealer_name, amount: j.amount, provider: j.provider, history: j.history })),
    sms: s.sms.filter((m) => m.kind !== 'DEALER').slice(0, 40), feed: s.feed.slice(0, 30),
  });
}]);

// Role portals (manufacturer, distributor, dealer, regulator, inspector, admin) + public farmer API.
const portal = require('./portal');
routes.push(...portal({
  S, save, party, feed, alert, sms, pushEvent, setState, syncRegistry, createBatch, custodyTransfer,
  verifyCode, reportTamper, bagLabel, farmerRef, fmt, printRuns, FINAL_STATES, chainVerify: () => L.http_json('GET', L.URLS.chain + '/verify').then((r) => r.data),
}));

// Operator / integration endpoints now require a signed-in System Administrator
// (read-only oversight endpoints also open to the TFRA regulator).
const ADMIN_ONLY = /^\/api\/(factory|custody|registry|aggregators|settlements|chain\/|ext\/|security|admin)/;
const OVERSIGHT = /^\/api\/(state|chain|ext)$/;
for (const r of routes) {
  const [method, p, handler] = r;
  const roles = ADMIN_ONLY.test(p) ? ['admin'] : OVERSIGHT.test(p) && method === 'GET' ? ['admin', 'regulator'] : null;
  if (!roles) continue;
  r[2] = (req, res, x) => {
    const u = portal.readToken(req);
    if (!u) return L.send(res, 401, { error: 'Not signed in' });
    if (!roles.includes(u.role)) return L.send(res, 403, { error: 'Forbidden for role ' + u.role });
    return handler(req, res, x);
  };
}

L.createServer('platform', routes, { staticDir: path.join(__dirname, 'public') }).listen(L.PORTS.platform, () => {
  log(`dashboard + API on http://localhost:${L.PORTS.platform}`);
  boot();
  setInterval(tick, 500);
  setInterval(refreshHealth, 2000);
  setInterval(syncRegistry, 30000);
});
