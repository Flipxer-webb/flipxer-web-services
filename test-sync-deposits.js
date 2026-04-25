// Test the sync deposits endpoint
const https = require('node:https');

const USER_ID = 6;

const ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

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
      JSON.parse(data);
      console.log('Sync response parsed successfully.');
    } catch {
      console.log('Sync response was not valid JSON.');
    }
  });
});

syncReq.on('error', () => {
  console.error('Sync request failed.');
});

syncReq.end();
