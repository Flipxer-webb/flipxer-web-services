// Script to fix deposit timestamps via the deployed API
// First, we need to delete the existing incorrect deposits and re-sync
const https = require('node:https');

const ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

// User ID for test user
const USER_ID = 6;

// Step 1: Get existing deposits via transaction history
console.log(`Step 1: Fetching transaction history for user ${USER_ID}...`);

const historyOptions = {
  hostname: 'flipxer-api.onrender.com',
  path: `/api/v1/admin/transactions?userId=${USER_ID}&page=1&limit=10`,
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

const historyReq = https.request(historyOptions, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('History response status:', res.statusCode);
    try {
      const result = JSON.parse(data);
      console.log('Transaction history parsed successfully.');
      
      if (result.data) {
        console.log('Transaction records were returned.');
      }
    } catch {
      console.log('Transaction history response was not valid JSON.');
    }
  });
});

historyReq.on('error', (e) => {
  console.error('Error:', e.message);
});

historyReq.end();
