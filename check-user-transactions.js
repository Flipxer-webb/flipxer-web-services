// Check wallet addresses and deposits via API
const https = require('https');

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
        console.log(`\nFound ${deposits.length} deposit transactions:`);
        deposits.forEach((t, i) => {
          console.log(`${i + 1}. ${t.currency}: ${t.amount}`);
          console.log(`   Status: ${t.status}, ID: ${t.transactionId}`);
          console.log(`   Created: ${t.createdAt}`);
          console.log('');
        });
        
        if (deposits.length === 0) {
          console.log('No deposit transactions found for this user.');
        }
      } else {
        console.log('Response:', JSON.stringify(result, null, 2));
      }
    } catch (e) {
      console.log('Parse error:', e.message);
      console.log('Raw response:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.end();
