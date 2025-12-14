// Test the sync deposits endpoint
const https = require('https');

const USER_ID = 6;

// Use the token directly
const ACCESS_TOKEN = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InZpc2l0b3ItYXBwbGljYXRpb24tc2VydmVyLTIwMjEwMjIifQ.eyJwaWQiOiI2ODJmNzUwYTY2OWQ4NTE5MGVhMDI3OWYiLCJ2aWQiOiI2ODJmNzUwYTY2OWQ4NTE5MGVhMDI3OWYtN01XbXFnckNqNW9VMXYwd2ZvUUpVIiwic2lkIjoiNjkzZTk4YWY4M2MwZDJjZWEyNmMwODMwIiwiaWF0IjoxNzY1NzA5OTk5LCJleHAiOjE3NjU3MTE3OTksImp0aSI6IkYycEF5ZHZDcncxckdQWXRJNFZfMyJ9.GVBPRnQwrcFLGFZdqUNcI9jIFmRAM1MVOPXz5imRGcBrNeHHTSm4flUiJco6A4CdRsdowhNFSXptFvM1--RU_g';

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
