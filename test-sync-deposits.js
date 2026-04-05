// Test the sync deposits endpoint
const https = require('https');

const USER_ID = 6;

// Use the token directly
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjEsInBsYXRmb3JtIjoiQURNSU4iLCJpYXQiOjE3NjU3MzUzMzcsImV4cCI6MTc2NTkwODEzN30.gd_k3VvNUWoa32gP0aJwfj06ujgMK0xpyhZiSaxZrlo';

// Call sync deposits endpoint directly
console.log(`Calling sync-deposits for user ${USER_ID}...`);

const syncOptions = {
  hostname: 'flipxer-api.onrender.com',
  path: `/api/v1/admin/transactions/sync-deposits/${USER_ID}`,
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  }
};

const syncReq = https.request(syncOptions, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Sync response status:', res.statusCode);
    try {
      const result = JSON.parse(data);
      console.log('Sync response:', JSON.stringify(result, null, 2));
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

syncReq.on('error', (e) => {
  console.error('Error:', e.message);
});

syncReq.end();
