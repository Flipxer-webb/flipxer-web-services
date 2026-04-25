// Test debug-wallet endpoint
const https = require('node:https');

const ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;
const USER_ID = 6;
const CURRENCY = 'usdt';

if (!ACCESS_TOKEN) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

console.log(`Fetching wallet debug info for user ${USER_ID}, currency ${CURRENCY}...`);

const options = {
  hostname: 'flipxer-api.onrender.com',
  path: `/api/v1/admin/transactions/debug-wallet/${USER_ID}/${CURRENCY}`,
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const parsed = JSON.parse(data);
      const summary = parsed && typeof parsed === 'object'
        ? `top-level keys: ${Object.keys(parsed).length}`
        : `type: ${typeof parsed}`;
      console.log(`Wallet debug payload parsed successfully (${summary}).`);
    } catch {
      console.log('Wallet debug response was not valid JSON.');
    }
  });
});

req.on('error', (err) => console.error('Wallet debug request failed:', String(err.message).replace(/[\r\n]/g, ' ')));
req.end();
