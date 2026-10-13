const express = require('express');
const app = express();
app.use(express.json());

const PORT = 8899;

const ledger = {
  batches: {},
  tokens: {}
};

app.post('/batch/register', (req, res) => {
  const { batch_id, hash } = req.body;
  ledger.batches[batch_id] = { hash, registered_at: new Date().toISOString() };
  console.log('Batch registered: ' + batch_id);
  res.json({ success: true, batch_id });
});

app.post('/token/register', (req, res) => {
  const { token_code, batch_id } = req.body;
  ledger.tokens[token_code] = { batch_id, status: 'UNREDEEMED', created_at: new Date().toISOString() };
  console.log('Token registered: ' + token_code);
  res.json({ success: true, token_code });
});

app.get('/token/:code', (req, res) => {
  const token = ledger.tokens[req.params.code];
  if (!token) return res.status(404).json({ error: 'Token not found' });
  res.json(token);
});

app.post('/token/redeem', (req, res) => {
  const { token_code } = req.body;
  if (!ledger.tokens[token_code]) {
    return res.status(404).json({ error: 'Token not found' });
  }
  ledger.tokens[token_code].status = 'REDEEMED';
  ledger.tokens[token_code].redeemed_at = new Date().toISOString();
  console.log('Token redeemed: ' + token_code);
  res.json({ success: true, token_code, status: 'REDEEMED' });
});

app.get('/ledger', (req, res) => {
  res.json(ledger);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'bf_blockchain',
    batches: Object.keys(ledger.batches).length,
    tokens: Object.keys(ledger.tokens).length
  });
});

app.listen(PORT, () => {
  console.log('Blockchain Node running on port ' + PORT);
});
