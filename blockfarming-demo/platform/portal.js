// Role portals + public farmer API.
// Every portal endpoint resolves the caller from a signed bearer token and scopes data
// SERVER-SIDE to the caller's licence (a dealer can never read another dealer's sales).
const crypto = require('crypto');
const L = require('../shared/lib');

const SESSION_KEY = process.env.SESSION_KEY || 'bf-portal-session-key';
const DEMO_PASSWORD = 'demo1234';

// Demo accounts. In production: TFRA SSO / FIS identity + MFA; party_id = TFRA licence.
const USERS = [
  { username: 'minjingu', name: 'Factory QA — Minjingu', role: 'manufacturer', party_id: 'MFR-2019-001' },
  { username: 'yara', name: 'Factory QA — YARA', role: 'manufacturer', party_id: 'MFR-2017-004' },
  { username: 'dist.morogoro', name: 'Stores — Morogoro Agro Distributors', role: 'distributor', party_id: 'DST-MOR-011' },
  { username: 'dist.mbeya', name: 'Stores — Mbeya Inputs Supply', role: 'distributor', party_id: 'DST-MBY-027' },
  { username: 'neema', name: 'Neema (Mama Neema Agrovet)', role: 'dealer', party_id: 'AGD-MOR-1001' },
  { username: 'kilimobora', name: 'Kilimo Bora Shop', role: 'dealer', party_id: 'AGD-MOR-1002' },
  { username: 'uyole', name: 'Uyole Farm Centre', role: 'dealer', party_id: 'AGD-MBY-2001' },
  { username: 'tfra', name: 'TFRA Subsidy Officer (HQ)', role: 'regulator', party_id: null },
  { username: 'inspector.mor', name: 'Field Inspector — Morogoro', role: 'inspector', party_id: null, region: 'MOR' },
  { username: 'inspector.mby', name: 'Field Inspector — Mbeya', role: 'inspector', party_id: null, region: 'MBY' },
  { username: 'admin', name: 'Platform Operations (eGA / TFRA ICT)', role: 'admin', party_id: null },
];
for (const u of USERS) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = crypto.scryptSync(DEMO_PASSWORD, u.salt, 32).toString('hex');
}

const b64 = (s) => Buffer.from(s).toString('base64url');
function issueToken(u) {
  const payload = b64(JSON.stringify({ sub: u.username, role: u.role, exp: Date.now() + 8 * 3600e3 }));
  return payload + '.' + L.hmac(SESSION_KEY, payload);
}
function readToken(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer (.+)\.([0-9a-f]{64})$/);
  if (!m) return null;
  const expect = Buffer.from(L.hmac(SESSION_KEY, m[1]), 'hex');
  if (!crypto.timingSafeEqual(expect, Buffer.from(m[2], 'hex'))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch (e) { return null; }
  if (p.exp < Date.now()) return null;
  return USERS.find((u) => u.username === p.sub) || null;
}
const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, party_id: u.party_id, region: u.region });

// "1,2,3,7,8" -> "#1–3, #7–8"
function ranges(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `#${s[i]}` : `#${s[i]}–${s[j]}`);
    i = j;
  }
  return out.join(', ');
}

