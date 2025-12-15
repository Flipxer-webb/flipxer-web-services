// Script to fix deposit timestamps via the deployed API
// First, we need to delete the existing incorrect deposits and re-sync
const https = require('https');

// Use a valid admin token (you'll need to provide a fresh one)
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsInBsYXRmb3JtIjoiQURNSU4iLCJpYXQiOjE3NjU3MzUzMzcsImV4cCI6MTc2NTkwODEzN30.gd_k3VvNUWoa32gP0aJwfj06ujgMK0xpyhZiSaxZrlo';

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
