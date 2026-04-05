const { Client } = require('pg');

const connectionString = 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d575e4mr433s73egl6p0-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra';

async function findPendingOrders() {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected to database\n');

        // Find all pending BUY orders
        const result = await client.query(`
            SELECT 
                o.id,
                o."transactionId",
                o."orderCategory",
                o.status,
                o."paymentStatus",
                o.amount,
                o.currency,
                o.recipient,
                o."createdAt",
                p.reference as payment_reference,
                p.status as payment_db_status,
                u.email as user_email
            FROM "Orders" o
            LEFT JOIN "Payments" p ON p."orderId" = o.id
            LEFT JOIN "Users" u ON o."userId" = u.id
            WHERE o."orderCategory" = 'BUY'
            AND (o.status = 'pending' OR o."paymentStatus" = 'PENDING')
            ORDER BY o."createdAt" DESC
            LIMIT 10
        `);

        console.log('=== PENDING BUY ORDERS ===\n');

        if (result.rows.length === 0) {
            console.log('No pending buy orders found.');
        } else {
            result.rows.forEach((order, i) => {
                console.log(`--- Order ${i + 1} ---`);
                console.log(`  ID: ${order.id}`);
                console.log(`  Transaction ID: ${order.transactionId}`);
                console.log(`  User: ${order.user_email}`);
                console.log(`  Amount: ${order.amount} ${order.currency}`);
                console.log(`  Status: ${order.status}`);
                console.log(`  Payment Status: ${order.paymentStatus}`);
                console.log(`  Payment Reference: ${order.payment_reference}`);
                console.log(`  Recipient Wallet: ${order.recipient}`);
                console.log(`  Created: ${order.createdAt}`);
                console.log('');
            });
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
        console.log('Disconnected from database');
    }
}

findPendingOrders();
