const { Client } = require('pg');

const connectionString = 'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d575e4mr433s73egl6p0-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra';

async function checkOrderStatus() {
    const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected\n');

        // Check order 12
        const order = await client.query(`SELECT status, "streamlinedStatus", "paymentStatus", amount, currency FROM "Orders" WHERE id = 12`);

        if (order.rows.length > 0) {
            console.log('=== ORDER 12 STATUS ===');
            console.log('Status:', order.rows[0].status);
            console.log('Streamlined Status:', order.rows[0].streamlinedStatus);
            console.log('Payment Status:', order.rows[0].paymentStatus);
            console.log('Amount:', order.rows[0].amount, order.rows[0].currency);
        }

        // Check if admin SELL order was created (Quidax withdrawal record)
        const adminOrders = await client.query(`
            SELECT id, "transactionId", status, amount, currency, "providerOrderId"
            FROM "Orders" 
            WHERE "orderCategory" = 'SELL'
            ORDER BY "createdAt" DESC
            LIMIT 3
        `);

        console.log('\n=== RECENT ADMIN SELL ORDERS (Quidax Withdrawals) ===');
        if (adminOrders.rows.length > 0) {
            adminOrders.rows.forEach(o => {
                console.log(`ID: ${o.id}, Status: ${o.status}, Amount: ${o.amount} ${o.currency}, Provider: ${o.providerOrderId || 'N/A'}`);
            });
        } else {
            console.log('No admin sell orders found');
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

checkOrderStatus();
