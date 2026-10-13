// Shared helpers for every BlockFarming service: HMAC webhook security,
// a tiny dependency-free HTTP router, JSON persistence and logging.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORTS = {
  platform: +process.env.PLATFORM_PORT || 3000,
  chain: +process.env.CHAIN_PORT || 8899,
  mno: +process.env.MNO_PORT || 4000,
  tfra: +process.env.TFRA_PORT || 5000,
};
const URLS = {
  platform: `http://127.0.0.1:${PORTS.platform}`,
  chain: `http://127.0.0.1:${PORTS.chain}`,
  mno: `http://127.0.0.1:${PORTS.mno}`,
  tfra: `http://127.0.0.1:${PORTS.tfra}`,
};

// In production these come from a vault / KMS. One secret per trust boundary.
const SECRETS = {
  chain: process.env.CHAIN_SECRET || 'bf-chain-rpc-secret',
  validator: process.env.VALIDATOR_KEY || 'bf-tfra-validator-key',
  mno: process.env.MNO_HMAC_SECRET || 'bf-mno-webhook-secret',
  tfra: process.env.TFRA_HMAC_SECRET || 'bf-tfra-ruzuku-secret',
  pepper: process.env.TOKEN_PEPPER || 'bf-factory-token-pepper',
};

const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------- crypto ----------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');

function signBody(secret, body, ts = Date.now().toString()) {
  return { ts, sig: hmac(secret, ts + '.' + body) };
}
function signedHeaders(secret, body, extra = {}) {
  const { ts, sig } = signBody(secret, body);
  return { 'Content-Type': 'application/json', 'X-BF-Timestamp': ts, 'X-BF-Signature': sig, ...extra };
}
// Verifies HMAC signature + 5 minute replay window.
function verifySignature(secret, req, raw, maxAgeMs = 5 * 60 * 1000) {
  const ts = req.headers['x-bf-timestamp'];
  const sig = req.headers['x-bf-signature'];
  if (!ts || !sig) return { ok: false, reason: 'missing signature headers' };
  if (Math.abs(Date.now() - Number(ts)) > maxAgeMs) return { ok: false, reason: 'timestamp outside replay window' };
  const expected = hmac(secret, ts + '.' + raw);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(sig), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid HMAC signature' };
  return { ok: true };
}

// ---------- HTTP ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function createServer(name, routes, { staticDir } = {}) {
  const compiled = routes.map(([method, pattern, handler]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, handler };
  });
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
        return res.end();
      }
      for (const r of compiled) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        let body = {};
        if (raw) {
          const ct = req.headers['content-type'] || '';
          try {
            body = ct.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
          } catch (e) { return send(res, 400, { error: 'Malformed body' }); }
        }
        try {
          return await r.handler(req, res, { params, body, raw, query: Object.fromEntries(url.searchParams) });
        } catch (e) {
          console.error(`[${name}] ${req.method} ${url.pathname} failed:`, e);
          return send(res, 500, { error: e.message });
        }
      }
      if (staticDir && req.method === 'GET') {
        const file = path.join(staticDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^([\\/])+/, ''));
        if (file.startsWith(staticDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      send(res, 404, { error: 'Not found' });
    });
  });
}

async function http_json(method, url, obj, { headers = {}, timeoutMs = 5000, rawBody } = {}) {
  const body = rawBody !== undefined ? rawBody : obj !== undefined ? JSON.stringify(obj) : undefined;
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, data };
}

// ---------- persistence ----------
function jsonStore(file, initialFn) {
  const p = path.join(DATA_DIR, file);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { data = initialFn(); }
  let timer = null;
  const store = {
    get data() { return data; },
    set data(v) { data = v; store.save(); },
    save() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fs.writeFileSync(p + '.tmp', JSON.stringify(data, null, 1));
        fs.renameSync(p + '.tmp', p);
      }, 150);
    },
    reset() { data = initialFn(); store.save(); },
  };
  return store;
}

function logger(name, color) {
  const c = { green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, red: 31 }[color] || 37;
  return (...a) => console.log(`\x1b[${c}m[${name}]\x1b[0m`, ...a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { PORTS, URLS, SECRETS, sha256, hmac, signBody, signedHeaders, verifySignature, send, sendText, createServer, http_json, jsonStore, logger, sleep };
