/**
 * Script to create the missing admin SELL order record
 * 
 * This script should be run AFTER you manually send the crypto via Quidax.
 * It creates the admin order record to keep transaction tracking consistent.
 * 
 * Usage: 
 *   node scripts/create-admin-sell-order.js --orderId=9 --quidaxTxId=YOUR_QUIDAX_TX_ID --fee=0.5
 * 
 * Arguments:
 *   --orderId     : The original buy order ID (e.g., 9)
 *   --quidaxTxId  : The Quidax transaction/withdrawal ID after manual send
 *   --fee         : The Quidax fee charged (in crypto units)
 */

require('dotenv').config();
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL ||
    'postgresql://resolve_db_user:Bje9vozyOzdFC7qxy4hybDDiSUle7Wyc@dpg-d575e4mr433s73egl6p0-a.oregon-postgres.render.com/resolve_db_4a8l_b6ra';

// Parse command line arguments
function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        const [key, value] = arg.replace('--', '').split('=');
        args[key] = value;
    });
    return args;
}

function generateTransactionId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 14; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function generateReference() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function createAdminSellOrder() {
    const args = parseArgs();

    if (!args.orderId) {
        console.error('ERROR: --orderId is required');
        console.log('Usage: node scripts/create-admin-sell-order.js --orderId=9 --quidaxTxId=YOUR_TX_ID --fee=0.5');
        process.exit(1);
    }

    const orderId = parseInt(args.orderId);
    const quidaxTxId = args.quidaxTxId || 'MANUAL_SEND_' + Date.now();
    const fee = parseFloat(args.fee) || 0;

    console.log('=== Create Admin SELL Order for Reconciliation ===');
    console.log(`Original Order ID: ${orderId}`);
    console.log(`Quidax Transaction ID: ${quidaxTxId}`);
    console.log(`Fee: ${fee}`);
    console.log('');

    const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();
        console.log('Connected to database');

        // Get the original buy order
        const orderResult = await client.query(`
            SELECT * FROM "Orders" WHERE id = $1
        `, [orderId]);

        if (orderResult.rows.length === 0) {
            console.error(`Order with ID ${orderId} not found!`);
            process.exit(1);
        }

        const buyOrder = orderResult.rows[0];
        console.log(`\nOriginal Buy Order:`);
        console.log(`  Amount: ${buyOrder.amount} ${buyOrder.currency}`);
        console.log(`  Recipient: ${buyOrder.recipient}`);
        console.log(`  Status: ${buyOrder.status}`);

        // Get admin user (super-admin)
        const adminResult = await client.query(`
            SELECT u.id, u.email FROM "Users" u
            JOIN "Roles" r ON u."roleId" = r.id
            WHERE r.slug = 'super-admin'
            LIMIT 1
        `);

        if (adminResult.rows.length === 0) {
            console.error('Admin user not found!');
            process.exit(1);
        }

        const admin = adminResult.rows[0];
        console.log(`\nAdmin User: ${admin.email} (ID: ${admin.id})`);

        // Check if admin sell order already exists for this buy order
        const existingCheck = await client.query(`
            SELECT id FROM "Orders" 
            WHERE "orderCategory" = 'SELL' 
            AND "userId" = $1
            AND recipient = $2
            AND amount = $3
            AND "createdAt" > $4
        `, [admin.id, buyOrder.recipient, buyOrder.amount, buyOrder.createdAt]);

        if (existingCheck.rows.length > 0) {
            console.log(`\n⚠️ Admin SELL order already exists (ID: ${existingCheck.rows[0].id})`);
            console.log('No new order created.');
            return;
        }

        // Generate IDs
        const transactionId = generateTransactionId();
        const orderReference = generateReference();
        const total = parseFloat(buyOrder.amount) + fee;

        // Create the admin SELL order
        const insertResult = await client.query(`
            INSERT INTO "Orders" (
                "orderCategory",
                "transactionId",
                "orderReference",
                "providerOrderId",
                "userId",
                "currency",
                "amount",
                "fee",
                "total",
                "recipient",
                "destinationTag",
                "status",
                "streamlinedStatus",
                "paymentStatus",
                "narration",
                "transaction_note",
                "sourceType",
                "amountInFiat",
                "rateAtConversion",
                "referenceFiatCurrency",
                "createdAt",
                "updatedAt"
            ) VALUES (
                'SELL',
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                'completed',
                'completed',
                'SUCCESS',
                'flipxer buy order transaction - manual reconciliation',
                'flipxer buy order transaction',
                'withdraw',
                $11,
                $12,
                'NGN',
                NOW(),
                NOW()
            ) RETURNING id
        `, [
            transactionId,
            orderReference,
            quidaxTxId,
            admin.id,
            buyOrder.currency,
            buyOrder.amount,
            fee,
            total,
            buyOrder.recipient,
            buyOrder.destinationTag,
            buyOrder.amountInFiat,
            buyOrder.rateAtConversion
        ]);

        const newOrderId = insertResult.rows[0].id;

        console.log(`\n✅ Admin SELL order created successfully!`);
        console.log(`  New Order ID: ${newOrderId}`);
        console.log(`  Transaction ID: ${transactionId}`);
        console.log(`  Reference: ${orderReference}`);
        console.log(`  Provider Order ID: ${quidaxTxId}`);
        console.log(`  Amount: ${buyOrder.amount} ${buyOrder.currency}`);
        console.log(`  Fee: ${fee} ${buyOrder.currency}`);
        console.log(`  Total: ${total} ${buyOrder.currency}`);
        console.log(`\n📊 Transaction records are now reconciled!`);

    } catch (error) {
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        await client.end();
        console.log('\nDisconnected from database');
    }
}

createAdminSellOrder();
