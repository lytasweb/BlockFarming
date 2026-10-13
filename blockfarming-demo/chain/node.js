// BlockFarming permissioned ledger node (Proof-of-Authority, Hyperledger-style).
// - Every transaction is executed by the TokenRegistry smart contract BEFORE it
//   enters the mempool, so invalid / double-spend transactions never get on chain.
// - Blocks are sealed every BLOCK_TIME ms, linked by SHA-256 prev_hash, carry a
//   Merkle root of their transactions and are signed by the TFRA validator key.
// - Contract state is never stored directly: it is rebuilt by replaying the chain.
const { PORTS, SECRETS, sha256, hmac, send, createServer, jsonStore, logger, verifySignature } = require('../shared/lib');

const log = logger('CHAIN', 'magenta');
const BLOCK_TIME = +process.env.BLOCK_TIME || 2500;
const VALIDATOR = 'TFRA-VALIDATOR-01';

const store = jsonStore('ledger.json', () => ({ blocks: [] }));

// ---------------- Merkle + block hashing ----------------
function merkleRoot(txs) {
  let layer = txs.map((t) => sha256(JSON.stringify(t)));
  if (!layer.length) return sha256('');
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) next.push(sha256(layer[i] + (layer[i + 1] || layer[i])));
    layer = next;
  }
  return layer[0];
}
function blockHash(b) {
  return sha256([b.index, b.timestamp, b.prev_hash, b.merkle_root, b.validator].join('|'));
}
function makeBlock(index, prev_hash, txs) {
  const b = { index, timestamp: new Date().toISOString(), prev_hash, merkle_root: merkleRoot(txs), validator: VALIDATOR, txs };
  b.hash = blockHash(b);
  b.signature = hmac(SECRETS.validator, b.hash);
  return b;
}

// ---------------- Smart contract: TokenRegistry ----------------
function emptyState() {
  return { batches: {}, tokens: {}, txIndex: {} };
}
let state = emptyState();
let mempool = [];

// Pure-ish contract execution: returns { ok, result } or { ok:false, error }.
function execute(st, tx) {
  const p = tx.payload;
  switch (tx.type) {
    case 'REGISTER_BATCH': {
      if (st.batches[p.batch_id]) return { ok: false, error: 'BATCH_EXISTS' };
      if (!Array.isArray(p.token_hashes) || p.token_hashes.length !== p.quantity) return { ok: false, error: 'TOKEN_COUNT_MISMATCH' };
      for (const h of p.token_hashes) if (st.tokens[h]) return { ok: false, error: 'TOKEN_COLLISION' };
      st.batches[p.batch_id] = {
        batch_id: p.batch_id, product_code: p.product_code, manufacturer: p.manufacturer,
        mfg_date: p.mfg_date, exp_date: p.exp_date, quantity: p.quantity, batch_hash: p.batch_hash,
        serials: p.token_hashes,
      };
      p.token_hashes.forEach((h, i) => {
        st.tokens[h] = { batch_id: p.batch_id, serial: i + 1, status: 'UNREDEEMED', holder: p.manufacturer, flagged: false };
      });
      return { ok: true, result: { batch_id: p.batch_id, tokens: p.quantity } };
    }
    case 'CUSTODY_TRANSFER': {
      const b = st.batches[p.batch_id];
      if (!b) return { ok: false, error: 'UNKNOWN_BATCH' };
      if (p.serial_from < 1 || p.serial_to > b.quantity || p.serial_from > p.serial_to) return { ok: false, error: 'BAD_SERIAL_RANGE' };
      for (let s = p.serial_from; s <= p.serial_to; s++) {
        const t = st.tokens[b.serials[s - 1]];
        if (t.holder !== p.from) return { ok: false, error: `NOT_CUSTODIAN: bag #${s} is held by ${t.holder}` };
        if (t.status !== 'UNREDEEMED') return { ok: false, error: `BAG_ALREADY_SOLD: #${s}` };
      }
      for (let s = p.serial_from; s <= p.serial_to; s++) st.tokens[b.serials[s - 1]].holder = p.to;
      return { ok: true, result: { moved: p.serial_to - p.serial_from + 1 } };
    }
    case 'REDEEM': {
      const t = st.tokens[p.token_hash];
      if (!t) return { ok: false, error: 'UNKNOWN_TOKEN' };
      if (t.status === 'REDEEMED') {
        // Idempotent for the same settlement reference, rejected for anyone else.
        if (t.redeem_ref === p.ref) return { ok: true, result: { idempotent: true, holder: t.redeemed_holder } };
        return { ok: false, error: 'ALREADY_REDEEMED' };
      }
      t.status = 'REDEEMED';
      t.redeem_ref = p.ref;
      t.redeemed_holder = t.holder;
      t.redeemed_at = tx.timestamp;
      return { ok: true, result: { holder: t.holder, batch_id: t.batch_id, serial: t.serial } };
    }
    case 'TAMPER_REPORT': {
      const b = st.batches[p.batch_id];
      if (!b || !b.serials[p.serial - 1]) return { ok: false, error: 'UNKNOWN_BAG' };
      st.tokens[b.serials[p.serial - 1]].flagged = true;
      return { ok: true, result: { flagged: true } };
    }
    default:
      return { ok: false, error: 'UNKNOWN_TX_TYPE' };
  }
}

