/**
 * Trigger Quidax Withdrawal for Order 12
 * 
 * This script calls the Quidax API to initiate a crypto withdrawal.
 * 
 * Run on Render Shell (where QUIDAX_API_SECRET is available):
 *   node trigger-quidax-withdrawal.js
 * 
 * Or locally with the secret:
 *   QUIDAX_API_SECRET=your_secret node trigger-quidax-withdrawal.js
 */

require('dotenv').config();
const { request } = require('node:https');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const QUIDAX_API_SECRET = process.env.QUIDAX_API_SECRET;
const ORDER_ID = 12;

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable not set');
    process.exit(1);
}

if (!QUIDAX_API_SECRET) {
    console.error('ERROR: QUIDAX_API_SECRET environment variable not set');
    console.log('Run: QUIDAX_API_SECRET=your_secret node trigger-quidax-withdrawal.js');
    process.exit(1);
}

async function getOrderDetails() {
    const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const result = await client.query(`
        SELECT o.*, u."cryptoSubAccountId" as user_sub_account
        FROM "Orders" o
        JOIN "Users" u ON o."userId" = u.id
        WHERE o.id = $1
    `, [ORDER_ID]);

    // Get admin user sub account
    const adminResult = await client.query(`
        SELECT u."cryptoSubAccountId"
        FROM "Users" u
        JOIN "Roles" r ON u."roleId" = r.id
        WHERE r.slug = 'super-admin'
        LIMIT 1
    `);

    await client.end();

    return {
        order: result.rows[0],
        adminSubAccount: adminResult.rows[0]?.cryptoSubAccountId
    };
}

async function createWithdrawal(subAccountId, currency, amount, address, destinationTag) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            currency: currency.toLowerCase(),
            amount: amount.toString(),
            fund_uid: address,
            fund_uid2: destinationTag || undefined,
            transaction_note: 'Flipxer buy order - Order 12'
        });

        const options = {
            hostname: 'www.quidax.com',
            port: 443,
            path: `/api/v1/users/${subAccountId}/withdraws`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${QUIDAX_API_SECRET}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        console.log('Making Quidax withdrawal request...');
        console.log('Path:', options.path);
        console.log('Data:', data);

        const req = request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                console.log('Status:', res.statusCode);
                console.log('Response:', body);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(body));
                } else {
                    reject(new Error(`Quidax error: ${body}`));
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function updateDatabaseWithQuidaxResult(providerOrderId) {
    const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();

    // Get admin ID
    const adminResult = await client.query(`
        SELECT u.id FROM "Users" u
        JOIN "Roles" r ON u."roleId" = r.id
        WHERE r.slug = 'super-admin' LIMIT 1
    `);
    const adminId = adminResult.rows[0]?.id;

    // Create admin SELL order for reconciliation
    const transactionId = 'ADMIN' + Date.now().toString(36).toUpperCase();
    await client.query(`
        INSERT INTO "Orders" (
            "orderCategory", "transactionId", "providerOrderId", "userId",
            "currency", "amount", "fee", "total", "recipient",
            "status", "streamlinedStatus", "paymentStatus",
            "narration", "sourceType", "createdAt", "updatedAt"
        ) VALUES (
            'SELL', $1, $2, $3, 'USDT', 10, 0, 10,
            '0xa4321E0503EE7Ed12864F2E81C65FCe3B96579fa',
            'completed', 'completed', 'SUCCESS',
            'Flipxer buy order - Order 12', 'withdraw', NOW(), NOW()
        )
    `, [transactionId, providerOrderId, adminId]);

    await client.end();
    console.log('✅ Admin SELL order created for reconciliation');
}

async function main() {
    console.log('=== Quidax Withdrawal Trigger ===\n');

    try {
        // Get order details
        const { order, adminSubAccount } = await getOrderDetails();

        if (!order) {
            console.error('Order not found!');
            process.exit(1);
        }

        console.log('Order Details:');
        console.log('  ID:', order.id);
        console.log('  Amount:', order.amount, order.currency);
        console.log('  Recipient:', order.recipient);
        console.log('  Admin Sub Account:', adminSubAccount);
        console.log('');

        // Use 'me' for the main account
        const subAccountId = adminSubAccount || 'me';

        // Create withdrawal
        const result = await createWithdrawal(
            subAccountId,
            order.currency,
            order.amount,
            order.recipient,
            order.destinationTag
        );

        console.log('\n✅ Quidax withdrawal initiated!');
        console.log('Withdrawal ID:', result.data?.id);

        // Update database
        await updateDatabaseWithQuidaxResult(result.data?.id || 'MANUAL-' + Date.now());

        console.log('\n🎉 Transaction complete! User should receive crypto shortly.');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
    }
}

main();
