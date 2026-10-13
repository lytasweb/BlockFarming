// Starts all BlockFarming services (no Docker, no npm install needed — Node 18+ only).
//   node start.js          start everything
//   node start.js --reset  wipe ./data first (fresh ledger + seed)
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.argv.includes('--reset')) {
  fs.rmSync(path.join(__dirname, 'data'), { recursive: true, force: true });
  console.log('data/ wiped — starting fresh');
}

const services = [
  ['chain', 'chain/node.js'],
  ['mno', 'mno/gateway.js'],
  ['tfra', 'tfra/fis.js'],
  ['platform', 'platform/server.js'],
];
const children = {};
let stopping = false;

function start(name, file) {
  const c = fork(path.join(__dirname, file), [], { stdio: 'inherit' });
  children[name] = c;
  c.on('exit', (code) => {
    if (stopping) return;
    console.log(`[launcher] ${name} exited (${code}) — restarting in 1s`);
    setTimeout(() => start(name, file), 1000);
  });
}

services.forEach(([n, f], i) => setTimeout(() => start(n, f), i * 300));

setTimeout(() => {
  console.log('\n  BlockFarming is starting…');
  console.log('  Dashboard        http://localhost:7070');
  console.log('  Ledger node      http://localhost:7071/verify');
  console.log('  MNO gateway      http://localhost:7072/health');
  console.log('  TFRA FIS mock    http://localhost:7073/health\n');
}, 1500);

function stop() {
  stopping = true;
  Object.values(children).forEach((c) => c.kill());
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