function rebuildState() {
  state = emptyState();
  for (const b of store.data.blocks) {
    for (const tx of b.txs) {
      execute(state, tx);
      state.txIndex[tx.tx_id] = b.index;
    }
  }
}

function verifyChain() {
  const blocks = store.data.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const problems = [];
    if (merkleRoot(b.txs) !== b.merkle_root) problems.push('transactions do not match merkle_root (data was edited)');
    if (blockHash(b) !== b.hash) problems.push('block hash mismatch');
    if (hmac(SECRETS.validator, b.hash) !== b.signature) problems.push('validator signature invalid');
    if (i > 0 && b.prev_hash !== blocks[i - 1].hash) problems.push('prev_hash does not link to previous block');
    if (problems.length) return { valid: false, height: blocks.length, broken_at: b.index, problems };
  }
  return { valid: true, height: blocks.length, head: blocks.length ? blocks[blocks.length - 1].hash : null };
}

function ensureGenesis() {
  if (!store.data.blocks.length) {
    store.data.blocks.push(makeBlock(0, '0'.repeat(64), [{ tx_id: 'genesis', type: 'GENESIS', payload: { network: 'blockfarming-tz', authority: VALIDATOR }, timestamp: new Date().toISOString() }]));
    store.save();
  }
}

function sealBlock() {
  if (!mempool.length) return;
  const blocks = store.data.blocks;
  const prev = blocks[blocks.length - 1];
  const b = makeBlock(prev.index + 1, prev.hash, mempool);
  mempool.forEach((tx) => (state.txIndex[tx.tx_id] = b.index));
  mempool = [];
  blocks.push(b);
  store.save();
  log(`sealed block #${b.index} (${b.txs.length} tx) ${b.hash.slice(0, 16)}…`);
}

// ---------------- API ----------------
function authed(req, raw, res) {
  const v = verifySignature(SECRETS.chain, req, raw);
  if (!v.ok) { send(res, 401, { error: v.reason }); return false; }
  return true;
}

