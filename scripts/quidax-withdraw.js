const https = require('https');

const QUIDAX_API_SECRET = 'ZCEF3SPNO1GGZrV91pgJNz32wVEFdQKiTVO2N69l';

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

const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', body);

        if (res.statusCode === 200 || res.statusCode === 201) {
            console.log('\n✅ Withdrawal initiated successfully!');
        } else {
            console.log('\n❌ Error - check response above');
        }
    });
});

req.on('error', e => console.error('Request Error:', e.message));
req.write(data);
req.end();
