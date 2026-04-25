// Script to update transaction status via admin API
const https = require('https');

const ACCESS_TOKEN = process.env.ADMIN_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing ADMIN_ACCESS_TOKEN environment variable.');
  process.exit(1);
}

// Transaction IDs from the sync (these are the deposit IDs from Quidax)
const depositIds = [
  '94c290f3-7eee-40c1-b2e1-9ca944216542',
  '13d52998-cc7b-4fda-8086-4476a03356ee',
  'd93f0388-2fcf-4969-8d52-a6976ae0baa5'
];

async function getTransactions() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'flipxer-api.onrender.com',
      path: '/api/v1/admin/transactions?userId=6',
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
          resolve(JSON.parse(data));
        } catch (e) {
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
      hostname: 'flipxer-api.onrender.com',
      path: `/api/v1/admin/transactions/${transactionId}/status`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
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
        } catch (e) {
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
  console.log('Fetching transactions for user 6...');
  const txResult = await getTransactions();
  
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
    const pendingReceives = allTxs.filter(tx => 
      tx.transactionType === 'RECEIVE' && 
      (tx.streamLinedStatus === 'pending' || tx.status === 'pending')
    );
    
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
