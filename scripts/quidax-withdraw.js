require('dotenv').config();
const { request } = require('node:https');

const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;

if (!QUIDAX_API_SECRET) {
    console.error('Missing QUIDAX_API_SECRET environment variable.');
    process.exit(1);
}

const data = JSON.stringify({
    currency: 'usdt',
    amount: '10',
    fund_uid: '0xa4321E0503EE7Ed12864F2E81C65FCe3B96579fa',
    transaction_note: 'Flipxer Order 12'
});

// Try the main Quidax API
const options = {
    hostname: 'www.quidax.com',
    port: 443,
    path: '/api/v1/users/me/withdraws',
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
};

console.log('=== Quidax Withdrawal Request ===');
console.log('Amount: 10 USDT');
console.log('Recipient: 0xa4321E0503EE7Ed12864F2E81C65FCe3B96579fa');
console.log('URL:', `https://${options.hostname}${options.path}`);
console.log('');

const req = request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response body received.');

        if (res.statusCode === 200 || res.statusCode === 201) {
            console.log('\n✅ Withdrawal initiated successfully!');
        } else {
            console.log('\n❌ Error - check response above');
        }
    });
});

req.on('error', (error) => console.error('Withdrawal request failed:', error.message));
req.write(data);
req.end();
