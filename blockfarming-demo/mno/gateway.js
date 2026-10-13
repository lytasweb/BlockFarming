// Mock Mobile Money aggregation gateway (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa).
// Security model (as the real integration will be):
//  - every payout request must carry an HMAC-SHA256 signature + timestamp (replay window)
//  - Idempotency-Key guarantees a retried request never pays twice
//  - result is delivered asynchronously with a signed callback (webhook) to the platform
const { PORTS, URLS, SECRETS, send, createServer, jsonStore, logger, verifySignature, signedHeaders, sha256 } = require('../shared/lib');

const log = logger('MNO', 'yellow');
const store = jsonStore('mno.json', () => ({
  providers: {
    mpesa: { name: 'Vodacom M-Pesa', up: true, latency_ms: 1200 },
    mixx: { name: 'Mixx by Yas (Tigo Pesa)', up: true, latency_ms: 1500 },
    airtel: { name: 'Airtel Money', up: true, latency_ms: 1300 },
    halopesa: { name: 'HaloPesa', up: true, latency_ms: 1800 },
  },
  payouts: {},
  rejected: [],
}));

async function callback(p) {
  const body = JSON.stringify({ idempotency_key: p.idempotency_key, payout_id: p.payout_id, status: p.status, provider: p.provider, provider_ref: p.provider_ref, amount: p.amount, msisdn: p.msisdn, completed_at: p.completed_at });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(URLS.platform + '/webhooks/mno', { method: 'POST', headers: signedHeaders(SECRETS.mno, body), body, signal: AbortSignal.timeout(4000) });
      if (r.ok) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  log('callback delivery failed for', p.idempotency_key);
}

const routes = [
  ['GET', '/health', (req, res) => send(res, 200, { status: 'OK', providers: store.data.providers })],

  ['POST', '/v1/payouts', (req, res, { body, raw }) => {
    const v = verifySignature(SECRETS.mno, req, raw);
    if (!v.ok) {
      store.data.rejected.unshift({ at: new Date().toISOString(), reason: v.reason, ip: req.socket.remoteAddress, body: body });
      store.data.rejected = store.data.rejected.slice(0, 20);
      store.save();
      log('REJECTED payout request:', v.reason);
      return send(res, 401, { error: v.reason });
    }
    const key = req.headers['idempotency-key'];
    if (!key) return send(res, 400, { error: 'Idempotency-Key header required' });

    const existing = store.data.payouts[key];
    if (existing) {
      log(`duplicate request for ${key} -> returning original (${existing.status}), no double payment`);
      if (existing.status !== 'PROCESSING') callback(existing);
      return send(res, 200, { ...existing, duplicate: true });
    }

    const prov = store.data.providers[body.provider];
    if (!prov) return send(res, 400, { error: 'unknown provider' });
    if (!prov.up) {
      log(`${prov.name} unavailable -> 503 for ${key}`);
      return send(res, 503, { error: `${prov.name} gateway unavailable` });
    }
    const p = {
      payout_id: 'PO-' + sha256(key).slice(0, 10).toUpperCase(),
      idempotency_key: key, provider: body.provider, msisdn: body.msisdn, amount: body.amount,
      reference: body.reference, status: 'PROCESSING', created_at: new Date().toISOString(),
    };
    store.data.payouts[key] = p;
    store.save();
    log(`${prov.name}: TZS ${Number(body.amount).toLocaleString()} -> ${body.msisdn} (${key}) accepted`);
    setTimeout(() => {
      p.status = 'SUCCESS';
      p.provider_ref = body.provider.slice(0, 2).toUpperCase() + Date.now().toString(36).toUpperCase();
      p.completed_at = new Date().toISOString();
      store.save();
      callback(p);
    }, prov.latency_ms);
    send(res, 202, p);
  }],

  ['GET', '/v1/payouts/:key', (req, res, { params }) => {
    const p = store.data.payouts[params.key];
    if (!p) return send(res, 404, { error: 'not found' });
    send(res, 200, p);
  }],

  // ---- demo admin ----
  ['GET', '/admin/state', (req, res) => {
    const list = Object.values(store.data.payouts).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30);
    send(res, 200, { providers: store.data.providers, payouts: list, rejected: store.data.rejected });
  }],
  ['POST', '/admin/provider/:p', (req, res, { params, body }) => {
    const prov = store.data.providers[params.p];
    if (!prov) return send(res, 404, { error: 'unknown provider' });
    prov.up = !!body.up;
    store.save();
    log(`${prov.name} is now ${prov.up ? 'UP' : 'DOWN'}`);
    send(res, 200, prov);
  }],
  ['POST', '/admin/reset', (req, res) => { store.reset(); send(res, 200, { reset: true }); }],
];

createServer('mno', routes).listen(PORTS.mno, () => log(`mobile money gateway on :${PORTS.mno}`));
