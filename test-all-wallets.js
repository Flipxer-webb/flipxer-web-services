// Test all USDT wallet addresses for user 6
require('dotenv').config();
const https = require('https');

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const USER_ID = 6;

// Check TRX/TRON too - the address starts with T
const CURRENCIES = ['usdt', 'trx'];

async function debugWallet(currency) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'flipxer-api.onrender.com',
      path: `/api/v1/admin/transactions/debug-wallet/${USER_ID}/${currency}`,
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
        try {
          resolve({ currency, status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ currency, status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', (e) => resolve({ currency, error: e.message }));
    req.end();
  });
}

async function main() {
  console.log('Checking wallet debug info for all currencies...\n');
  
  for (const currency of CURRENCIES) {
    console.log(`\n=== ${currency.toUpperCase()} ===`);
    const result = await debugWallet(currency);
    console.log(JSON.stringify(result.data || result, null, 2));
  }
}

main();
