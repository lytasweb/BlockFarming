/* BlockFarming stakeholder portal: sidebar navigation, one dashboard per role. Data is scoped server-side. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const dt = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const tm = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const kpis = (list) => `<div class="kpis">${list.map(([l, v, c]) => `<div class="kpi ${c || ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>`;
const table = (head, rows, empty = 'Nothing yet') => `<div class="tablewrap"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="muted">${empty}</td></tr>`}</table></div>`;
const card = (title, body, sub = '') => `<div class="card"><h3>${title}${sub ? ` <small class="muted">${sub}</small>` : ''}</h3>${body}</div>`;
const formData = (f) => Object.fromEntries(new FormData(f));
function toast(msg, err) {
  const el = $('#toast'); el.textContent = msg; el.className = err ? 'err' : ''; el.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 4000);
}

let token = null;
try { token = sessionStorage.getItem('bf_token'); } catch (e) {}
let user = null;
async function api(path, body) {
  const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/auth/login') { logout(); throw new Error('Session expired'); }
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}
function fillSelect(el, opts) {
  if (!el) return;
  const html = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (el.dataset.sig === html) return;
  el.dataset.sig = html; const cur = el.value; el.innerHTML = html;
  if (opts.some(([v]) => v === cur)) el.value = cur;
}
// update a container only when its content changed (keeps scroll position / open dropdowns)
const set = (id, html) => { const el = document.getElementById(id); if (el && el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
const has = (id) => !!document.getElementById(id);

// ================= LOGIN =================
const ROLE_NAMES = { manufacturer: 'Manufacturer', distributor: 'Distributor', dealer: 'Agro-dealer', regulator: 'TFRA regulator', inspector: 'Field inspector', admin: 'System administrator' };
async function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false;
  const d = await api('/api/auth/demo-accounts');
  $('#demo-pw').textContent = `(password: ${d.password})`;
  $('#accounts').innerHTML = d.accounts.map((a) => `<button data-u="${esc(a.username)}"><small>${ROLE_NAMES[a.role]}</small>${esc(a.name)}</button>`).join('');
  $('#accounts').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $('[name=username]').value = b.dataset.u; $('[name=password]').value = d.password; $('[name=password]').focus(); };
}
$('#f-login').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/auth/login', formData(e.target));
    token = r.token;
    try { sessionStorage.setItem('bf_token', token); } catch (err) {}
    $('#login-err').innerHTML = '';
    start();
  } catch (err) { $('#login-err').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
};
function logout() {
  token = null; user = null;
  try { sessionStorage.removeItem('bf_token'); } catch (e) {}
  clearInterval(timer); $('#view').innerHTML = '';
  history.replaceState(null, '', location.pathname);
  showLogin();
}
$('#btn-out').onclick = logout;

// ================= SHARED BLOCKS =================
const traceCard = (id) => `<div class="card"><h3>Trace a bag <small class="muted">full ledger audit trail</small></h3>
  <form class="form inline" onsubmit="trace(event,'${id}')"><label>Bag number<input name="label" placeholder="MM26001-0003" required /></label><span></span><button class="btn small">Trace</button></form>
  <div id="${id}"></div></div>`;
window.trace = async (e, id) => {
  e.preventDefault();
  const el = document.getElementById(id);
  try {
    const h = await api('/api/portal/bag/' + encodeURIComponent(formData(e.target).label.trim()));
    const s = h.settlement;
    el.innerHTML = `<div class="banner ${h.flagged || h.expired ? 'bad' : 'good'}"><div><div class="big">${esc(h.label)} · ${esc(h.product)}</div><span class="k">status</span>${badge(h.status)} ${h.flagged ? badge('TAMPER_FLAGGED') : ''} ${h.expired ? badge('EXPIRED') : ''}
      <br><span class="k">now held by</span>${esc(h.holder)} · <span class="k">expires</span>${esc(h.exp_date)}</div></div>
      <div class="timeline">
        <div>Registered by <b>${esc(h.manufacturer)}</b> (mfg ${esc(h.mfg_date)})<small>batch hash ${esc(h.batch_hash.slice(0, 24))}… · block #${h.registered_block ?? '…'}</small></div>
        ${h.custody.map((c) => `<div>${esc(c.from)} → <b>${esc(c.to)}</b><small>${dt(c.at)} · GPS ${esc(c.gps || '—')} · block #${c.block ?? '…'} · ${esc(c.tx_id.slice(0, 16))}…</small></div>`).join('')}
        ${h.inspections.map((i) => `<div class="${i.result === 'FAIL' ? 'bad' : ''}">Inspection ${esc(i.result)} by ${esc(i.inspector_name)}<small>${dt(i.at)} · ${esc(i.notes)}</small></div>`).join('')}
        ${s ? `<div class="${['MANUAL_REVIEW', 'REJECTED', 'BLOCKED_DOUBLE_SPEND'].includes(s.state) ? 'bad' : ''}">Verified by farmer <b>${esc(s.farmer_ref)}</b> via ${esc(s.channel)}${s.cell_id ? ' @ ' + esc(s.cell_id) : ''}<small>${dt(s.created_at)} · ref ${esc(s.ref)} · block #${s.block ?? '…'} · settlement ${esc(s.state)}${s.amount ? ' · TZS ' + fmt(s.amount) + ' to ' + esc(s.dealer_name) : ''}</small></div>` : '<div>Not yet sold to a farmer</div>'}
      </div>`;
  } catch (err) { el.innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
};

const transferCard = (title, toLabel) => `<div class="card"><h3>${title}</h3>
  <form id="f-transfer" class="form">
    <label>Batch (from your stock)<select name="batch_id" id="t-batch"></select></label>
    <label>${toLabel}<select name="to" id="t-to"></select></label>
    <label>Bag # from<input name="serial_from" type="number" id="t-from" required /></label>
    <label>Bag # to<input name="serial_to" type="number" id="t-to-serial" required /></label>
    <label>GPS (scan location)<input name="gps" value="-6.8240,37.6600" /></label><span></span>
    <button class="btn">Scan &amp; sign transfer to ledger</button>
  </form><div id="t-result" class="result"></div></div>`;
function bindTransfer() {
  $('#f-transfer').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/portal/transfer', formData(e.target));
      $('#t-result').innerHTML = `<div class="ok-box">${r.qty} bags → ${esc(r.to_name)} · tx <span class="mono">${esc(r.tx_id)}</span></div>`;
      $('#t-from').value = ''; refresh();
    } catch (err) { $('#t-result').innerHTML = `<div class="err-box">Rejected: ${esc(err.message)}</div>`; }
  };
  $('#t-batch').onchange = () => prefillRange();
}
let lastStock = [];
function prefillRange() {
  const g = lastStock.find((x) => x.batch_id === $('#t-batch').value);
  if (!g) return;
  const m = g.ranges.split(',')[0].replace('#', '').split('–');
  $('#t-from').value = m[0]; $('#t-to-serial').value = m[1] || m[0];
}
function fillTransfer(stock, receivers) {
  if (!has('t-batch')) return;
  lastStock = stock;
  const before = $('#t-batch').value;
  fillSelect($('#t-batch'), stock.length ? stock.map((g) => [g.batch_id, `${g.batch_id} · ${g.product} · ${g.count} bags (${g.ranges})`]) : [['', 'No bags in stock (register or receive a batch first)']]);
  fillSelect($('#t-to'), receivers.map((p) => [p.id, `${p.name}${p.region ? ' · ' + p.region : ''}${p.status !== 'ACTIVE' ? ' · ' + p.status : ''}`]));
  if (!$('#t-from').value || before !== $('#t-batch').value) prefillRange();
}
const stockTable = (stock) => table(['Batch', 'Product', 'Bags', 'Serials', 'Expiry', 'Flags'], stock.map((g) => `<tr><td>${esc(g.batch_id)}</td><td>${esc(g.product)}</td><td><b>${g.count}</b></td><td class="mono small">${esc(g.ranges)}</td><td>${esc(g.exp_date)} ${g.expired ? badge('EXPIRED') : ''}</td><td>${g.flagged ? badge('TAMPER_FLAGGED') + ' ×' + g.flagged : ''}</td></tr>`), 'No stock on hand');
const transfersTable = (list, me) => table(['Time', 'Batch', 'Direction', 'Counterparty', 'Bags', 'Block'], list.map((c) => `<tr><td>${dt(c.at)}</td><td>${esc(c.batch_id)}</td><td>${c.to === me ? '⬇ received' : '⬆ shipped'}</td><td>${esc(c.to === me ? c.from_name : c.to_name)}</td><td>#${c.serial_from}–${c.serial_to} (${c.qty})</td><td>${c.block ?? '…'}</td></tr>`));
const alertList = (list) => list.length ? `<div class="list">${list.map((a) => `<div class="alert"><b>${esc(a.type)} · ${dt(a.at)}</b>${esc(a.message)}</div>`).join('')}</div>` : '<div class="muted small">No alerts</div>';

// ----- ledger (regulator read-only, admin with attack/tamper tools) -----
function renderLedger(c) {
  const v = c.verify;
  set('x-verify', v.valid
    ? `<div class="banner good"><div class="big">✓ Ledger integrity verified</div><div><span class="k">blocks</span>${v.height}</div><div><span class="k">head</span><span class="mono">${esc((v.head || '').slice(0, 24))}…</span></div><div><span class="k">validator</span>TFRA-VALIDATOR-01 (PoA)</div></div>`
    : `<div class="banner bad"><div class="big">✗ TAMPERING DETECTED at block #${v.broken_at}</div><div class="small">${v.problems.map(esc).join('<br>')}</div></div>`);
  set('x-blocks', c.blocks.map((b) => `<details class="block ${!v.valid && b.index === v.broken_at ? 'broken' : ''}"><summary><b>#${b.index}</b><span class="h">${esc(b.hash.slice(0, 20))}…</span><span class="muted">prev ${esc(b.prev_hash.slice(0, 12))}…</span><span>${b.txs.length} tx: ${[...new Set(b.txs.map((x) => x.type))].join(', ')}</span><span class="muted">${tm(b.timestamp)}</span></summary><pre>${esc(JSON.stringify(b.txs.map((x) => ({ ...x, payload: x.payload && x.payload.token_hashes ? { ...x.payload, token_hashes: x.payload.token_hashes.slice(0, 3).map((h) => h.slice(0, 20) + '…').concat([`… ${x.payload.token_hashes.length} hashes`]) } : x.payload })), null, 2))}\nmerkle_root: ${b.merkle_root}\nsignature:   ${b.signature}</pre></details>`).join(''));
}
// ----- TFRA integration (regulator read-only, admin with FIS actions) -----
function renderIntegration(S, EXT) {
  const R = S.registry; if (!R) return;
  set('x-regmeta', `<div class="banner ${String(S.registry_source).startsWith('LIVE') ? 'good' : 'bad'}"><div><span class="k">FIS registry</span><b>${esc(S.registry_source)}</b></div><div><span class="k">last sync</span>${tm(S.registry_synced_at)}</div><div><span class="k">mode</span>signed GET every 30 s</div><div><span class="k">Ruzuku outbox pending</span>${S.outbox.filter((o) => o.status !== 'DELIVERED').length}</div><div><span class="k">quarantined</span>${S.quarantine.length}</div></div>`);
  set('x-products', table(['Code', 'Product', 'Max price', 'Subsidy'], Object.values(R.products).map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${fmt(p.price_ceiling)}</td><td>${fmt(p.subsidy)}</td></tr>`)));
  set('x-dealers', table(['Licence', 'Name', 'MSISDN', 'Wallet', 'Region', 'Status'], Object.values(R.dealers).map((d) => `<tr><td>${esc(d.lic_no)}</td><td>${esc(d.name)}</td><td class="mono">${esc(d.msisdn)}</td><td>${esc(d.wallet)}</td><td>${esc(d.region)}</td><td>${badge(d.status)}</td></tr>`)));
  set('x-quarantine', S.quarantine.length ? S.quarantine.map((q) => `<div class="alert"><b>${esc(q.kind)} · ${esc(q.reason)}</b><span class="mono small">${esc(JSON.stringify(q.record))}</span></div>`).join('') : '<div class="muted small">None</div>');
  set('x-outbox', table(['Event', 'Type', 'Status', 'Tries', 'ACK', 'Legacy payload sent'], S.outbox.map((o) => `<tr><td class="mono small">${esc(o.id)}</td><td>${esc(o.legacy.TXN_TYPE)}${o.legacy.ALERT_CODE ? ' / ' + esc(o.legacy.ALERT_CODE) : ''}</td><td>${badge(o.status)}${o.last_error && o.status !== 'DELIVERED' ? `<div class="small muted">${esc(o.last_error)}</div>` : ''}</td><td>${o.attempts}</td><td class="mono">${esc(o.ack || '')}</td><td class="mono small">${esc(JSON.stringify(o.legacy)).slice(0, 160)}…</td></tr>`)));
  if (EXT && EXT.tfra && has('x-ruzuku')) { const txt = JSON.stringify(EXT.tfra.received.slice(0, 6), null, 2); if ($('#x-ruzuku').textContent !== txt) $('#x-ruzuku').textContent = txt; }
  fillSelect($('#x-price-product'), Object.values(R.products).map((p) => [p.code, p.name]));
}
const integrationHtml = (admin) => `<div id="x-regmeta"></div>
  ${admin ? `<div class="card"><h3>TFRA officer actions in FIS <small class="muted">changes are pulled into BlockFarming</small></h3>
    <form id="f-price" class="form inline"><label>Product<select name="code" id="x-price-product"></select></label><label>New price ceiling (TZS)<input name="price" type="number" value="43000" /></label><button class="btn small">Update in FIS</button></form>
    <div class="btnrow"><button class="btn small ghost" id="btn-sync">Sync registry now</button></div></div>` : ''}
  <div class="grid2">${card('PULL · price ceilings &amp; subsidy', '<div id="x-products"></div>', 'normalised from "45,000/=" etc.')}${card('Quarantined records', '<div id="x-quarantine"></div>', 'never guessed')}</div>
  ${card('PULL · licensed agro-dealers', '<div id="x-dealers"></div>')}
  ${card('PUSH · ledger events → Ruzuku', '<div id="x-outbox"></div>', 'HMAC-signed webhook, outbox with retry')}
  ${card('Received by Ruzuku (legacy format)', '<pre id="x-ruzuku" class="code"></pre>')}`;
function bindIntegration() {
  if (has('f-price')) $('#f-price').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/ext/tfra/price', formData(e.target)); toast('Price changed in FIS and synced: USSD option 2 shows it now'); refresh(); } catch (err) { toast(err.message, true); } };
  if (has('btn-sync')) $('#btn-sync').onclick = async () => { const r = await api('/api/registry/sync', {}); toast(r.ok ? `Synced (${r.quarantined} quarantined)` : 'FIS unreachable: using cached registry', !r.ok); refresh(); };
}

// ================= ROLE DEFINITIONS =================
// Each section: id, label, icon, group, sub, html(), bind?()
const VIEWS = {
  // ---------------- MANUFACTURER ----------------
  manufacturer: {
    load: () => api('/api/portal/manufacturer'),
    sections: [
      { id: 'overview', label: 'Overview', icon: '📊', sub: 'Production and where your bags are now', html: () => `<div id="m-kpi"></div>${card('My batches: where is every bag now?', '<div id="m-batches"></div>')}` },
      { id: 'register', label: 'Register batch', icon: '🏭', group: 'Operations', sub: 'Generate single-use codes and anchor the batch on the ledger', html: () => `<div class="card"><h3>Register a production batch</h3>
          <form id="f-batch" class="form">
            <label>Product (TFRA registry)<select name="product_code" id="m-product"></select></label>
            <label>Bags in batch<input name="quantity" type="number" value="20" min="1" max="200" /></label>
            <label>Manufactured<input name="mfg_date" type="date" id="m-mfg" /></label>
            <label>Expires<input name="exp_date" type="date" id="m-exp" /></label>
            <button class="btn">Generate codes → hash → register on ledger</button>
          </form><div id="m-result" class="result"></div>
          <p class="muted small">Plain codes go only to the secure label printer. The ledger receives one HMAC-SHA256 hash per bag plus a batch hash.</p></div>`,
        bind() {
          const d = new Date(); $('#m-mfg').value = d.toISOString().slice(0, 10); d.setFullYear(d.getFullYear() + 2); $('#m-exp').value = d.toISOString().slice(0, 10);
          $('#f-batch').onsubmit = async (e) => {
            e.preventDefault();
            try {
              const r = await api('/api/portal/manufacturer/batch', formData(e.target));
              $('#m-result').innerHTML = `<div class="ok-box">Batch <b>${esc(r.batch_id)}</b> on ledger · tx <span class="mono">${esc(r.tx_id)}</span><br>${esc(r.printed)}<br>Batch hash <span class="mono">${esc(r.batch_hash.slice(0, 32))}…</span></div>`;
              refresh();
            } catch (err) { $('#m-result').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
          };
        } },
      { id: 'dispatch', label: 'Dispatch', icon: '🚚', group: 'Operations', sub: 'Ship bags to licensed regional distributors', html: () => `${transferCard('Ship to a regional distributor', 'Distributor')}${card('Dispatch log', '<div id="m-transfers"></div>')}`, bind: bindTransfer },
      { id: 'trace', label: 'Trace a bag', icon: '🔎', group: 'Audit', sub: 'Follow any of your bags from factory to farmer', html: () => traceCard('m-trace') },
    ],
    render(d) {
      setUserMeta(`${d.me.lic_no}`);
      set('m-kpi', kpis([['Bags produced', d.totals.produced], ['At factory', d.totals.at_factory], ['Sold to farmers', d.totals.sold], ['Batches', d.batches.length], ['VOID / tamper reports', d.totals.flagged, d.totals.flagged ? 'bad' : '']]));
      fillSelect($('#m-product'), d.products.map((p) => [p.code, `${p.name} · max TZS ${fmt(p.price_ceiling)}`]));
      fillTransfer(d.stock, d.distributors);
      set('m-batches', table(['Batch', 'Product', 'Qty', 'Expiry', 'Location of bags', 'Sold', 'Block'], d.batches.map((b) => `<tr><td><b>${esc(b.batch_id)}</b></td><td>${esc(b.product)}</td><td>${b.quantity}</td><td>${esc(b.exp_date)} ${b.expired ? badge('EXPIRED') : ''}</td><td class="small">${Object.entries(b.holders).map(([k, v]) => `${esc(k)}: <b>${v.count}</b> <span class="muted">(${esc(v.ranges)})</span>`).join('<br>')}</td><td>${b.sold}/${b.quantity}</td><td>${b.block ?? '…'}</td></tr>`)));
      set('m-transfers', transfersTable(d.transfers, user.party_id));
    },
  },

  // ---------------- DISTRIBUTOR ----------------
  distributor: {
    load: () => api('/api/portal/distributor'),
    sections: [
      { id: 'overview', label: 'Overview', icon: '📊', sub: 'Warehouse stock and regional quota', html: () => `<div id="d-kpi"></div>${card('Stock on hand <small class="muted">from the ledger</small>', '<div id="d-stock"></div>')}` },
      { id: 'dispatch', label: 'Dispatch to dealers', icon: '🚚', group: 'Operations', sub: 'Scan bags out to licensed agro-dealers', html: () => `<div class="grid2">${transferCard('Dispatch to a licensed agro-dealer', 'Agro-dealer')}${card('Stock on hand', '<div id="d-stock"></div>')}</div>`, bind: bindTransfer },
      { id: 'dealers', label: 'Agro-dealers', icon: '🏪', group: 'Operations', sub: 'TFRA licence status of the dealers you supply', html: () => card('Agro-dealers', '<div id="d-dealers"></div>') },
      { id: 'history', label: 'Receipts & dispatches', icon: '📦', group: 'Records', sub: 'Every custody transfer you signed', html: () => card('Custody history', '<div id="d-transfers"></div>') },
      { id: 'alerts', label: 'Alerts', icon: '🚨', group: 'Records', sub: 'Alerts involving your shipments', html: () => card('Alerts', '<div id="d-alerts"></div>') },
    ],
    badges: (d) => ({ alerts: d.alerts.length }),
    render(d) {
      setUserMeta(`${d.me.lic_no} · ${d.me.region}`);
      set('d-kpi', kpis([['Bags on hand', d.totals.on_hand], ['Received', d.totals.received], ['Dispatched', d.totals.shipped], [`${d.me.region} quota used`, d.totals.region_quota_used != null ? d.totals.region_quota_used + '%' : '—', d.totals.region_quota_used > 90 ? 'warn' : '']]));
      set('d-stock', stockTable(d.stock));
      fillTransfer(d.stock, d.dealers);
      set('d-dealers', table(['Dealer', 'Region', 'Licence', 'Wallet', 'Bags in shop'], d.dealers.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.region)}</td><td>${badge(x.status)}</td><td>${esc(x.wallet)}</td><td>${x.stock}</td></tr>`)));
      set('d-alerts', alertList(d.alerts));
      set('d-transfers', transfersTable(d.transfers, user.party_id));
    },
  },

  // ---------------- AGRO-DEALER ----------------
  dealer: {
    load: () => api('/api/portal/dealer'),
    sections: [
      { id: 'overview', label: 'Overview', icon: '📊', sub: 'Licence, sales and subsidy at a glance', html: () => `<div id="a-banner"></div><div id="a-kpi"></div>${card('Official prices: show these to farmers', '<div id="a-prices" class="price-board"></div>')}` },
      { id: 'sales', label: 'Sales & subsidy', icon: '💰', group: 'Shop', sub: 'Bags verified by farmers and your reimbursements', html: () => card('Sales verified by farmers &amp; subsidy reimbursements', '<div id="a-sales"></div>') },
      { id: 'stock', label: 'Stock', icon: '📦', group: 'Shop', sub: 'Bags in your shop according to the ledger', html: () => `${card('Stock in my shop', '<div id="a-stock"></div>')}${card('Deliveries received', '<div id="a-transfers"></div>')}` },
      { id: 'messages', label: 'Notifications', icon: '✉️', group: 'Shop', sub: 'SMS from BlockFarming and alerts about your shop', html: () => `<div class="grid2">${card('SMS notifications', '<div id="a-sms" class="list"></div>')}${card('Alerts about my shop', '<div id="a-alerts"></div>')}</div>` },
    ],
    badges: (d) => ({ sales: d.totals.review, messages: d.alerts.length }),
    render(d) {
      const m = d.me;
      setUserMeta(`${m.lic_no} · ${m.region}`);
      set('a-banner', `<div class="banner ${m.status === 'ACTIVE' ? 'good' : 'bad'}"><div><span class="k">TFRA licence</span><span class="big">${esc(m.status)}</span></div><div><span class="k">licence no.</span>${esc(m.lic_no)}</div><div><span class="k">expires</span>${esc(m.license_expiry)}</div><div><span class="k">subsidy paid to</span>${esc(m.wallet.toUpperCase())} ${esc(m.msisdn)}</div>${m.status !== 'ACTIVE' ? '<div><b>Payouts are held for TFRA review while the licence is not active.</b></div>' : ''}</div>`);
      set('a-kpi', kpis([['Bags in shop', d.totals.on_hand], ['Sold (verified)', d.totals.sold], ['Subsidy received (TZS)', fmt(d.totals.paid)], ['Payments in progress', d.totals.pending, d.totals.pending ? 'warn' : ''], ['Under TFRA review', d.totals.review, d.totals.review ? 'bad' : ''], ['Flagged / expired bags', d.totals.flagged + d.totals.expired, d.totals.flagged + d.totals.expired ? 'bad' : '']]));
      set('a-prices', d.prices.map((p) => `<div>${esc(p.name)}<b>TZS ${fmt(p.price_ceiling)}</b><span class="small muted">subsidy you receive: ${fmt(p.subsidy)}</span></div>`).join(''));
      set('a-sales', table(['Time', 'Bag', 'Product', 'Farmer (anon.)', 'Channel', 'Settlement', 'Subsidy', 'MNO ref', 'Ledger'], d.sales.map((s) => `<tr><td>${dt(s.created_at)}</td><td>${esc(s.label)}</td><td>${esc(s.product)}</td><td class="mono">${esc(s.farmer_ref)}</td><td>${esc(s.channel)}</td><td>${badge(s.state)}<div class="small muted">${esc(s.note)}</div></td><td>${s.amount ? fmt(s.amount) : '—'}</td><td class="mono">${esc(s.provider_ref || '')}</td><td>#${s.block ?? '…'}</td></tr>`), 'No sales yet. They appear when a farmer verifies a bag from your shop.'));
      set('a-stock', stockTable(d.stock));
      set('a-sms', d.sms.length ? d.sms.map((x) => `<div class="sms ${x.kind}"><div class="meta">${dt(x.at)}</div>${esc(x.text)}</div>`).join('') : '<div class="muted small">No messages</div>');
      set('a-transfers', transfersTable(d.transfers, user.party_id));
      set('a-alerts', alertList(d.alerts));
    },
  },

  // ---------------- TFRA REGULATOR ----------------
  regulator: {
    async load(sec) {
      const d = await api('/api/portal/regulator');
      if (sec === 'ledger') d.chain = await api('/api/chain');
      if (sec === 'integration') [d.state, d.ext] = await Promise.all([api('/api/state'), api('/api/ext')]);
      return d;
    },
    sections: [
      { id: 'overview', label: 'National overview', icon: '📊', sub: 'Subsidy distribution across all regions', html: () => `<div id="r-ledger"></div><div id="r-kpi"></div>${card('Regional distribution &amp; subsidy', '<div id="r-regions"></div>')}` },
      { id: 'review', label: 'Payout review', icon: '⚖️', group: 'Decisions', sub: 'Payouts held by the system for an officer decision', html: () => card('Payouts awaiting TFRA decision', '<div id="r-review"></div>') },
      { id: 'licences', label: 'Licences', icon: '🪪', group: 'Decisions', sub: 'Suspend or reinstate (FIS is the system of record)', html: () => card('Distributor &amp; dealer licences', '<div id="r-lic"></div>') },
      { id: 'alerts', label: 'Fraud alerts', icon: '🚨', group: 'Monitoring', sub: 'Counterfeits, duplicates, diversion, tampering', html: () => card('Fraud &amp; anomaly alerts', '<div id="r-alerts"></div>') },
      { id: 'settlements', label: 'Settlements', icon: '💸', group: 'Monitoring', sub: 'Subsidy payments to agro-dealers', html: () => card('Recent settlements', '<div id="r-settle"></div>') },
      { id: 'inspections', label: 'Inspections', icon: '🔍', group: 'Monitoring', sub: 'Field inspection reports', html: () => card('Field inspections', '<div id="r-insp"></div>') },
      { id: 'trace', label: 'Trace a bag', icon: '🔎', group: 'Audit', sub: 'Full chain of custody for any bag', html: () => traceCard('r-trace') },
      { id: 'ledger', label: 'Blockchain ledger', icon: '⛓️', group: 'Audit', sub: 'Integrity of the tamper-proof ledger (read-only)', html: () => `<div id="x-verify"></div>${card('Blocks', '<div id="x-blocks"></div>')}` },
      { id: 'integration', label: 'FIS / Ruzuku', icon: '🔗', group: 'Audit', sub: 'Data exchanged with TFRA systems (read-only)', html: () => integrationHtml(false) },
    ],
    badges: (d) => ({ review: d.kpi.review, alerts: d.kpi.alerts }),
    render(d, sec) {
      setUserMeta('Tanzania Fertilizer Regulatory Authority');
      const v = d.ledger;
      set('r-ledger', `<div class="banner ${v && v.valid ? 'good' : 'bad'}"><div class="big">${v ? (v.valid ? '✓ Ledger integrity verified' : '✗ LEDGER TAMPERING DETECTED at block #' + v.broken_at) : 'Ledger unreachable'}</div>${v && v.valid ? `<div><span class="k">blocks</span>${v.height}</div>` : ''}<div><span class="k">FIS registry</span>${esc(d.registry_source)}</div><div><span class="k">Ruzuku outbox pending</span>${d.outbox_pending}</div><div><span class="k">quarantined records</span>${d.quarantine.length}</div></div>`);
      set('r-kpi', kpis([['Bags registered', d.kpi.bags], ['Verified by farmers', d.kpi.verified], ['Subsidy paid (TZS)', fmt(d.kpi.subsidy_paid)], ['Payouts', d.kpi.payouts], ['Counterfeit attempts', d.kpi.counterfeit, d.kpi.counterfeit ? 'bad' : ''], ['Awaiting review', d.kpi.review, d.kpi.review ? 'warn' : ''], ['Tamper-flagged bags', d.kpi.flagged, d.kpi.flagged ? 'bad' : ''], ['Alerts', d.kpi.alerts]]));
      set('r-regions', table(['Region', 'Dealers (active)', 'Bags at dealers', 'Bags sold', 'Subsidy paid', 'Pending', 'Quota use', 'Alerts'], d.regions.map((x) => `<tr><td><b>${esc(x.region)}</b></td><td>${x.dealers} (${x.active_dealers})</td><td>${x.bags_at_dealers}</td><td>${x.bags_sold}</td><td>${fmt(x.subsidy_paid)}</td><td>${x.pending}</td><td>${x.quota ? `<div class="qbar"><i style="width:${Math.min(100, x.quota_used)}%"></i></div><span class="small muted">${x.quota_used}% of ${fmt(x.quota)}</span>` : '<span class="muted">no quota</span>'}</td><td>${x.alerts ? badge(x.alerts + ' alerts') : '0'}</td></tr>`)));
      const el = $('#r-review');
      if (el) {
        const sig = d.review.map((r) => r.ref).join() || 'empty';
        if (el.dataset.sig !== sig) { // keep typed remarks while polling
          el.dataset.sig = sig;
          el.innerHTML = table(['Ref', 'Bag', 'Product', 'Bag held by', 'Verified', 'Reason', 'Decision'], d.review.map((s) => `<tr><td class="mono">${esc(s.ref)}</td><td>${esc(s.label)}</td><td>${esc(s.product)}</td><td>${esc(s.dealer_name || s.holder)}</td><td>${dt(s.created_at)}${s.cell_id ? '<br><span class="small muted">' + esc(s.cell_id) + '</span>' : ''}</td><td class="small">${esc(s.note)}</td><td><div class="actions-cell"><input placeholder="remarks" id="n-${esc(s.ref)}" /><button class="btn small" onclick="decide('${esc(s.ref)}','approve')">Approve</button><button class="btn small danger" onclick="decide('${esc(s.ref)}','reject')">Reject</button></div></td></tr>`), 'Queue empty: all payouts were automatic.');
        }
      }
      set('r-alerts', alertList(d.alerts));
      set('r-lic', table(['Licence', 'Name', 'Role', 'Region', 'MSISDN / wallet', 'Status', 'Action'], d.licences.map((p) => `<tr><td>${esc(p.lic_no)}</td><td>${esc(p.name)}</td><td>${esc(p.role)}</td><td>${esc(p.region)}</td><td class="small">${esc(p.msisdn || '—')} ${esc(p.wallet || '')}</td><td>${badge(p.status)}</td><td>${p.role === 'DEALER' ? (p.status === 'ACTIVE' ? `<button class="btn small danger" onclick="licence('${esc(p.lic_no)}','S')">Suspend</button>` : `<button class="btn small" onclick="licence('${esc(p.lic_no)}','A')">Reinstate</button>`) : ''}</td></tr>`)));
      set('r-settle', table(['Ref', 'Bag', 'Dealer', 'TZS', 'State', 'Latest step'], d.settlements.map((s) => `<tr><td class="mono">${esc(s.ref)}</td><td>${esc(s.label)}</td><td>${esc(s.dealer_name || '—')}</td><td>${s.amount ? fmt(s.amount) : '—'}</td><td>${badge(s.state)}</td><td class="small">${esc(s.note)}</td></tr>`)));
      set('r-insp', table(['Time', 'Inspector', 'Dealer', 'Result', 'Notes'], d.inspections.map((i) => `<tr><td>${dt(i.at)}</td><td>${esc(i.inspector_name)}</td><td>${esc(i.dealer_name)}</td><td>${badge(i.result === 'PASS' ? 'SUCCESS' : 'REJECTED')}</td><td class="small">${esc(i.notes)}</td></tr>`)));
      if (sec === 'ledger' && d.chain) renderLedger(d.chain);
      if (sec === 'integration' && d.state) renderIntegration(d.state, d.ext);
    },
  },

  // ---------------- FIELD INSPECTOR ----------------
  inspector: {
    load: () => api('/api/portal/inspector'),
    sections: [
      { id: 'overview', label: 'Overview', icon: '📊', sub: 'Your region at a glance', html: () => `<div id="i-kpi"></div>${card('Tasks: alerts in my region', '<div id="i-tasks"></div>')}` },
      { id: 'inspect', label: 'Log inspection', icon: '📝', group: 'Field work', sub: 'Signed shop inspection, sent to TFRA Ruzuku', html: () => `<div class="card"><h3>Log a shop inspection</h3>
          <form id="f-insp" class="form">
            <label>Agro-dealer<select name="dealer_id" id="i-dealer"></select></label>
            <label>Result<select name="result"><option value="PASS">PASS: labels intact, prices displayed</option><option value="FAIL">FAIL: violation found</option></select></label>
            <label>Bag checked (optional)<input name="bag" placeholder="MM26001-0005" /></label>
            <label>GPS<input name="gps" value="-6.8235,37.6610" /></label>
            <label style="grid-column:1/-1">Notes<input name="notes" placeholder="e.g. 2 bags with VOID labels removed from sale" /></label>
            <button class="btn">Sign &amp; submit to TFRA</button>
          </form><div id="i-result" class="result"></div></div>${card('My inspections', '<div id="i-insp"></div>')}`,
        bind() {
          $('#f-insp').onsubmit = async (e) => {
            e.preventDefault();
            try { const r = await api('/api/portal/inspection', formData(e.target)); $('#i-result').innerHTML = `<div class="ok-box">${esc(r.id)} recorded (${esc(r.result)}) and sent to TFRA Ruzuku.</div>`; e.target.reset(); refresh(); }
            catch (err) { $('#i-result').innerHTML = `<div class="err-box">${esc(err.message)}</div>`; }
          };
        } },
      { id: 'dealers', label: 'Agro-dealers', icon: '🏪', group: 'Field work', sub: 'Shops in your region with flagged or expired stock', html: () => card('Agro-dealers in my region', '<div id="i-dealers"></div>') },
      { id: 'trace', label: 'Trace a bag', icon: '🔎', group: 'Field work', sub: 'Check a bag on the shelf against the ledger', html: () => traceCard('i-trace') },
    ],
    badges: (d) => ({ overview: d.tasks.length }),
    render(d) {
      setUserMeta('Region ' + d.region);
      const s = d.stats || {};
      set('i-kpi', kpis([['Dealers in region', d.dealers.length], ['Bags at dealers', s.bags_at_dealers || 0], ['Bags sold', s.bags_sold || 0], ['Open alerts', d.tasks.length, d.tasks.length ? 'warn' : ''], ['Flagged bags in shops', d.dealers.reduce((a, x) => a + x.flagged, 0), d.dealers.some((x) => x.flagged) ? 'bad' : '']]));
      set('i-tasks', alertList(d.tasks));
      fillSelect($('#i-dealer'), d.dealers.map((x) => [x.id, `${x.name} (${x.status})`]));
      set('i-dealers', table(['Dealer', 'Licence', 'Status', 'Bags in shop', 'Flagged', 'Expired', 'Last inspection'], d.dealers.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.lic_no)}</td><td>${badge(x.status)}</td><td>${x.stock}</td><td>${x.flagged ? badge(x.flagged + ' VOID') : 0}</td><td>${x.expired ? badge(x.expired + ' expired') : 0}</td><td>${x.last_inspection ? `${esc(x.last_inspection.result)} · ${dt(x.last_inspection.at)}` : '<span class="muted">never</span>'}</td></tr>`)));
      set('i-insp', table(['Time', 'Dealer', 'Result', 'Bag', 'Notes'], d.inspections.map((i) => `<tr><td>${dt(i.at)}</td><td>${esc(i.dealer_name)}</td><td>${badge(i.result === 'PASS' ? 'SUCCESS' : 'REJECTED')}</td><td>${esc(i.bag)}</td><td class="small">${esc(i.notes)}</td></tr>`)));
    },
  },

  // ---------------- SYSTEM ADMINISTRATOR ----------------
  admin: {
    async load(sec) {
      const d = { state: await api('/api/state') };
      if (['overview', 'redundancy', 'settlements', 'integration'].includes(sec)) d.ext = await api('/api/ext');
      if (sec === 'ledger') d.chain = await api('/api/chain');
      return d;
    },
    sections: [
      { id: 'overview', label: 'Control room', icon: '🖥️', sub: 'Platform health, KPIs and alerts', html: () => `<div id="ad-kpi"></div><div class="grid2">${card('Service health', '<div id="ad-health"></div>')}${card('Fraud &amp; anomaly alerts', '<div id="ad-alerts"></div>')}</div>
          <div class="card"><h3>Demo data</h3><p class="muted small">Wipe the ledger, payments and TFRA mock, then reload the seeded supply chain.</p><div class="btnrow"><button class="btn small danger" id="btn-reset">Reset demo data</button></div></div>`,
        bind() {
          $('#btn-reset').onclick = async (e) => {
            const b = e.target;
            if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Click again to confirm reset'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reset demo data'; }, 4000); return; }
            b.disabled = true; b.textContent = 'Resetting…';
            await api('/api/admin/reset', {}); toast('Demo data reset'); b.disabled = false; delete b.dataset.armed; b.textContent = 'Reset demo data'; refresh();
          };
        } },
      { id: 'redundancy', label: 'Redundancy', icon: '🛡️', group: 'Operations', sub: 'Break components live: failover, retries and outbox in action', html: () => `<div class="grid2">${card('Switches', '<div id="ad-switch"></div>')}${card('What happens when it breaks', `<div class="small" style="line-height:1.7">
          <b>USSD aggregator down</b>: the MNO switch routes *150*00# to the secondary aggregator. If both are down, farmers are told to SMS 15000.<br>
          <b>Mobile-money rail down</b>: the payout retries at 2 s → 4 s → 8 s → 16 s with the same Idempotency-Key, so it can never pay twice. The dealer gets a "queued" SMS, and after 5 failures it goes to TFRA review.<br>
          <b>TFRA FIS / Ruzuku down</b>: the registry is served from the last good copy, and events wait in the outbox until an ACK arrives.<br>
          <b>Ledger node unreachable</b>: farmers still get answers from the cache, and settlements wait in the durable queue.</div>`)}</div>` },
      { id: 'sessions', label: 'USSD sessions', icon: '📱', group: 'Operations', sub: 'Every session with aggregator, tower and latency', html: () => card('USSD sessions', '<div id="ad-sessions"></div>') },
      { id: 'settlements', label: 'Settlements', icon: '💸', group: 'Operations', sub: 'Asynchronous, durable, idempotent payout queue', html: () => `${card('Subsidy settlement queue', '<div id="ad-settle"></div>')}<div class="grid2">${card('SMS gateway outbox', '<div id="ad-sms" class="list"></div>')}${card('Mobile-money gateway', '<div id="ad-mno"></div>')}</div>` },
      { id: 'supply', label: 'Supply chain', icon: '🏭', group: 'Operations', sub: 'All batches and custody transfers on the ledger', html: () => `${card('Batches', '<div id="ad-batches"></div>')}${card('Custody log', '<div id="ad-custody"></div>')}` },
      { id: 'ledger', label: 'Blockchain & security', icon: '⛓️', group: 'Security', sub: 'Ledger integrity, tamper detection and webhook attacks', html: () => `<div id="x-verify"></div>
          <div class="grid2"><div class="card"><h3>Tamper test</h3><p class="muted small">Simulates an insider editing a stored transaction without the validator key.</p><div class="btnrow"><button class="btn danger small" id="btn-tamper">Insider edits the database</button><button class="btn ghost small" id="btn-restore">Resync from honest peer</button></div></div>
          <div class="card"><h3>Webhook security (HMAC-SHA256)</h3><div class="btnrow"><button class="btn danger small" id="btn-forge">Send forged payout request</button><button class="btn danger small" id="btn-replay">Replay a captured request</button></div><div id="attack-result" class="result"></div></div></div>
          ${card('Blocks', '<div id="x-blocks"></div>')}`,
        bind() {
          $('#btn-tamper').onclick = async () => { const r = await api('/api/chain/tamper', {}); toast(r.error ? r.error : `Block #${r.tampered_block} edited (${r.change}) → detected`, !r.error); refresh(); };
          $('#btn-restore').onclick = async () => { await api('/api/chain/restore', {}); toast('Ledger resynced from honest peer copy'); refresh(); };
          const attack = async (kind) => {
            const r = await api('/api/security/attack', { kind });
            $('#attack-result').innerHTML = `<div class="${r.status === 401 ? 'ok-box' : 'err-box'}">Mobile-money gateway answered <b>HTTP ${r.status}</b>: ${esc(r.response && r.response.error)}<br>${r.status === 401 ? 'Attack blocked: no money moved.' : ''}</div>`;
          };
          $('#btn-forge').onclick = () => attack('forged');
          $('#btn-replay').onclick = () => attack('replay');
        } },
      { id: 'integration', label: 'TFRA integration', icon: '🔗', group: 'Integrations', sub: 'FIS pull, Ruzuku push, mapping and quarantine', html: () => integrationHtml(true), bind: bindIntegration },
      { id: 'architecture', label: 'Architecture', icon: '🧭', group: 'Integrations', sub: 'System and protocol diagrams', html: () => `<div class="arch-nav">${[['d-arch', 'System architecture'], ['d-verify', 'USSD verify + settlement'], ['d-redund', 'Telecom redundancy'], ['d-tfra', 'TFRA / Ruzuku'], ['d-tamper', 'Void label + single-use'], ['d-states', 'State machines']].map(([k, l], i) => `<button class="btn small ${i ? 'ghost' : ''}" data-d="${k}">${l}</button>`).join('')}</div><div class="card diagram-card"><div id="diagram"></div></div>`,
        bind() {
          const show = async (id) => {
            document.querySelectorAll('.arch-nav button').forEach((b) => b.classList.toggle('ghost', b.dataset.d !== id));
            const { svg } = await mermaid.render('m' + Date.now(), window.DIAGRAMS[id].replace(/\*150\*00#/g, '#42;150#42;00#35;'));
            $('#diagram').innerHTML = svg;
          };
          document.querySelectorAll('.arch-nav button').forEach((b) => (b.onclick = () => show(b.dataset.d)));
          show('d-arch');
        } },
    ],
    badges: (d) => ({ overview: d.state.alerts.length, settlements: d.state.kpi.review }),
    render(d, sec) {
      const S = d.state, k = S.kpi, EXT = d.ext;
      setUserMeta('Platform operations');
      set('ad-kpi', kpis([['Batches on chain', k.batches], ['Bags registered', k.bags], ['Bags verified', k.verified], ['Subsidy paid (TZS)', fmt(k.subsidy_paid)], ['Counterfeit attempts', k.counterfeit, k.counterfeit ? 'bad' : ''], ['Settlement queue', k.queue, k.queue ? 'warn' : ''], ['Manual review', k.review, k.review ? 'bad' : ''], ['TFRA outbox pending', k.outbox_pending, k.outbox_pending ? 'warn' : '']]));
      const h = S.health || {};
      const row = (n, up, sub) => `<div class="toggle-row"><div><div class="name">${n}</div><div class="sub">${sub}</div></div>${up ? '<span class="badge ACTIVE">UP</span>' : '<span class="badge REJECTED">DOWN</span>'}</div>`;
      set('ad-health', row('Ledger node', h.chain && h.chain.up, h.chain && h.chain.up ? `height ${h.chain.height} · mempool ${h.chain.mempool}` : 'unreachable') + row('Mobile-money gateway', h.mno && h.mno.up, '4 rails') + row('TFRA FIS / Ruzuku', h.tfra && h.tfra.up, 'registry ' + S.registry_source) + Object.values(S.aggregators).map((a) => row(a.name, a.up, a.handled + ' USSD sessions')).join(''));
      set('ad-alerts', alertList(S.alerts));
      const sw = (on, action) => `<button class="sw ${on ? 'on' : ''}" onclick="${action}"></button>`;
      set('ad-switch', `<div class="group-title">USSD aggregators (*150*00# on all MNOs)</div>${Object.entries(S.aggregators).map(([id, a], i) => `<div class="toggle-row"><div><div class="name">${esc(a.name)} ${i === 0 ? '(primary)' : '(secondary)'}</div><div class="sub">${a.handled} sessions handled</div></div>${sw(a.up, `toggleAgg('${id}', ${!a.up})`)}</div>`).join('')}
        <div class="group-title">Mobile-money rails</div>${EXT && EXT.mno ? Object.entries(EXT.mno.providers).map(([id, p]) => `<div class="toggle-row"><div><div class="name">${esc(p.name)}</div><div class="sub">payout rail · ~${p.latency_ms} ms</div></div>${sw(p.up, `toggleMno('${id}', ${!p.up})`)}</div>`).join('') : ''}
        <div class="group-title">Government systems</div>${EXT && EXT.tfra ? `<div class="toggle-row"><div><div class="name">TFRA FIS / Ruzuku</div><div class="sub">registry: ${esc(S.registry_source)}</div></div>${sw(EXT.tfra.up, `toggleTfra(${!EXT.tfra.up})`)}</div>` : ''}`);
      set('ad-sessions', table(['Time', 'Aggregator', 'Network', 'Phone', 'Tower', 'Input', 'Outcome', 'ms'], S.sessions.map((s) => `<tr><td>${tm(s.at)}</td><td>${esc(s.aggregator)}</td><td>${esc(s.network)}</td><td>${esc(s.phone)}</td><td>${esc(s.cell_id)}</td><td class="mono">${esc(s.input)}</td><td>${badge(s.outcome)}</td><td>${s.ms}</td></tr>`)));
      set('ad-settle', table(['Ref', 'Bag', 'State', 'Dealer (from custody)', 'TZS', 'Rail', 'Tries', 'Block', 'Latest step', ''], S.settlements.map((j) => `<tr><td class="mono">${esc(j.ref)}</td><td>${esc(j.label)}</td><td>${badge(j.state)}</td><td>${esc(j.dealer_name || '—')}</td><td>${j.amount ? fmt(j.amount) : '—'}</td><td>${esc(j.provider || '—')}</td><td>${j.attempts}</td><td>${j.block ?? '…'}</td><td class="small">${esc(j.history[j.history.length - 1].note)}</td><td>${j.state === 'MANUAL_REVIEW' ? `<button class="btn small" onclick="retrySettlement('${j.ref}')">Retry</button>` : ''}</td></tr>`)));
      set('ad-sms', S.sms.map((m) => `<div class="sms ${m.kind}"><div class="meta">${tm(m.at)} · to ${esc(m.to)} · ${m.kind}</div>${esc(m.text)}</div>`).join('') || '<div class="muted small">No SMS yet</div>');
      if (EXT && EXT.mno) set('ad-mno', table(['Payout key', 'Rail', 'MSISDN', 'TZS', 'Status', 'Provider ref'], EXT.mno.payouts.map((p) => `<tr><td class="mono">${esc(p.idempotency_key)}</td><td>${esc(p.provider)}</td><td>${esc(p.msisdn)}</td><td>${fmt(p.amount)}</td><td>${badge(p.status)}</td><td class="mono">${esc(p.provider_ref || '')}</td></tr>`)) + `<h4>Rejected requests (bad signature / replay)</h4>${EXT.mno.rejected.map((r) => `<div class="alert"><b>${tm(r.at)}</b>${esc(r.reason)}</div>`).join('') || '<div class="muted small">None</div>'}`);
      set('ad-batches', S.batches.map((b) => `<div class="batch"><div class="row-between"><div><b>${esc(b.batch_id)}</b> · ${esc(b.product_name)} · ${esc(b.manufacturer_name)} · ${b.quantity} bags ${b.expired ? badge('EXPIRED') : ''}</div><div class="small muted">block #${b.block ?? '…'} · hash <span class="mono">${esc(b.batch_hash.slice(0, 16))}…</span></div></div>
        <div class="legend" style="margin-top:6px">${Object.entries(b.holders).map(([k2, s]) => `<span>${esc(k2)}: <b>${s.length}</b></span>`).join('')}</div></div>`).join(''));
      set('ad-custody', table(['Time', 'Batch', 'From', 'To', 'Bags', 'GPS', 'Ledger tx', 'Block'], S.custody.map((c) => `<tr><td>${tm(c.at)}</td><td>${esc(c.batch_id)}</td><td>${esc(c.from_name)}</td><td>${esc(c.to_name)}</td><td>#${c.serial_from}–${c.serial_to} (${c.qty})</td><td class="mono">${esc(c.gps)}</td><td class="mono">${esc(c.tx_id.slice(0, 14))}…</td><td>${c.block ?? '…'}</td></tr>`)));
      if (sec === 'ledger' && d.chain) renderLedger(d.chain);
      if (sec === 'integration') renderIntegration(S, EXT);
    },
  },
};

window.decide = async (ref, decision) => {
  try { await api('/api/portal/review/' + ref, { decision, notes: (document.getElementById('n-' + ref) || {}).value || '' }); toast(`Settlement ${ref} ${decision === 'approve' ? 'approved: payout re-queued' : 'rejected: no subsidy paid'}`); refresh(); }
  catch (err) { toast(err.message, true); }
};
window.licence = async (lic_no, status) => {
  try { await api('/api/portal/licence', { lic_no, status }); toast(`Licence ${lic_no} → ${status === 'S' ? 'SUSPENDED' : 'ACTIVE'} (updated in FIS)`); refresh(); }
  catch (err) { toast(err.message, true); }
};
window.toggleAgg = async (id, up) => { await api('/api/aggregators/' + id, { up }); refresh(); };
window.toggleMno = async (p, up) => { await api('/api/ext/mno/' + p, { up }); refresh(); };
window.toggleTfra = async (up) => { await api('/api/ext/tfra/up', { up }); refresh(); };
window.retrySettlement = async (ref) => { await api(`/api/settlements/${ref}/retry`, {}); refresh(); };

// ================= SHELL / NAVIGATION =================
let timer = null;
let section = 'overview';
function setUserMeta(meta) { if ($('#u-meta').textContent !== meta) $('#u-meta').textContent = meta; }
function buildNav() {
  const v = VIEWS[user.role];
  let html = '', grp = null;
  for (const s of v.sections) {
    if ((s.group || null) !== grp) { grp = s.group || null; if (grp) html += `<div class="grp">${grp}</div>`; }
    html += `<a href="#${s.id}" data-sec="${s.id}"><span class="ic">${s.icon}</span>${s.label}<span class="cnt" hidden></span></a>`;
  }
  $('#nav').innerHTML = html;
}
function go(id) {
  const v = VIEWS[user.role];
  const s = v.sections.find((x) => x.id === id) || v.sections[0];
  section = s.id;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.sec === s.id));
  $('#sec-title').textContent = s.label;
  $('#sec-sub').textContent = s.sub || '';
  $('#view').innerHTML = s.html();
  if (s.bind) s.bind();
  $('#app').classList.remove('open');
  window.scrollTo(0, 0);
  refresh();
}
window.addEventListener('hashchange', () => { if (user) go(location.hash.slice(1)); });
$('#burger').onclick = () => $('#app').classList.toggle('open');
$('#backdrop').onclick = () => $('#app').classList.remove('open');

let reqSeq = 0;
async function refresh() {
  if (!user) return;
  const my = ++reqSeq;
  const sec = section;
  try {
    const v = VIEWS[user.role];
    const d = await v.load(sec);
    if (my !== reqSeq || sec !== section) return; // a newer refresh / navigation superseded this one
    v.render(d, sec);
    const counts = v.badges ? v.badges(d) : {};
    document.querySelectorAll('#nav a').forEach((a) => { const c = $('.cnt', a); const n = counts[a.dataset.sec] || 0; c.hidden = !n; c.textContent = n; });
    $('#live').textContent = 'Live · ' + new Date().toLocaleTimeString();
  } catch (e) { console.warn(e); }
}
async function start() {
  try { user = (await api('/api/auth/me')).user; } catch (e) { return showLogin(); }
  $('#login').hidden = true; $('#app').hidden = false;
  $('#u-name').textContent = user.name;
  $('#u-role').textContent = ROLE_NAMES[user.role];
  buildNav();
  go(location.hash.slice(1));
  clearInterval(timer); timer = setInterval(refresh, 2500);
}

if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', flowchart: { curve: 'basis' } });
// Demo shortcut: /portal.html#login=neema signs in with the published demo password (for presenting).
(async () => {
  const m = location.hash.match(/^#login=([\w.]+)/);
  if (m) {
    const d = await api('/api/auth/demo-accounts');
    try { token = (await api('/api/auth/login', { username: m[1], password: d.password })).token; sessionStorage.setItem('bf_token', token); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }
  token ? start() : showLogin();
})();
