// Debug: Check deposits directly from Quidax for the user
require('dotenv').config();
const https = require('https');

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const QUIDAX_SUB_ACCOUNT = 'f51454e2-c853-4f12-8005-bbf9b43b688a'; // testuser's sub account

// Check all currencies for deposits
const CURRENCIES = ['usdt', 'btc', 'eth', 'usdc', 'sol', 'xrp', 'bnb'];

async function fetchDeposits(currency) {
  return new Promise((resolve, reject) => {
    // We'll call our own debug endpoint
    const body = JSON.stringify({
      subAccountId: QUIDAX_SUB_ACCOUNT,
      currency: currency
    });
    
    const options = {
      hostname: 'flipxer-api.onrender.com',
      path: '/api/v1/admin/transactions/debug-deposits',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ currency, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ currency, status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('This needs a debug endpoint. Let me first add one...');
  console.log('For now, check the Render logs for the sync-deposits call to see what currencies were checked.');
}

main();
