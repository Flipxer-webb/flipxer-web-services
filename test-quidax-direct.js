// Direct Quidax API test - Check wallets and deposits
const https = require('https');

// You need to set these from your Render environment
const QUIDAX_SECRET_KEY = process.env.QUIDAX_SECRET_KEY;
const QUIDAX_SUB_ACCOUNT = 'f51454e2-c853-4f12-8005-bbf9b43b688a';

if (!QUIDAX_SECRET_KEY) {
  console.log('Set QUIDAX_SECRET_KEY first:');
  console.log('$env:QUIDAX_SECRET_KEY="your_key_here"; node test-quidax-direct.js');
  process.exit(1);
}

function quidaxRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.quidax.com',
      path: `/api/v1${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${QUIDAX_SECRET_KEY}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('=== Testing Quidax API Directly ===\n');
  
  // 1. Get all wallets for the sub-account
  console.log('1. Fetching all wallets...');
  const wallets = await quidaxRequest(`/users/${QUIDAX_SUB_ACCOUNT}/wallets`);
  
  if (wallets.data?.data) {
    console.log('\nWallets with non-zero balance:');
    wallets.data.data.filter(w => parseFloat(w.balance) > 0 || parseFloat(w.locked) > 0).forEach(w => {
      console.log(`  ${w.currency.toUpperCase()}: balance=${w.balance}, locked=${w.locked}`);
    });
  } else {
    console.log('Wallets response:', JSON.stringify(wallets, null, 2));
  }

  // 2. Get USDT deposits specifically
  console.log('\n2. Fetching USDT deposits...');
  const usdtDeposits = await quidaxRequest(`/users/${QUIDAX_SUB_ACCOUNT}/wallets/usdt/deposits`);
  console.log('USDT Deposits:', JSON.stringify(usdtDeposits.data?.data || usdtDeposits, null, 2));

  // 3. Get TRX deposits (since it's TRON network)
  console.log('\n3. Fetching TRX deposits...');
  const trxDeposits = await quidaxRequest(`/users/${QUIDAX_SUB_ACCOUNT}/wallets/trx/deposits`);
  console.log('TRX Deposits:', JSON.stringify(trxDeposits.data?.data || trxDeposits, null, 2));

  // 4. Get USDT wallet address
  console.log('\n4. Fetching USDT wallet address...');
  const usdtAddress = await quidaxRequest(`/users/${QUIDAX_SUB_ACCOUNT}/wallets/usdt/address`);
  console.log('USDT Address:', JSON.stringify(usdtAddress.data?.data || usdtAddress, null, 2));
}

main().catch(console.error);
