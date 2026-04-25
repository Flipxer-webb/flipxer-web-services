/**
 * Script to verify and fix pending Fincra payments
 * 
 * This script will:
 * 1. Verify the payment status with Fincra API
 * 2. If payment is successful, manually process it
 * 
 * Usage: node scripts/fix-pending-payment.js [payment-reference]
 */

require('dotenv').config();
const axios = require('axios');
const { Client } = require('pg');

const PAYMENT_REFERENCE = process.argv[2] || 'b81ab9d4d376ed6hh9d7236e75852g';

// Fincra config from environment
const FINCRA_BASE_URL = process.env.FINCRA_BASE_URL || 'https://api.fincra.com';
const FINCRA_SECRET_KEY = process.env.FINCRA_SECRET_KEY;
const FINCRA_PUBLIC_KEY = process.env.FINCRA_PUBLIC_KEY;
const FINCRA_BUSINESS_ID = process.env.FINCRA_BUSINESS_ID;

// Database connection
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not found in environment');
    process.exit(1);
}

async function verifyPaymentWithFincra(reference) {
    console.log(`\n=== Verifying payment with Fincra ===`);
    console.log(`Reference: ${reference}`);
    console.log(`Fincra Base URL: ${FINCRA_BASE_URL}`);
    console.log(`Business ID: ${FINCRA_BUSINESS_ID}`);

    if (!FINCRA_SECRET_KEY) {
        console.error('ERROR: FINCRA_SECRET_KEY not found in environment');
        console.log('Please set the environment variables or run from the backend project directory');
        return null;
    }

    try {
        const response = await axios({
            method: 'GET',
            url: `${FINCRA_BASE_URL}/checkout/payments/merchant-reference/${reference}`,
            headers: {
                'api-key': FINCRA_SECRET_KEY,
                'x-pub-key': FINCRA_PUBLIC_KEY,
                'x-business-id': FINCRA_BUSINESS_ID,
                'Content-Type': 'application/json',
            },
        });

        console.log('\n=== Fincra Response ===');
        console.log(JSON.stringify(response.data, null, 2));

        return response.data;
    } catch (error) {
        console.error('Error calling Fincra API:', error.response?.data || error.message);
        return null;
    }
}

async function manuallyProcessPayment(reference) {
    console.log(`\n=== Manually processing payment ===`);

    const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected to database');

        // Find the payment record
        const paymentResult = await client.query(`
            SELECT * FROM "Payments" WHERE "reference" = $1
        `, [reference]);

        if (paymentResult.rows.length === 0) {
            console.log('Payment not found with reference:', reference);
            return false;
        }

        const payment = paymentResult.rows[0];
        console.log(`Found payment ID: ${payment.id}`);
        console.log(`Current status: ${payment.status}`);
        console.log(`Payment status: ${payment.paymentStatus}`);
        console.log(`Order ID: ${payment.orderId}`);

        if (payment.paymentStatus === 'SUCCESS') {
            console.log('Payment already processed as SUCCESS');
            return true;
        }

        // Update payment status to SUCCESS
        await client.query(`
            UPDATE "Payments" 
            SET status = 'SUCCESS', "paymentStatus" = 'SUCCESS', "updatedAt" = NOW()
            WHERE id = $1
        `, [payment.id]);

        console.log('✅ Payment status updated to SUCCESS');

        // Update order status if exists
        if (payment.orderId) {
            await client.query(`
                UPDATE "Orders" 
                SET status = 'confirmed', 
                    "streamlinedStatus" = 'completed',
                    "paymentStatus" = 'SUCCESS',
                    "updatedAt" = NOW()
                WHERE id = $1
            `, [payment.orderId]);

            console.log('✅ Order status updated to confirmed/completed');

            // Get order details for notification
            const orderResult = await client.query(`
                SELECT * FROM "Orders" WHERE id = $1
            `, [payment.orderId]);

            if (orderResult.rows.length > 0) {
                const order = orderResult.rows[0];
                console.log(`\nOrder Details:`);
                console.log(`  Transaction ID: ${order.transactionId}`);
                console.log(`  Amount: ${order.amount} ${order.currency}`);
                console.log(`  Status: ${order.status}`);
                console.log(`  Category: ${order.orderCategory}`);

                if (order.orderCategory === 'BUY') {
                    console.log('\n⚠️ NOTE: This was a BUY order.');
                    console.log('The crypto withdrawal to the user wallet needs to be initiated manually via Quidax.');
                    console.log(`  Recipient wallet: ${order.recipient}`);
                    console.log(`  Amount to send: ${order.amount} ${order.currency}`);
                }
            }
        }

        return true;
    } catch (error) {
        console.error('Database error:', error.message);
        return false;
    } finally {
        await client.end();
        console.log('\nDisconnected from database');
    }
}

async function main() {
    console.log('=== Fincra Payment Verification & Fix Script ===');
    console.log(`Payment Reference: ${PAYMENT_REFERENCE}`);
    console.log(`Date: ${new Date().toISOString()}`);

    // Step 1: Verify with Fincra
    const fincraResult = await verifyPaymentWithFincra(PAYMENT_REFERENCE);

    if (fincraResult && fincraResult.data) {
        const status = fincraResult.data.status?.toLowerCase();
        console.log(`\nFincra payment status: ${status}`);

        if (status === 'success' || status === 'successful') {
            console.log('✅ Payment confirmed as successful by Fincra');

            // Step 2: Manually process the payment in database
            const processed = await manuallyProcessPayment(PAYMENT_REFERENCE);

            if (processed) {
                console.log('\n✅ Payment has been processed successfully!');
                console.log('The order status should now show as completed.');
            } else {
                console.log('\n❌ Failed to process payment in database');
            }
        } else if (status === 'pending') {
            console.log('⏳ Payment is still pending on Fincra');
        } else if (status === 'failed') {
            console.log('❌ Payment failed on Fincra');
        } else {
            console.log(`Unknown status: ${status}`);
        }
    } else {
        console.log('\n❌ Could not verify payment with Fincra');
        console.log('\nWould you like to manually process this payment anyway? (y/n)');
        console.log('Run the script with --force flag to force process');

        if (process.argv.includes('--force')) {
            console.log('\n--force flag detected, processing anyway...');
            await manuallyProcessPayment(PAYMENT_REFERENCE);
        }
    }
}

main().catch(console.error);