const routes = [
  ['GET', '/health', (req, res) => send(res, 200, { status: 'OK', height: store.data.blocks.length, mempool: mempool.length, validator: VALIDATOR, block_time_ms: BLOCK_TIME })],

  ['POST', '/tx', (req, res, { body, raw }) => {
    if (!authed(req, raw, res)) return;
    const tx = { tx_id: 'tx_' + sha256(raw + Date.now() + Math.random()).slice(0, 24), type: body.type, payload: body.payload, sender: body.sender || 'bf-platform', timestamp: new Date().toISOString() };
    const r = execute(state, tx);
    if (!r.ok) return send(res, 409, { ok: false, error: r.error });
    mempool.push(tx);
    state.txIndex[tx.tx_id] = null; // pending
    send(res, 202, { ok: true, tx_id: tx.tx_id, result: r.result, status: 'PENDING' });
  }],

  ['GET', '/tx/:id', (req, res, { params }) => {
    if (!(params.id in state.txIndex)) return send(res, 404, { error: 'unknown tx' });
    const bi = state.txIndex[params.id];
    send(res, 200, { tx_id: params.id, status: bi === null ? 'PENDING' : 'CONFIRMED', block: bi });
  }],

  ['GET', '/token/:hash', (req, res, { params }) => {
    const t = state.tokens[params.hash];
    if (!t) return send(res, 404, { error: 'unknown token' });
    send(res, 200, t);
  }],

  ['GET', '/batch/:id', (req, res, { params }) => {
    const b = state.batches[params.id];
    if (!b) return send(res, 404, { error: 'unknown batch' });
    const holders = {};
    b.serials.forEach((h, i) => {
      const t = state.tokens[h];
      const k = t.status === 'REDEEMED' ? `SOLD (via ${t.redeemed_holder})` : t.holder;
      (holders[k] = holders[k] || []).push(i + 1);
    });
    send(res, 200, { ...b, serials: undefined, holders });
  }],

  ['GET', '/chain', (req, res, { query }) => {
    const n = Math.min(+query.limit || 30, 200);
    send(res, 200, { height: store.data.blocks.length, mempool, blocks: store.data.blocks.slice(-n).reverse() });
  }],

  ['GET', '/verify', (req, res) => send(res, 200, verifyChain())],

  // ---- demo-only admin endpoints ----
  ['POST', '/admin/tamper', (req, res, { body, raw }) => {
    if (!authed(req, raw, res)) return;
    // Simulates an insider editing the database directly (no re-hash, no signature).
    const blocks = store.data.blocks;
    const target = blocks.slice(1).reverse().find((b) => b.txs.some((t) => t.type === 'REDEEM' || t.type === 'REGISTER_BATCH'));
    if (!target) return send(res, 400, { error: 'no block to tamper with yet' });
    const tx = target.txs.find((t) => t.type === 'REDEEM' || t.type === 'REGISTER_BATCH');
    if (tx.type === 'REGISTER_BATCH') tx.payload.quantity = tx.payload.quantity + 500;
    else tx.payload.ref = 'GHOST-' + tx.payload.ref;
    store.save();
    log(`!! TAMPER simulated on block #${target.index}`);
    send(res, 200, { tampered_block: target.index, tx_id: tx.tx_id, change: tx.type === 'REGISTER_BATCH' ? 'quantity +500 (ghost bags)' : 'redeem ref rewritten', verify: verifyChain() });
  }],
  ['POST', '/admin/restore', (req, res, { raw }) => {
    if (!authed(req, raw, res)) return;
    // Restore from honest peer copy (we kept a snapshot in memory at each seal).
    store.data.blocks = JSON.parse(honestSnapshot);
    store.save();
    rebuildState();
    send(res, 200, { restored: true, verify: verifyChain() });
  }],
  ['POST', '/admin/reset', (req, res, { raw }) => {
    if (!authed(req, raw, res)) return;
    store.reset();
    mempool = [];
    ensureGenesis();
    rebuildState();
    honestSnapshot = JSON.stringify(store.data.blocks);
    send(res, 200, { reset: true });
  }],
];

// "Peer replica": an honest copy the node can resync from after tamper detection.
let honestSnapshot = '[]';

ensureGenesis();
const v = verifyChain();
if (!v.valid) log('WARNING: ledger on disk failed verification at block', v.broken_at, v.problems);
rebuildState();
honestSnapshot = JSON.stringify(store.data.blocks);

setInterval(() => {
  const before = store.data.blocks.length;
  sealBlock();
  if (store.data.blocks.length !== before && verifyChain().valid) honestSnapshot = JSON.stringify(store.data.blocks);
}, BLOCK_TIME);

createServer('chain', routes).listen(PORTS.chain, () => log(`ledger node on :${PORTS.chain}  height=${store.data.blocks.length}  block_time=${BLOCK_TIME}ms`));
