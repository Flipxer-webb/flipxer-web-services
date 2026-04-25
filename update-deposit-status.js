// Script to update transaction status via admin API
const https = require('node:https');

const adminAccessToken = process.env.ADMIN_ACCESS_TOKEN;
const apiHostname = process.env.API_HOSTNAME;
const userId = process.argv[2] || process.env.USER_ID || '6';

if (!adminAccessToken) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

if (!apiHostname) {
  console.error('Missing API_HOSTNAME environment variable.');
  process.exit(1);
}

if (!/^\d+$/.test(String(userId))) {
  console.error('Invalid userId. Provide a numeric userId as CLI arg or USER_ID env var.');
  process.exit(1);
}

async function getTransactions(userId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: apiHostname,
      path: `/api/v1/admin/transactions?userId=${encodeURIComponent(userId)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${adminAccessToken}`,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function updateTransactionStatus(transactionId, status) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ status: status });
    
    const options = {
      hostname: apiHostname,
      path: `/api/v1/admin/transactions/${transactionId}/status`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminAccessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('Fetching transactions...');
  const txResult = await getTransactions(userId);
  
  console.log('Raw response:', JSON.stringify(txResult, null, 2));
  
  if (txResult.success && txResult.data?.records) {
    // Flatten grouped transactions
    const allTxs = [];
    for (const group of txResult.data.records) {
      if (group.transactions) {
        allTxs.push(...group.transactions);
      }
    }
    
    console.log(`Found ${allTxs.length} transactions`);
    
    // Find RECEIVE transactions that are pending
    const pendingReceives = allTxs.filter(tx => {
      const streamlinedStatus = tx.streamLinedStatus ?? tx.streamlinedStatus;
      return (
        tx.transactionType === 'RECEIVE' &&
        (streamlinedStatus === 'pending' || tx.status === 'pending')
      );
    });
    
    console.log(`Found ${pendingReceives.length} pending RECEIVE transactions`);
    
    for (const tx of pendingReceives) {
      console.log(`Updating ${tx.transactionId} to completed...`);
      const result = await updateTransactionStatus(tx.transactionId, 'completed');
      console.log(`Result:`, result.status, result.data?.message || result.data);
    }
  } else {
    console.log('Failed to fetch transactions:', txResult);
  }
}

main().catch(console.error);
