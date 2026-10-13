// Generates docs/blockfarming-v2.drawio  (run: node docs/gen-drawio.js)
const path = require('path');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;');
const cells = [];
const box = (id, x, y, w, h, label, fill = '#dae8fc', stroke = '#6c8ebf') =>
  cells.push(`<mxCell id="${id}" value="${esc(label)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontSize=11;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
const group = (id, x, y, w, h, label, fill, stroke) =>
  cells.push(`<mxCell id="${id}" value="${esc(label)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};verticalAlign=top;fontStyle=1;fontSize=12;dashed=1;arcSize=4;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
const cyl = (id, x, y, w, h, label, fill, stroke) =>
  cells.push(`<mxCell id="${id}" value="${esc(label)}" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=10;fillColor=${fill};strokeColor=${stroke};fontSize=11;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
let e = 0;
const edge = (s, t, label = '', dashed = false, color = '#333333') =>
  cells.push(`<mxCell id="e${++e}" value="${esc(label)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=classic;strokeWidth=1.5;fontSize=10;strokeColor=${color};labelBackgroundColor=#ffffff;${dashed ? 'dashed=1;' : ''}" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`);

cells.push(`<mxCell id="title" value="BLOCKFARMING v2 — SYSTEM ARCHITECTURE (tamper-evidence · telecom redundancy · TFRA integration)" style="text;html=1;fontStyle=1;fontSize=16;align=center;" vertex="1" parent="1"><mxGeometry x="200" y="10" width="1200" height="30" as="geometry"/></mxCell>`);

// Source + distribution (left)
group('gsrc', 30, 60, 260, 230, 'SOURCE (Factory)', '#fff2cc', '#d6b656');
box('fac', 50, 95, 220, 70, 'FACTORY PRODUCTION\nMinjingu · YARA\n12-digit codes → HMAC-SHA256', '#ffe6cc', '#d79b00');
box('prn', 50, 195, 220, 75, 'SECURE LABEL PRINTER\nscratch panel inside\nVOID tamper-evident label', '#ffe6cc', '#d79b00');
group('gdist', 30, 320, 260, 300, 'DISTRIBUTION', '#f5f5f5', '#666666');
box('dst', 50, 355, 220, 50, 'REGIONAL DISTRIBUTORS', '#f5f5f5', '#666666');
box('dlr', 50, 430, 220, 50, 'LICENSED AGRO-DEALERS', '#f5f5f5', '#666666');
box('app', 50, 515, 220, 80, 'WEB / FLUTTER APP\nscan serial range + GPS\nsigned custody transfer', '#e1d5e7', '#9673a6');

// Ledger (top centre)
group('gled', 340, 60, 640, 150, 'PERMISSIONED LEDGER (PoA · Hyperledger Fabric / Solana target)', '#e1d5e7', '#9673a6');
box('sc', 360, 100, 280, 90, 'SMART CONTRACT: TokenRegistry\nREGISTER_BATCH · CUSTODY_TRANSFER\nREDEEM (single-use) · TAMPER_REPORT', '#ffffff', '#9673a6');
cyl('blk', 690, 95, 270, 100, 'HASH-CHAINED BLOCKS\nprev_hash + Merkle root\nvalidator signature · /verify', '#ffffff', '#9673a6');

// Platform (centre)
group('gbf', 340, 250, 640, 370, 'BLOCKFARMING PLATFORM (Node.js core)', '#dae8fc', '#6c8ebf');
box('gw', 360, 290, 280, 80, 'USSD / SMS GATEWAY — FAST PATH < 1 s\nLuhn check · rate limit · hash lookup\nreserve token (PENDING) · reply', '#ffffff', '#6c8ebf');
cyl('cache', 690, 285, 270, 90, 'CACHE (PostgreSQL / Redis)\ntoken status · sessions · registry copy', '#ffffff', '#6c8ebf');
box('q', 360, 400, 280, 90, 'DURABLE SETTLEMENT QUEUE (async)\nREDEEM → block → payee from custody\nretry 2/4/8/16 s · Idempotency-Key', '#ffffff', '#6c8ebf');
box('fraud', 690, 400, 270, 90, 'FRAUD & ANOMALY ENGINE\ncounterfeit · duplicate · diversion\ncell-ID vs dealer region · expiry', '#f8cecc', '#b85450');
box('acl', 360, 515, 280, 85, 'TFRA INTEGRATION ADAPTER\nPULL registry (signed) · normalise\nquarantine bad records', '#ffffff', '#6c8ebf');
box('ob', 690, 515, 270, 85, 'EVENT OUTBOX\nmap → Ruzuku legacy format\nHMAC webhook · ACK · retry', '#ffffff', '#6c8ebf');

// Telecom (right)
group('gtel', 1030, 250, 270, 370, 'TELECOM LAYER (redundant)', '#d5e8d4', '#82b366');
box('sw', 1050, 290, 230, 60, 'MNO USSD SWITCH\nVodacom · Airtel · Yas · Halotel\n*150*00# on all networks', '#ffffff', '#82b366');
box('ag1', 1050, 375, 230, 45, "AGGREGATOR 1 (primary)\nAfrica's Talking", '#ffffff', '#82b366');
box('ag2', 1050, 440, 230, 45, 'AGGREGATOR 2 (failover)\nBeem Africa', '#ffffff', '#82b366');
box('sms', 1050, 510, 230, 85, 'SMS GATEWAY\nshortcode 15000 (fallback input)\nreceipts · dropped-session results', '#ffffff', '#82b366');

// Farmer (far right)
box('bag', 1350, 95, 220, 95, 'BAG\nvisible serial MM26001-0007\nscratch code under VOID label\n(peel ⇒ "VOID" stays on bag)', '#fff2cc', '#d6b656');
box('ph', 1350, 330, 220, 110, 'FARMER — FEATURE PHONE\n1 Verify · 2 Prices\n3 Report VOID label · 4 Payment ref\n(no internet needed)', '#d5e8d4', '#82b366');

// Bottom: money + government
group('gmm', 340, 660, 400, 130, 'MOBILE MONEY', '#ffe6cc', '#d79b00');
box('mm', 360, 700, 360, 70, 'M-Pesa · Mixx by Yas · Airtel Money · HaloPesa\nHMAC-signed payout · signed async callback', '#ffffff', '#d79b00');
group('ggov', 780, 660, 520, 130, 'GOVERNMENT (TFRA / Ministry of Agriculture)', '#f8cecc', '#b85450');
box('fis', 800, 700, 230, 70, 'TFRA FIS\nprice ceilings · licences · quotas', '#ffffff', '#b85450');
box('rzk', 1050, 700, 230, 70, 'RUZUKU PORTAL\nsubsidy audit · alerts · reports', '#ffffff', '#b85450');

// Edges
edge('fac', 'sc', 'batch + token hashes only');
edge('fac', 'prn', 'plain codes (print once)', true);
edge('dst', 'app', ''); edge('dlr', 'app', '');
edge('app', 'q', 'custody tx');
edge('prn', 'bag', 'label applied', true, '#d79b00');
edge('bag', 'ph', 'scratch at the shop', true, '#d79b00');
edge('ph', 'sw', 'USSD *150*00#', false, '#2d7600');
edge('sw', 'ag1', ''); edge('sw', 'ag2', 'if primary down', true, '#2d7600');
edge('ph', 'sms', 'SMS if USSD congested', true, '#2d7600');
edge('ag1', 'gw', ''); edge('ag2', 'gw', ''); edge('sms', 'gw', '');
edge('gw', 'cache', 'lookup / reserve');
edge('gw', 'q', 'enqueue');
edge('gw', 'fraud', '');
edge('q', 'sc', 'REDEEM tx');
edge('sc', 'blk', 'seal');
edge('q', 'mm', 'payout (signed)');
edge('mm', 'q', 'callback (signed)', true);
edge('mm', 'dlr', 'subsidy to custodian dealer', false, '#d79b00');
edge('sms', 'ph', 'verification + price + receipt', true, '#2d7600');
edge('fis', 'acl', 'PULL signed REST', false, '#b85450');
edge('ob', 'rzk', 'PUSH HMAC webhook', false, '#b85450');
edge('blk', 'ob', 'ledger events', true, '#9673a6');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="Electron"><diagram name="BlockFarming v2 Architecture" id="bf-v2"><mxGraphModel dx="1600" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="820" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
${cells.join('\n')}
</root></mxGraphModel></diagram></mxfile>`;
require('fs').writeFileSync(path.join(__dirname, 'blockfarming-v2.drawio'), xml);
console.log('wrote docs/blockfarming-v2.drawio (' + cells.length + ' cells)');
