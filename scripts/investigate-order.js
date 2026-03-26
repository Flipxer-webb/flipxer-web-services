require('dotenv').config();
const { Client } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

async function getPaymentDetails() {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected to database');

        // Find payment by order ID
        const paymentQuery = `
            SELECT *
            FROM "Payments" 
            WHERE "orderId" = 9
        `;
        const paymentResult = await client.query(paymentQuery);
        console.log('\n=== PAYMENT DETAILS FOR ORDER ID 9 ===');
        if (paymentResult.rows.length > 0) {
            const payment = paymentResult.rows[0];
            console.log('Payment ID:', payment.id);
            console.log('Reference:', payment.reference);
            console.log('Amount:', payment.amount);
            console.log('Charge Fee:', payment.chargeFee);
            console.log('Total Amount:', payment.totalAmount);
            console.log('Type:', payment.type);
            console.log('Status:', payment.status);
            console.log('Payment Status:', payment.paymentStatus);
            console.log('Payment Method:', payment.paymentMethod);
            console.log('Title:', payment.title);
            console.log('Created At:', payment.createdAt);
            console.log('Updated At:', payment.updatedAt);
            console.log('\n>>> Payment Reference to verify with Fincra:', payment.reference);
        } else {
            console.log('No payment found for order ID 9');
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
        console.log('\nDisconnected from database');
    }
}

getPaymentDetails();
