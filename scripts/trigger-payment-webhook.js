/**
 * Script to simulate Fincra webhook and trigger payment processing
 * 
 * This can be run on Render Shell where environment variables are available.
 * 
 * Usage: 
 *   node trigger-payment-webhook.js 234b973aaca7h9bfege693
 */

const crypto = require('crypto');
const https = require('https');

const paymentReference = process.argv[2] || '234b973aaca7h9bfege693';

// Must match the FINCRA_WEBHOOK_SECRET on your server
const webhookSecret = process.env.FINCRA_WEBHOOK_SECRET;

if (!webhookSecret) {
    console.error('ERROR: FINCRA_WEBHOOK_SECRET environment variable is not set');
    console.error('This script must be run on the server where the env var is available');
    console.error('');
    console.error('If you have the secret, you can run:');
    console.error('  FINCRA_WEBHOOK_SECRET=your_secret_here node trigger-payment-webhook.js ' + paymentReference);
    process.exit(1);
}

// Construct the webhook payload (simulating Fincra collection.successful)
const payload = {
    event: 'collection.successful',
    data: {
        merchantReference: paymentReference,
        reference: `fincra-ref-manual-${paymentReference}`,
        status: 'success',
        amount: 14500,
        amountReceived: 14500,
        fee: 0,
        currency: 'NGN'
    }
};

const payloadString = JSON.stringify(payload);

// Compute HMAC SHA512 signature (same as Fincra uses)
const signature = crypto
    .createHmac('sha512', webhookSecret)
    .update(payloadString)
    .digest('hex');

console.log('=== Fincra Webhook Simulation ===');
console.log('Payment Reference:', paymentReference);
console.log('Signature:', signature.substring(0, 40) + '...');
console.log('');

// Make the webhook call
const options = {
    hostname: 'flipxer-api.onrender.com',
    port: 443,
    path: '/api/webhook/fincra',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-fincra-signature': signature,
        'Content-Length': Buffer.byteLength(payloadString)
    }
};

console.log('Making POST request to: https://' + options.hostname + options.path);
console.log('');

const req = https.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log('=== Response ===');
        console.log('Status:', res.statusCode);
        console.log('Body:', data);
        console.log('');

        if (res.statusCode === 200) {
            console.log('✅ Webhook processed successfully!');
            console.log('The Quidax withdrawal should now be initiated.');
        } else {
            console.log('❌ Webhook may have failed. Check the response above.');
        }
    });
});

req.on('error', (e) => {
    console.error('Request error:', e.message);
});

req.write(payloadString);
req.end();