module.exports = portalRoutes;
module.exports.readToken = readToken;
function portalRoutes(ctx) {
  const { S, save, party, feed, alert, sms, pushEvent, setState, syncRegistry, createBatch, custodyTransfer, verifyCode, reportTamper, bagLabel, farmerRef, fmt, FINAL_STATES } = ctx;
  const ok = (res, d) => L.send(res, 200, d);
  const bad = (res, e, code = 400) => L.send(res, code, { error: e.message || e });

  const loginFails = {};
  const webHits = {};

  // wraps a handler: requires login and one of the roles
  const guard = (roles, fn) => async (req, res, x) => {
    const u = readToken(req);
    if (!u) return bad(res, 'Not signed in', 401);
    if (!roles.includes(u.role)) return bad(res, 'Forbidden for role ' + u.role, 403);
    try { return await fn(req, res, { ...x, user: u }); } catch (e) { return bad(res, e); }
  };

  // ---------- shared views ----------
  const tokens = () => Object.entries(S().tokens).map(([hash, t]) => ({ hash, ...t }));
  const batchOf = (t) => S().batches[t.batch_id];
  const isExpired = (b) => new Date(b.exp_date) < new Date();
  const regionOf = (id) => (party(id) || {}).region;

  function stockOf(partyId) {
    const groups = {};
    for (const t of tokens()) {
      if (t.holder !== partyId || t.status !== 'UNREDEEMED') continue;
      const b = batchOf(t);
      const g = (groups[t.batch_id] = groups[t.batch_id] || { batch_id: t.batch_id, product: b.product_name, product_code: b.product_code, manufacturer: b.manufacturer_name, exp_date: b.exp_date, expired: isExpired(b), serials: [], flagged: 0 });
      g.serials.push(t.serial);
      if (t.flagged) g.flagged++;
    }
    return Object.values(groups).map((g) => ({ ...g, count: g.serials.length, ranges: ranges(g.serials), serials: undefined }));
  }
  const transfersOf = (partyId) => S().custody.filter((c) => c.from === partyId || c.to === partyId).slice(0, 40);
  const settlementView = (j) => ({
    ref: j.ref, label: j.label, product: (S().registry.products[j.product_code] || {}).name, farmer_ref: j.farmer_ref, channel: j.channel,
    state: j.state, amount: j.amount, provider: j.provider, provider_ref: j.provider_ref, dealer_name: j.dealer_name || (party(j.holder) || {}).name,
    holder: j.holder, block: j.block, tx_id: j.tx_id, created_at: j.created_at, note: j.history[j.history.length - 1].note, cell_id: j.cell_id,
  });
  const alertsFor = (pred) => S().alerts.filter(pred).slice(0, 40);

  function bagHistory(label) {
    const m = String(label).toUpperCase().replace(/\s/g, '').match(/^([A-Z]{2}\d{5})-?(\d{1,4})$/);
    if (!m) throw new Error('Bag number format is like MM26001-0007');
    const b = S().batches[m[1]];
    const serial = +m[2];
    if (!b || serial < 1 || serial > b.quantity) throw new Error('Bag not found in registry');
    const t = S().tokens[b.hashes[serial - 1]];
    const custody = S().custody.filter((c) => c.batch_id === b.batch_id && serial >= c.serial_from && serial <= c.serial_to)
      .slice().reverse().map((c) => ({ at: c.at, from: c.from_name, to: c.to_name, gps: c.gps, tx_id: c.tx_id, block: c.block }));
    const j = S().settlements.find((x) => x.token_hash === b.hashes[serial - 1]);
    return {
      label: bagLabel(b.batch_id, serial), batch_id: b.batch_id, product: b.product_name, manufacturer: b.manufacturer_name, manufacturer_id: b.manufacturer,
      mfg_date: b.mfg_date, exp_date: b.exp_date, expired: isExpired(b), batch_hash: b.batch_hash, registered_tx: b.tx_id, registered_block: b.block,
      status: t.status, flagged: t.flagged, holder: (party(t.holder) || {}).name || t.holder, holder_id: t.holder,
      custody, settlement: j ? settlementView(j) : null,
      inspections: (S().inspections || []).filter((i) => i.bag === bagLabel(b.batch_id, serial)),
    };
  }

  function regionStats() {
    const R = S().registry;
    const regions = {};
    const r = (code) => (regions[code] = regions[code] || { region: code, dealers: 0, active_dealers: 0, bags_at_dealers: 0, bags_sold: 0, subsidy_paid: 0, pending: 0, alerts: 0, quota: (R.quotas[code] || {}).bags || null });
    Object.values(R.dealers).forEach((d) => { const x = r(d.region); x.dealers++; if (d.status === 'ACTIVE') x.active_dealers++; });
    for (const t of tokens()) {
      const p = party(t.holder);
      if (t.status === 'UNREDEEMED' && p && p.role === 'DEALER') r(p.region).bags_at_dealers++;
      if (t.status !== 'UNREDEEMED' && t.region) r(t.region).bags_sold++;
    }
    for (const j of S().settlements) {
      const reg = regionOf(j.dealer_id || j.holder);
      if (!reg) continue;
      if (j.state === 'PAID') r(reg).subsidy_paid += j.amount;
      else if (!FINAL_STATES.includes(j.state)) r(reg).pending++;
    }
    S().alerts.forEach((a) => { if (a.region) r(a.region).alerts++; });
    return Object.values(regions).map((x) => ({ ...x, quota_used: x.quota ? Math.round(((x.bags_at_dealers + x.bags_sold) / x.quota) * 1000) / 10 : null }));
  }

  // ---------- routes ----------
  return [
    // ===== auth =====
    ['POST', '/api/auth/login', (req, res, { body }) => {
      const key = req.socket.remoteAddress + '|' + body.username;
      const f = (loginFails[key] = (loginFails[key] || []).filter((t) => t > Date.now() - 15 * 60e3));
      if (f.length >= 5) return bad(res, 'Too many attempts. Try again in 15 minutes.', 429);
      const u = USERS.find((x) => x.username === String(body.username || '').toLowerCase().trim());
      const okPw = u && crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), crypto.scryptSync(String(body.password || ''), u.salt, 32));
      if (!okPw) { f.push(Date.now()); return bad(res, 'Wrong username or password', 401); }
      ok(res, { token: issueToken(u), user: publicUser(u) });
    }],
    ['GET', '/api/auth/me', guard(USERS.map((u) => u.role), (req, res, { user }) => ok(res, { user: publicUser(user), party: user.party_id ? party(user.party_id) : null }))],
    ['GET', '/api/auth/demo-accounts', (req, res) => ok(res, { password: DEMO_PASSWORD, accounts: USERS.map(publicUser) })],

    // ===== PUBLIC (farmers, no login) =====
    ['GET', '/api/public/prices', (req, res) => ok(res, { updated: S().registry_synced_at, products: Object.values(S().registry.products).map((p) => ({ name: p.name, price_ceiling: p.price_ceiling })) })],
    ['POST', '/api/public/verify', (req, res, { body }) => {
      const ip = req.socket.remoteAddress;
      const hits = (webHits[ip] = (webHits[ip] || []).filter((t) => t > Date.now() - 3600e3));
      if (hits.length >= 30) return bad(res, 'Too many requests from this device. Use *150*00# or try later.', 429);
      hits.push(Date.now());
      const phone = String(body.phone || '').replace(/\D/g, '').replace(/^0/, '255');
      if (!/^255[67]\d{8}$/.test(phone)) return bad(res, 'Enter your mobile number (e.g. 0765 000 111) — the receipt is sent there by SMS.');
      const r = verifyCode({ phone, input: body.code, channel: 'WEB', cell_id: null });
      if (r.outcome === 'GENUINE') sms(phone, `BlockFarming receipt: ${r.message.replace(/\n/g, ' | ')}. Keep this SMS as proof.`, 'RECEIPT');
      ok(res, { outcome: r.outcome, message: r.message, ref: r.ref || null });
    }],
    ['POST', '/api/public/report', async (req, res, { body }) => {
      const phone = String(body.phone || '').replace(/\D/g, '').replace(/^0/, '255') || 'anonymous';
      const r = await reportTamper({ phone, input: body.bag, channel: 'WEB', cell_id: null });
      ok(res, r);
    }],
    ['GET', '/api/public/ref/:ref', (req, res, { params }) => {
      const j = S().settlements.find((x) => x.ref === String(params.ref).toUpperCase());
      if (!j) return bad(res, 'Reference not found', 404);
      ok(res, { ref: j.ref, bag: j.label, product: (S().registry.products[j.product_code] || {}).name, state: j.state, dealer: j.dealer_name || null, verified_at: j.created_at, ledger_block: j.block ?? null });
    }],

    // ===== MANUFACTURER =====
    ['GET', '/api/portal/manufacturer', guard(['manufacturer'], (req, res, { user }) => {
      const me = party(user.party_id);
      const batches = Object.values(S().batches).filter((b) => b.manufacturer === user.party_id).map((b) => {
        const holders = {};
        let sold = 0, flagged = 0;
        b.hashes.forEach((h, i) => {
          const t = S().tokens[h];
          if (t.status !== 'UNREDEEMED') sold++;
          if (t.flagged) flagged++;
          const k = t.status === 'UNREDEEMED' ? (party(t.holder) || {}).name || t.holder : 'Sold to farmers';
          (holders[k] = holders[k] || []).push(i + 1);
        });
        return { batch_id: b.batch_id, product: b.product_name, quantity: b.quantity, mfg_date: b.mfg_date, exp_date: b.exp_date, expired: isExpired(b), batch_hash: b.batch_hash, tx_id: b.tx_id, block: b.block, sold, flagged, holders: Object.fromEntries(Object.entries(holders).map(([k, v]) => [k, { count: v.length, ranges: ranges(v) }])) };
      });
      const R = S().registry;
      ok(res, {
        me, batches, stock: stockOf(user.party_id),
        totals: { produced: batches.reduce((a, b) => a + b.quantity, 0), sold: batches.reduce((a, b) => a + b.sold, 0), at_factory: stockOf(user.party_id).reduce((a, g) => a + g.count, 0), flagged: batches.reduce((a, b) => a + b.flagged, 0) },
        products: Object.values(R.products), distributors: Object.values(R.distributors), transfers: transfersOf(user.party_id),
      });
    })],
    ['POST', '/api/portal/manufacturer/batch', guard(['manufacturer'], async (req, res, { body, user }) => {
      const r = await createBatch({ ...body, manufacturer_id: user.party_id });
      ok(res, { ...r, printed: `${r.quantity} scratch labels sent to the secure printer (codes are not stored on the platform)` });
    })],

    // ===== shared transfer (manufacturer -> distributor, distributor -> dealer) =====
    ['POST', '/api/portal/transfer', guard(['manufacturer', 'distributor'], async (req, res, { body, user }) => {
      const to = party(body.to);
      if (!to) throw new Error('Unknown receiver');
      if (user.role === 'manufacturer' && to.role !== 'DISTRIBUTOR') throw new Error('Manufacturers ship to licensed distributors');
      if (user.role === 'distributor' && to.role !== 'DEALER') throw new Error('Distributors ship to licensed agro-dealers');
      ok(res, await custodyTransfer({ ...body, from: user.party_id }));
    })],

    // ===== DISTRIBUTOR =====
    ['GET', '/api/portal/distributor', guard(['distributor'], (req, res, { user }) => {
      const me = party(user.party_id);
      const R = S().registry;
      const dealers = Object.values(R.dealers).map((d) => ({ ...d, stock: stockOf(d.id).reduce((a, g) => a + g.count, 0), in_region: d.region === me.region }));
      const stock = stockOf(user.party_id);
      const rs = regionStats().find((x) => x.region === me.region);
      ok(res, {
        me, stock, dealers, transfers: transfersOf(user.party_id),
        totals: { on_hand: stock.reduce((a, g) => a + g.count, 0), received: S().custody.filter((c) => c.to === user.party_id).reduce((a, c) => a + c.qty, 0), shipped: S().custody.filter((c) => c.from === user.party_id).reduce((a, c) => a + c.qty, 0), region_quota: rs && rs.quota, region_quota_used: rs && rs.quota_used },
        alerts: alertsFor((a) => a.message.includes(me.name)),
      });
    })],

    // ===== AGRO-DEALER =====
    ['GET', '/api/portal/dealer', guard(['dealer'], (req, res, { user }) => {
      const me = party(user.party_id);
      const sales = S().settlements.filter((j) => j.holder === user.party_id || j.dealer_id === user.party_id).map(settlementView);
      const stock = stockOf(user.party_id);
      ok(res, {
        me, stock, sales,
        totals: {
          on_hand: stock.reduce((a, g) => a + g.count, 0), sold: sales.length,
          paid: sales.filter((s) => s.state === 'PAID').reduce((a, s) => a + (s.amount || 0), 0),
          pending: sales.filter((s) => !FINAL_STATES.includes(s.state)).length,
          review: sales.filter((s) => s.state === 'MANUAL_REVIEW').length,
          flagged: stock.reduce((a, g) => a + g.flagged, 0), expired: stock.filter((g) => g.expired).reduce((a, g) => a + g.count, 0),
        },
        prices: Object.values(S().registry.products),
        sms: S().sms.filter((m) => m.to === me.msisdn).slice(0, 20),
        transfers: transfersOf(user.party_id),
        alerts: alertsFor((a) => a.message.includes(me.name)),
      });
    })],

    // ===== TFRA REGULATOR =====
    ['GET', '/api/portal/regulator', guard(['regulator'], async (req, res) => {
      const s = S();
      const paid = s.settlements.filter((j) => j.state === 'PAID');
      const verify = await ctx.chainVerify().catch(() => null);
      ok(res, {
        kpi: {
          bags: Object.keys(s.tokens).length, verified: Object.values(s.tokens).filter((t) => t.status !== 'UNREDEEMED').length,
          subsidy_paid: paid.reduce((a, j) => a + j.amount, 0), payouts: paid.length,
          counterfeit: s.alerts.filter((a) => a.type === 'COUNTERFEIT_ATTEMPT').length, alerts: s.alerts.length,
          review: s.settlements.filter((j) => j.state === 'MANUAL_REVIEW').length,
          flagged: Object.values(s.tokens).filter((t) => t.flagged).length,
        },
        regions: regionStats(), alerts: s.alerts.slice(0, 40),
        review: s.settlements.filter((j) => j.state === 'MANUAL_REVIEW').map(settlementView),
        settlements: s.settlements.slice(0, 25).map(settlementView),
        licences: [...Object.values(s.registry.distributors), ...Object.values(s.registry.dealers)],
        quarantine: s.quarantine, registry_source: s.registry_source, registry_synced_at: s.registry_synced_at,
        ledger: verify, outbox_pending: s.outbox.filter((o) => o.status !== 'DELIVERED').length,
        inspections: (s.inspections || []).slice(0, 20),
      });
    })],
    ['POST', '/api/portal/review/:ref', guard(['regulator'], (req, res, { params, body, user }) => {
      const j = S().settlements.find((x) => x.ref === params.ref);
      if (!j || j.state !== 'MANUAL_REVIEW') throw new Error('Settlement is not awaiting review');
      if (body.decision === 'approve') {
        j.attempts = 0; j.next_at = 0;
        setState(j, j.amount ? 'PAYOUT_READY' : 'CONFIRMED', `APPROVED by ${user.name}: ${body.notes || 'no remarks'}`);
      } else {
        setState(j, 'REJECTED', `REJECTED by ${user.name}: ${body.notes || 'no remarks'} — no subsidy paid`);
      }
      feed('TFRA', `${user.name} ${body.decision === 'approve' ? 'approved' : 'rejected'} settlement ${j.ref} (${j.label})`);
      pushEvent({ type: 'REVIEW_DECISION', ref: j.ref, decision: body.decision === 'approve' ? 'APPROVED' : 'REJECTED', officer: user.username, notes: body.notes });
      ok(res, { ref: j.ref, state: j.state });
    })],
    ['POST', '/api/portal/licence', guard(['regulator'], async (req, res, { body, user }) => {
      // FIS stays the system of record: change it there, then pull.
      const r = await L.http_json('POST', L.URLS.tfra + '/admin/dealer-status', { lic_no: body.lic_no, status: body.status });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'FIS update failed');
      await syncRegistry();
      feed('TFRA', `${user.name} set licence ${body.lic_no} → ${body.status} in FIS`);
      ok(res, r.data);
    })],

    // ===== bag audit trail (regulator, inspector, manufacturer for own bags) =====
    ['GET', '/api/portal/bag/:label', guard(['regulator', 'inspector', 'manufacturer'], (req, res, { params, user }) => {
      const h = bagHistory(params.label);
      if (user.role === 'manufacturer' && h.manufacturer_id !== user.party_id) return bad(res, 'Not your product', 403);
      ok(res, h);
    })],

    // ===== FIELD INSPECTOR =====
    ['GET', '/api/portal/inspector', guard(['inspector'], (req, res, { user }) => {
      const R = S().registry;
      const dealers = Object.values(R.dealers).filter((d) => d.region === user.region).map((d) => {
        const stock = stockOf(d.id);
        return { ...d, stock: stock.reduce((a, g) => a + g.count, 0), flagged: stock.reduce((a, g) => a + g.flagged, 0), expired: stock.filter((g) => g.expired).reduce((a, g) => a + g.count, 0), last_inspection: (S().inspections || []).find((i) => i.dealer_id === d.id) || null };
      });
      const names = dealers.map((d) => d.name);
      const tasks = S().alerts.filter((a) => a.region === user.region || names.some((n) => a.message.includes(n))).slice(0, 30);
      ok(res, { region: user.region, dealers, tasks, inspections: (S().inspections || []).filter((i) => i.region === user.region).slice(0, 30), stats: regionStats().find((x) => x.region === user.region) });
    })],
    ['POST', '/api/portal/inspection', guard(['inspector'], (req, res, { body, user }) => {
      const d = party(body.dealer_id);
      if (!d || d.role !== 'DEALER' || d.region !== user.region) throw new Error('Dealer not in your region');
      if (!['PASS', 'FAIL'].includes(body.result)) throw new Error('Result must be PASS or FAIL');
      const rec = { id: 'INS-' + (++S().seq), at: new Date().toISOString(), inspector: user.username, inspector_name: user.name, region: user.region, dealer_id: d.id, dealer_name: d.name, result: body.result, bag: body.bag ? String(body.bag).toUpperCase() : '', notes: String(body.notes || '').slice(0, 300), gps: body.gps || '' };
      S().inspections = [rec, ...(S().inspections || [])].slice(0, 200);
      save();
      feed('TFRA', `Inspection ${rec.result} at ${d.name} by ${user.name}`);
      pushEvent({ type: 'INSPECTION_LOGGED', inspector: user.username, dealer_lic: d.lic_no, result: rec.result, bag: rec.bag, gps: rec.gps, notes: rec.notes });
      if (rec.result === 'FAIL') alert('INSPECTION_FAILED', `${d.name}: ${rec.notes || 'inspection failed'}`, { region: d.region });
      ok(res, rec);
    })],
  ];
};
