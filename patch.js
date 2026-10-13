
const fs = require('fs');
const p = 'core/bf-services/index.js';
let s = fs.readFileSync(p, 'utf8');

if (s.includes("apiApp.get('/api/batch/:token'")) {
  console.log('Already patched. Nothing to do.');
  process.exit(0);
}

const insert = `apiApp.get('/api/batch/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'DB not ready' });
  try {
    const token = req.params.token.toUpperCase();
    const result = await pool.query(
      \`SELECT t.token_code, t.status, b.batch_id, b.product_name, b.manufacturer,
              b.chemical_composition, b.manufacture_date, b.expiry_date
       FROM tokens t JOIN batches b ON t.batch_id = b.batch_id
       WHERE t.token_code = $1\`,
      [token]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found in registry.' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

`;

const anchor = "apiApp.get('/health'";
if (!s.includes(anchor)) {
  console.error("Anchor not found in index.js");
  process.exit(1);
}

s = s.replace(anchor, insert + anchor);
fs.writeFileSync(p, s);
console.log('Patched index.js successfully.');