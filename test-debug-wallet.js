// Test debug-wallet endpoint
require('dotenv').config();
const https = require('https');

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const USER_ID = 6;
const CURRENCY = 'usdt';

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
      const result = JSON.parse(data);
      console.log('\n=== DEBUG WALLET INFO ===\n');
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.log('Raw:', data);
    }
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.end();
