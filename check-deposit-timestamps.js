// Script to fix deposit timestamps via the deployed API
// First, we need to delete the existing incorrect deposits and re-sync
require('dotenv').config();
const https = require('https');

// Use a valid admin token (set via ACCESS_TOKEN env var)
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

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
      console.log('Found transactions:', result.data?.length || 0);
      
      if (result.data) {
        result.data.forEach(tx => {
          console.log(`  - ${tx.orderCategory}: ${tx.amount} ${tx.currency} | Status: ${tx.status} | Created: ${tx.createdAt}`);
        });
      }
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

historyReq.on('error', (e) => {
  console.error('Error:', e.message);
});

historyReq.end();
