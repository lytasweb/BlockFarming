const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = 4000;

app.post('/settle', async (req, res) => {
  const { token_code, dealer_phone, amount, provider } = req.body;

  console.log('Settlement Request:');
  console.log('   Token: ' + token_code);
  console.log('   Dealer: ' + dealer_phone);
  console.log('   Amount: TZS ' + amount);
  console.log('   Provider: ' + provider);

  try {
    let result;
    switch (provider) {
      case 'airtel':
        result = await settleAirtel(dealer_phone, amount);
        break;
      case 'tigo':
        result = await settleTigo(dealer_phone, amount);
        break;
      case 'halopesa':
        result = await settleHalopesa(dealer_phone, amount);
        break;
      default:
        result = await settleMpesa(dealer_phone, amount);
    }

    res.json({
      success: true,
      message: 'Payment of TZS ' + amount + ' sent to ' + dealer_phone + ' via ' + provider,
      transaction_ref: 'TXN-' + Date.now(),
      provider: provider
    });
  } catch (error) {
    console.error('Settlement error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

async function settleMpesa(phone, amount) {
  console.log('[M-Pesa] Sending TZS ' + amount + ' to ' + phone);
  await new Promise(r => setTimeout(r, 500));
  console.log('[M-Pesa] Payment successful.');
  return { provider: 'M-Pesa', status: 'SUCCESS' };
}

async function settleAirtel(phone, amount) {
  console.log('[Airtel Money] Sending TZS ' + amount + ' to ' + phone);
  await new Promise(r => setTimeout(r, 500));
  console.log('[Airtel] Payment successful.');
  return { provider: 'Airtel Money', status: 'SUCCESS' };
}

async function settleTigo(phone, amount) {
  console.log('[Tigo Pesa] Sending TZS ' + amount + ' to ' + phone);
  await new Promise(r => setTimeout(r, 500));
  console.log('[Tigo] Payment successful.');
  return { provider: 'Tigo Pesa', status: 'SUCCESS' };
}

async function settleHalopesa(phone, amount) {
  console.log('[Halopesa] Sending TZS ' + amount + ' to ' + phone);
  await new Promise(r => setTimeout(r, 500));
  console.log('[Halopesa] Payment successful.');
  return { provider: 'Halopesa', status: 'SUCCESS' };
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'bf-mno-adapter', providers: ['mpesa', 'airtel', 'tigo', 'halopesa'] });
});

app.listen(PORT, () => {
  console.log('MNO Adapter running on port ' + PORT);
  console.log('Providers: M-Pesa, Airtel, Tigo, Halopesa');
});
