/* BlockFarming Live Demo: feature-phone simulator, scratch-label bags, live settlement pipeline. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const t = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg; el.className = err ? 'err' : ''; el.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), 4000);
}
let S = null;

// ---------------- phone simulator ----------------
const KEYS = [['1', ''], ['2', 'abc'], ['3', 'def'], ['4', 'ghi'], ['5', 'jkl'], ['6', 'mno'], ['7', 'pqrs'], ['8', 'tuv'], ['9', 'wxyz'], ['*', ''], ['0', '+'], ['#', '']];
$('#keypad').innerHTML = KEYS.map(([k, s]) => `<button data-k="${k}">${k}<small>${s || '&nbsp;'}</small></button>`).join('');
const phone = { session: null, path: [], buffer: '', mode: 'idle' };
const screenText = (s) => ($('#screen-text').textContent = s);
const screenInput = () => ($('#screen-input').textContent = phone.buffer ? (phone.mode === 'session' ? '> ' : '') + phone.buffer : '');
function idleScreen() {
  phone.mode = 'idle'; phone.session = null; phone.path = []; phone.buffer = '';
  screenText(`${$('#ph-network').value}\n${new Date().toLocaleTimeString().slice(0, 5)}\n\nDial *150*00# to verify\nfertilizer (Hakiki mbolea)`);
  screenInput();
}
function press(k) { phone.buffer += k; screenInput(); }
$('#keypad').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) press(b.dataset.k); });
$('#k-clear').onclick = () => { phone.buffer = phone.buffer.slice(0, -1); screenInput(); };
$('#k-end').onclick = idleScreen;
$('#k-call').onclick = () => {
  if (phone.mode === 'session') return sendUssd(phone.buffer);
  if (phone.buffer === '*150*00#') { phone.buffer = ''; return startUssd(); }
  if (phone.buffer) { screenText('Invalid MMI code'); phone.buffer = ''; screenInput(); }
};
$('#btn-dial').onclick = () => startUssd();
$('#ph-network').onchange = () => { $('#ph-net').textContent = $('#ph-network').value; if (phone.mode === 'idle') idleScreen(); };
$('#ph-number').onchange = () => { idleScreen(); renderInbox(); };
document.addEventListener('keydown', (e) => {
  if ($('#view-demo').hidden || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (/^[0-9*#]$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') $('#k-clear').click();
  else if (e.key === 'Enter') $('#k-call').click();
  else if (e.key === 'Escape') idleScreen();
});

async function telco(text) {
  return api('/telco/ussd', {
    sessionId: phone.session, phone: $('#ph-number').value, network: $('#ph-network').value,
    cell_id: $('#ph-cell').value, text, drop: $('#ph-drop').checked,
  });
}
async function startUssd() {
  phone.mode = 'session'; phone.session = 'ATUid_' + Math.random().toString(36).slice(2, 10); phone.path = []; phone.buffer = '';
  screenText('USSD code running…'); screenInput();
  await handleUssd(await telco(''));
}
async function sendUssd(input) {
  if (!input) return;
  phone.path.push(input); phone.buffer = '';
  screenText('Sending…'); screenInput();
  await handleUssd(await telco(phone.path.join('*')));
}
async function handleUssd(r) {
  if (r.network_error) { screenText(r.network_error); phone.mode = 'idle'; return; }
  if (r.dropped) {
    screenText('Connection problem or invalid MMI code.\n\n(Network dropped the session:\nwatch the SMS inbox)');
    phone.mode = 'idle';
    toast(`USSD dropped after ${r.ms} ms on ${r.aggregator}. Result sent by SMS fallback.`);
    setTimeout(refresh, 300);
    return;
  }
  if (r.failed_over) toast(`Primary aggregator down → session routed via ${r.aggregator}`);
  screenText(r.response.slice(4) + `\n\n[${r.aggregator} · ${r.ms} ms]`);
  if (r.response.startsWith('END')) phone.mode = 'ended';
  setTimeout(refresh, 300);
}
$('#btn-sms').onclick = async () => {
  const code = phone.buffer;
  if (!code) return toast('Type the code on the keypad first, then press "Send as SMS"', true);
  await api('/telco/sms', { phone: $('#ph-number').value, text: code, cell_id: $('#ph-cell').value });
  phone.buffer = ''; screenInput();
  screenText('Message sent to 15000.\nReply will arrive by SMS.');
  setTimeout(refresh, 300);
};
// Dials *150*00#, picks "1. Verify", types the code; presenter presses OK to send.
async function useCode(code) {
  idleScreen();
  await startUssd();
  await sendUssd('1');
  phone.buffer = code; screenInput();
  toast('Code typed on the phone: press the green OK key to send');
  if (window.innerWidth < 900) $('.phone').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
window.useCode = useCode;

// counterfeit code generator (valid Luhn so it passes the typo check but is NOT on the ledger)
function luhnDigit(s) { let sum = 0; for (let i = 0; i < s.length; i++) { let d = +s[s.length - 1 - i]; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; } return String((10 - (sum % 10)) % 10); }
$('#btn-fake').onclick = () => {
  let s = ''; for (let i = 0; i < 11; i++) s += Math.floor(Math.random() * 10);
  const code = s + luhnDigit(s);
  $('#fake-code').innerHTML = `${code.replace(/(\d{4})(?=\d)/g, '$1 ')} <button class="btn small" onclick="useCode('${code}')">Use on phone</button>`;
};

// ---------------- bags ----------------
let peeled = new Set();
try { peeled = new Set(JSON.parse(localStorage.getItem('bf_peeled') || '[]')); } catch (e) {}
const scratched = new Set();
let bagsData = [];
async function loadBags() {
  bagsData = await api('/api/print-runs');
  const holders = [...new Set(bagsData.map((b) => b.holder))];
  const sel = $('#bag-filter'); const cur = sel.value;
  const html = '<option value="">All holders</option>' + holders.map((h) => `<option ${h === cur ? 'selected' : ''}>${esc(h)}</option>`).join('');
  if (sel.dataset.sig !== html) { sel.dataset.sig = html; sel.innerHTML = html; }
  renderBags();
}
$('#bag-filter').onchange = renderBags;
function renderBags() {
  const f = $('#bag-filter').value;
  const html = bagsData.filter((b) => !f || b.holder === f).map((b) => {
    const isPeeled = peeled.has(b.label), isScr = scratched.has(b.label) || isPeeled;
    return `<div class="bag">
      <span class="stamp ${b.status}">${b.status}</span>
      ${b.flagged ? '<span class="stamp flag">REPORTED</span>' : b.expired ? '<span class="stamp exp">EXPIRED</span>' : ''}
      <div class="prod">${esc(b.product)}</div>
      <div class="serial">Bag ${esc(b.label)}</div>
      <div class="holder">📍 ${esc(b.holder)}</div>
      <div class="label ${isPeeled ? 'void' : ''}"><div class="tfra">TFRA · BLOCKFARMING · *150*00#</div>
        <div class="scratch ${isScr ? 'revealed' : ''}">${b.code.replace(/(\d{4})(?=\d)/g, '$1 ')}</div></div>
      <div class="acts">
        ${isScr ? `<button class="use" onclick="useCode('${b.code}')">Verify on phone</button>` : `<button onclick="scratch('${b.label}')">Scratch</button>`}
        ${isPeeled ? '' : `<button class="peel" onclick="peel('${b.label}')">Peel (fraud)</button>`}
        <button onclick="reportBag('${b.label}')">Report VOID</button>
      </div></div>`;
  }).join('');
  const el = $('#bags');
  if (el.dataset.sig !== html) { el.dataset.sig = html; el.innerHTML = html; }
}
window.scratch = (l) => { scratched.add(l); renderBags(); };
window.peel = (l) => {
  peeled.add(l);
  try { localStorage.setItem('bf_peeled', JSON.stringify([...peeled])); } catch (e) {}
  renderBags();
  toast('Label peeled: the code is exposed, but the label now shows VOID permanently. A farmer sees it before buying.');
};
window.reportBag = async (label) => {
  idleScreen(); await startUssd();
  await sendUssd('3');
  phone.buffer = label; screenInput();
  toast('Press the green OK key to send the VOID-label report');
};

function renderInbox() {
  if (!S) return;
  const num = $('#ph-number').value;
  $('#inbox-who').textContent = '(' + num + ')';
  const msgs = S.sms.filter((m) => m.to === num);
  $('#inbox').innerHTML = msgs.length ? msgs.map((m) => `<div class="sms ${m.kind}"><div class="meta">${t(m.at)} · ${m.kind}</div>${esc(m.text)}</div>`).join('') : '<div class="muted small">No messages</div>';
}

// ---------------- pipeline ----------------
const PIPE = [
  ['QUEUED', 'Code reserved in cache, farmer answered', 'Fast path < 1 s; USSD session can close'],
  ['CHAIN_PENDING', 'Smart contract REDEEM submitted', 'Single-use rule enforced on the ledger'],
  ['CONFIRMED', 'Sealed in a block (REDEEMED = TRUE)', 'Immutable, signed by validator'],
  ['PAYOUT_READY', 'Payee resolved from custody ledger', 'Dealer who actually held the bag'],
  ['PAYOUT_SENT', 'HMAC-signed payout to mobile money', 'Idempotency-Key = settlement ref'],
  ['PAID', 'Signed callback verified, SMS to dealer', 'Event pushed to TFRA Ruzuku'],
];
function renderPipeline() {
  const j = S.settlements[0];
  if (!j) { $('#pipeline').innerHTML = '<div class="pipe-head muted">Verify a bag on the phone to watch the settlement flow step by step.</div>'; return; }
  const order = PIPE.map((p) => p[0]);
  let idx = order.indexOf(j.state);
  const bad = ['MANUAL_REVIEW', 'BLOCKED_DOUBLE_SPEND', 'REJECTED'].includes(j.state);
  if (j.state === 'RETRYING') idx = 3;
  if (bad) idx = Math.max(...j.history.map((h) => order.indexOf(h.state)));
  const last = j.history[j.history.length - 1];
  $('#pipeline').innerHTML = `<div class="pipe-head"><b>${esc(j.ref)}</b> · bag ${esc(j.label)} · ${esc(j.channel)} ${badge(j.state)}<br>
    ${j.dealer_name ? `Dealer: <b>${esc(j.dealer_name)}</b> · TZS ${fmt(j.amount)} via ${esc(j.provider)}` : ''}
    <div class="muted small" style="margin-top:4px">${esc(last.note)}</div></div>
    <div class="steps">${PIPE.map(([k, a, b], i) => {
      let cls = i < idx || j.state === 'PAID' ? 'done' : i === idx ? (bad ? 'bad' : 'cur') : '';
      if (j.state === 'RETRYING' && i === 4) cls = 'cur';
      return `<div class="step ${cls}"><div class="dot">${cls === 'done' ? '✓' : cls === 'bad' ? '!' : i + 1}</div><div>${a}<small>${b}</small></div></div>`;
    }).join('')}
    ${bad ? `<div class="step bad"><div class="dot">!</div><div>${esc(j.state)}<small>${esc(last.note)}</small></div></div>` : ''}</div>`;
}

// ---------------- refresh ----------------
function renderHealth() {
  const h = S.health || {};
  const pill = (n, up) => `<span class="pill ${up ? 'up' : 'down'}">${n}</span>`;
  $('#health').innerHTML = pill('Ledger ' + (h.chain && h.chain.height ? '#' + (h.chain.height - 1) : ''), h.chain && h.chain.up) + pill('Mobile money', h.mno && h.mno.up) + pill('TFRA FIS', h.tfra && h.tfra.up) +
    Object.values(S.aggregators).map((a) => pill(a.name.split(' ')[0], a.up)).join('');
}
let lastBags = 0;
async function refresh(force) {
  try {
    S = await api('/api/demo/state');
    renderHealth(); renderInbox(); renderPipeline();
    $('#feed').innerHTML = S.feed.map((f) => `<div class="${f.kind}"><b>${f.kind}</b>${esc(f.msg)} <span class="muted small">${t(f.at)}</span></div>`).join('');
    if (force || Date.now() - lastBags > 3000) { lastBags = Date.now(); loadBags(); }
  } catch (e) { console.warn(e); }
}
// ---------------- view tabs: Live Demo | Architecture ----------------
let currentDiagram = null;
async function showDiagram(id) {
  document.querySelectorAll('.arch-nav button').forEach((b) => b.classList.toggle('ghost', b.dataset.d !== id));
  const src = window.DIAGRAMS[id].replace(/\*150\*00#/g, '#42;150#42;00#35;'); // stop markdown italics
  const { svg } = await mermaid.render('m' + Date.now(), src);
  $('#diagram').innerHTML = svg;
  currentDiagram = id;
}
document.querySelectorAll('.arch-nav button').forEach((b) => (b.onclick = () => showDiagram(b.dataset.d)));
function showView(v) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === v));
  $('#view-demo').hidden = v !== 'demo';
  $('#view-arch').hidden = v !== 'arch';
  if (v === 'arch' && !currentDiagram) showDiagram('d-arch');
  history.replaceState(null, '', v === 'arch' ? '#arch' : location.pathname);
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.tab)));
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict', flowchart: { curve: 'basis' } });
if (location.hash === '#arch') showView('arch');

idleScreen();
refresh(true);
setInterval(refresh, 1500);
