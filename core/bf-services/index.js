
const express = require('express');
const bodyParser = require('body-parser');
const redis = require('redis');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const PORT_USSD = 8080;
const PORT_API = 3000;
const PORT_FRONTEND = 3001;

const REDIS_URL = process.env.REDIS_URL || 'redis://bf_infra:6379';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://blockfarming:blockfarming@bf_infra:5432/blockfarming';
const MNO_ADAPTER_URL = process.env.MNO_ADAPTER_URL || 'http://bf_mno_adapter:4000';

let redisClient;
let pool;

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'blockfarming_salt').digest('hex');
}
function genHex6() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function connectRedis(retries) {
  for (let i = 1; i <= retries; i++) {
    try {
      redisClient = redis.createClient({ url: REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 10000 } });
      redisClient.on('error', () => {});
      await redisClient.connect();
      console.log('Connected to Redis');
      return true;
    } catch (err) {
      console.log('Redis attempt ' + i + '/' + retries + ' failed: ' + err.message);
      try { await redisClient.disconnect(); } catch (e) {}
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

async function connectPostgres(retries) {
  for (let i = 1; i <= retries; i++) {
    try {
      pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
      const r = await pool.query('SELECT COUNT(*) FROM tokens');
      console.log('Connected to PostgreSQL. Tokens in DB: ' + r.rows[0].count);
      return true;
    } catch (err) {
      console.log('PostgreSQL attempt ' + i + '/' + retries + ' failed: ' + err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  return false;
}

async function redisGet(k) {
  try { if (!redisClient || !redisClient.isOpen) return null; return await redisClient.get(k); } catch (e) { return null; }
}
async function redisSet(k, v, ttl) {
  try { if (!redisClient || !redisClient.isOpen) return; await redisClient.setEx(k, ttl, v); } catch (e) {}
}

// ==================== USSD GATEWAY ====================
const ussdApp = express();
ussdApp.use(bodyParser.urlencoded({ extended: true }));
ussdApp.use(bodyParser.json());

ussdApp.post('/ussd', async (req, res) => {
  const { sessionId, phoneNumber, text } = req.body;
  console.log('USSD: ' + sessionId + ' | ' + phoneNumber + ' | ' + text);
  let response = '';
  if (text === '') {
    response = 'CON Welcome to BlockFarming\n1. Verify Code\n2. Check Price\n3. Report Fake\nEnter choice:';
  } else if (text === '1') {
    response = 'CON Enter 6-character code:';
  } else if (text.startsWith('1*')) {
    const tokenCode = text.split('*')[1];
    if (!tokenCode || tokenCode.length < 6) {
      response = 'END Invalid code. Enter 6 characters.';
    } else {
      try {
        const r = await fetch('http://localhost:' + PORT_API + '/api/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token_code: tokenCode, phone_number: phoneNumber })
        });
        const result = await r.json();
        if (result.valid) response = 'END ' + result.message + '\nProduct: ' + result.product + '\nPayment is processing.';
        else response = 'END ' + (result.message || 'Verification failed.');
      } catch (error) { response = 'END System busy. Try again.'; }
    }
  } else if (text === '2') {
    response = 'END Official Price:\nNPK: TZS 45,000\nUREA: TZS 38,000';
  } else if (text === '3') {
    response = 'END Report received.\nRef: RPT-' + Date.now();
  } else { response = 'END Invalid choice.'; }
  res.set('Content-Type', 'text/plain');
  res.send(response);
});
ussdApp.listen(PORT_USSD, () => console.log('USSD Gateway on port ' + PORT_USSD));

// ==================== CORE API ====================
const apiApp = express();
apiApp.use(express.json());

// ----- FIS Login: Step 1 -----
apiApp.post('/api/fis/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!pool) return res.status(503).json({ error: 'DB not ready' });

  try {
    const token = genHex6();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('DELETE FROM fis_tokens WHERE email = $1 AND verified = FALSE', [email.toLowerCase()]);
    await pool.query(
      'INSERT INTO fis_tokens (email, token_code, expires_at) VALUES ($1, $2, $3)',
      [email.toLowerCase(), token, expires]
    );
    console.log('[FIS] Token for ' + email + ' = ' + token);
    res.json({
      token_sent: true,
      email: email.toLowerCase(),
      demo_token: token,
      expires_in_seconds: 600,
      message: 'A 6-character verification token has been sent to ' + email
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- FIS Verify: Step 2 -----
apiApp.post('/api/fis/verify', async (req, res) => {
  const { email, token, password } = req.body;
  if (!email || !token || !password) return res.status(400).json({ error: 'Email, token and password required' });
  if (!pool) return res.status(503).json({ error: 'DB not ready' });

  try {
    const r = await pool.query(
      'SELECT id, expires_at, verified FROM fis_tokens WHERE email = $1 AND token_code = $2 ORDER BY id DESC LIMIT 1',
      [email.toLowerCase(), token.toUpperCase()]
    );
    if (r.rows.length === 0) return res.json({ verified: false, error: 'Invalid token.' });
    const row = r.rows[0];
    if (row.verified) return res.json({ verified: false, error: 'Token already used.' });
    if (new Date(row.expires_at) < new Date()) return res.json({ verified: false, error: 'Token expired.' });

    await pool.query('UPDATE fis_tokens SET verified = TRUE WHERE id = $1', [row.id]);

    const hash = hashPassword(password);
    await pool.query(
      `INSERT INTO users (email, password_hash, fis_linked)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (email) DO UPDATE SET password_hash = $2, fis_linked = TRUE`,
      [email.toLowerCase(), hash]
    );

    res.json({ verified: true, email: email.toLowerCase() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Normal Login (returning user) -----
apiApp.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!pool) return res.status(503).json({ error: 'DB not ready' });

  try {
    const hash = hashPassword(password);
    const r = await pool.query('SELECT id, email, fis_linked FROM users WHERE email = $1 AND password_hash = $2', [email.toLowerCase(), hash]);
    if (r.rows.length === 0) return res.status(401).json({ success: false, error: 'No account found with these credentials. Please register via FIS.' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [r.rows[0].id]);
    res.json({ success: true, user: { email: r.rows[0].email, fis_linked: r.rows[0].fis_linked } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Batch lookup -----
apiApp.get('/api/batch/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not ready' });
  try {
    const token = req.params.token.toUpperCase();
    const result = await pool.query(
      "SELECT t.token_code, t.status, b.batch_id, b.product_name, b.manufacturer, b.chemical_composition, b.manufacture_date, b.expiry_date FROM tokens t JOIN batches b ON t.batch_id = b.batch_id WHERE t.token_code = $1",
      [token]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found in registry.' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- Validate (USSD path) -----
apiApp.post('/api/validate', async (req, res) => {
  const { token_code, phone_number } = req.body;
  if (!token_code) return res.status(400).json({ error: 'Token required' });
  if (!pool) return res.status(503).json({ error: 'DB not ready' });

  try {
    const cached = await redisGet('token:' + token_code);
    if (cached === 'REDEEMED') return res.json({ valid: false, message: 'Code already used.', status: 'REDEEMED' });
    if (cached === 'PENDING') return res.json({ valid: true, message: 'Processing...', status: 'PENDING' });

    const result = await pool.query('SELECT token_code, batch_id, status FROM tokens WHERE token_code = $1', [token_code.toUpperCase()]);
    if (result.rows.length === 0) {
      await pool.query("INSERT INTO ussd_sessions (session_id, phone_number, token_code, response, session_status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id) DO NOTHING",
        ['SESS-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), phone_number || 'unknown', token_code, 'INVALID', 'FAILED']).catch(()=>{});
      return res.json({ valid: false, message: 'INVALID CODE. Fake product.', status: 'NOT_FOUND' });
    }
    const token = result.rows[0];
    if (token.status === 'REDEEMED') {
      await redisSet('token:' + token_code, 'REDEEMED', 3600);
      return res.json({ valid: false, message: 'Code already used.', status: 'REDEEMED' });
    }
    const batch = await pool.query('SELECT product_name, manufacturer FROM batches WHERE batch_id = $1', [token.batch_id]);
    await redisSet('token:' + token_code, 'PENDING', 60);
    await pool.query('UPDATE tokens SET status = $1, redeemed_at = NOW(), redeemed_by = $2 WHERE token_code = $3',
      ['REDEEMED', phone_number, token_code.toUpperCase()]);
    await redisSet('token:' + token_code, 'REDEEMED', 86400);
    await pool.query("INSERT INTO ussd_sessions (session_id, phone_number, token_code, response, session_status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id) DO NOTHING",
      ['SESS-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), phone_number || 'unknown', token_code, 'GENUINE', 'SUCCESS']).catch(()=>{});

    fetch(MNO_ADAPTER_URL + '/settle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_code, dealer_phone: phone_number, amount: 45000, provider: 'mpesa' })
    }).catch(e => console.error('Settlement error:', e.message));

    return res.json({
      valid: true, message: 'GENUINE PRODUCT. Price: TZS 45,000.', status: 'VALID',
      product: batch.rows[0] ? batch.rows[0].product_name : 'Fertilizer',
      manufacturer: batch.rows[0] ? batch.rows[0].manufacturer : 'Unknown',
      official_price: 45000
    });
  } catch (error) {
    console.error('Validation error:', error.message);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

apiApp.get('/api/stats', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not ready' });
  try {
    const tokens = await pool.query("SELECT COUNT(*) FILTER (WHERE status='UNREDEEMED') AS unredeemed, COUNT(*) FILTER (WHERE status='REDEEMED') AS redeemed, COUNT(*) AS total FROM tokens");
    const sessions = await pool.query("SELECT COUNT(*) AS total_sessions FROM ussd_sessions");
    const txns = await pool.query("SELECT COUNT(*) AS total_transactions, COALESCE(SUM(amount),0) AS total_amount FROM transactions");
    res.json({ tokens: tokens.rows[0], sessions: sessions.rows[0], transactions: txns.rows[0], timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

apiApp.get('/api/recent', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not ready' });
  try {
    const sessions = await pool.query("SELECT session_id, phone_number, token_code, response, session_status, created_at FROM ussd_sessions ORDER BY created_at DESC LIMIT 10");
    const tokens = await pool.query("SELECT token_code, batch_id, status, redeemed_at FROM tokens ORDER BY id DESC LIMIT 10");
    res.json({ sessions: sessions.rows, tokens: tokens.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

apiApp.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'bf-services', redis: redisClient && redisClient.isOpen ? 'connected' : 'disconnected', postgres: pool ? 'connected' : 'disconnected' });
});

apiApp.listen(PORT_API, () => console.log('Core API on port ' + PORT_API));

// ==================== FRONTEND + PROXY ====================
const frontendApp = express();
frontendApp.use(express.static(path.join(__dirname, 'public')));

frontendApp.use('/api', (req, res) => {
  const options = { hostname: 'localhost', port: PORT_API, path: '/api' + req.url, method: req.method, headers: req.headers };
  const proxy = http.request(options, (apiRes) => { res.writeHead(apiRes.statusCode, apiRes.headers); apiRes.pipe(res); });
  proxy.on('error', (e) => res.status(500).json({ error: e.message }));
  req.pipe(proxy);
});

frontendApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
frontendApp.listen(PORT_FRONTEND, () => console.log('Frontend on port ' + PORT_FRONTEND));

// ==================== BOOTSTRAP ====================
async function bootstrap() {
  console.log('Bootstrap: Waiting for infrastructure...');
  await connectPostgres(20);
  await connectRedis(20);
  console.log('Bootstrap complete.');
}
bootstrap();
