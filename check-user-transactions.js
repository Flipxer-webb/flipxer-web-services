// Check wallet addresses and deposits via API
const https = require('node:https');

const USER_ID = 6;
const ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

// First get user transactions
console.log(`Fetching transactions for user ${USER_ID}...`);

const options = {
  hostname: 'flipxer-api.onrender.com',
  path: `/api/v1/admin/transactions?userId=${USER_ID}&limit=20`,
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
    console.log('Response status:', res.statusCode);
    try {
      const result = JSON.parse(data);
      if (result.data?.transactions) {
        const deposits = result.data.transactions.filter(t => t.orderCategory === 'RECEIVE');
        console.log(`\nFound ${deposits.length} deposit transactions.`);
        
        if (deposits.length === 0) {
          console.log('No deposit transactions found for this user.');
        }
      } else {
        console.log('Transactions response parsed without a transaction list.');
      }
    } catch {
      console.log('Could not parse the transaction response JSON.');
    }
  });
});

req.on('error', () => {
  console.error('Transaction history request failed.');
});

req.end();
