require('dotenv').config();
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
const useSsl = connectionString && !/localhost|127\.0\.0\.1/.test(connectionString);

if (!connectionString) {
    console.error('Missing DATABASE_URL environment variable.');
    process.exit(1);
}

async function fixOrder12() {
    const client = new Client({ connectionString, ssl: useSsl ? { rejectUnauthorized: false } : false });

    try {
        await client.connect();
        console.log('Connected\n');

        // Update Order 12 directly
        console.log('=== UPDATING ORDER 12 ===');
        const updateOrder = await client.query(`
            UPDATE "Orders" 
            SET 
                status = 'confirmed',
                "streamlinedStatus" = 'completed',
                "paymentStatus" = 'SUCCESS',
                "updatedAt" = NOW()
            WHERE id = 12
            RETURNING id, status, "streamlinedStatus", "paymentStatus"
        `);

        if (updateOrder.rows.length > 0) {
            console.log('Order 12 updated:');
            console.log('  Status:', updateOrder.rows[0].status);
            console.log('  Streamlined:', updateOrder.rows[0].streamlinedStatus);
            console.log('  Payment:', updateOrder.rows[0].paymentStatus);
        }

        // Update Payment for Order 12
        console.log('\n=== UPDATING PAYMENT FOR ORDER 12 ===');
        const updatePayment = await client.query(`
            UPDATE "Payments"
            SET 
                status = 'SUCCESS',
                "paymentStatus" = 'SUCCESS',
                "updatedAt" = NOW()
            WHERE "orderId" = 12
            RETURNING id, reference, status, "paymentStatus"
        `);

        if (updatePayment.rows.length > 0) {
            console.log('Payment updated:');
            console.log('  ID:', updatePayment.rows[0].id);
            console.log('  Reference:', updatePayment.rows[0].reference);
            console.log('  Status:', updatePayment.rows[0].status);
        }

        // Get order details for Quidax manual send
        console.log('\n=== ORDER DETAILS FOR QUIDAX SEND ===');
        const orderDetails = await client.query(`
            SELECT amount, currency, recipient, "destinationTag"
            FROM "Orders" WHERE id = 12
        `);

        if (orderDetails.rows.length > 0) {
            const o = orderDetails.rows[0];
            console.log('Amount to send:', o.amount, o.currency);
            console.log('Recipient wallet:', o.recipient);
            console.log('Destination tag:', o.destinationTag || 'None');
        }

        console.log('\n✅ Database updated! Now send crypto via Quidax dashboard.');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

fixOrder12();
