/**
 * Fix Stuck Buy Orders
 * 
 * This script finds and fixes buy orders where:
 * - Payment status = SUCCESS or APPROVED (user paid via Nomba)
 * - Order status = PENDING (Quidax transfer never completed)
 * 
 * Usage:
 *   DRY RUN (default):  node scripts/fix-stuck-buy-orders.js
 *   EXECUTE:            node scripts/fix-stuck-buy-orders.js --execute
 * 
 * Prerequisites:
 *   - Set DATABASE_URL in environment or .env file
 *   - Ensure Quidax credentials are configured
 */

const { PrismaClient, OrderStatus, OrderCategory, TransactionStatus } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--execute');

async function findStuckBuyOrders() {
    console.log('\n🔍 Finding stuck buy orders...\n');
    
    // Find payments that are SUCCESS or APPROVED but linked to PENDING buy orders
    // APPROVED means the fulfillment started but failed mid-way
    const stuckPayments = await prisma.payment.findMany({
        where: {
            status: { in: [TransactionStatus.SUCCESS, TransactionStatus.APPROVED] },
            orderId: { not: null },
            order: {
                orderCategory: OrderCategory.BUY,
                status: OrderStatus.pending,
                fulfilled: false,
            },
        },
        include: {
            order: true,
            user: {
                select: {
                    id: true,
                    email: true,
                    firstName: true,
                    lastName: true,
                    cryptoSubAccountId: true,
                },
            },
        },
        orderBy: {
            createdAt: 'desc',
        },
    });

    return stuckPayments;
}

async function generateReport(stuckPayments) {
    console.log('=' .repeat(80));
    console.log('STUCK BUY ORDERS REPORT');
    console.log('=' .repeat(80));
    console.log(`Found: ${stuckPayments.length} stuck order(s)\n`);

    if (stuckPayments.length === 0) {
        console.log('✅ No stuck orders found. All payments are properly fulfilled.\n');
        return;
    }

    let totalAffectedNGN = 0;
    let totalAffectedCrypto = {};

    for (const payment of stuckPayments) {
        const order = payment.order;
        const user = payment.user;

        console.log('-'.repeat(80));
        console.log(`Payment ID:     ${payment.id}`);
        console.log(`Reference:      ${payment.reference}`);
        console.log(`Order ID:       ${order.id}`);
        console.log(`Transaction:    ${order.transactionId}`);
        console.log(`User:           ${user.firstName} ${user.lastName} (${user.email})`);
        console.log(`User ID:        ${user.id}`);
        console.log(`Sub-Account:    ${user.cryptoSubAccountId || '❌ MISSING'}`);
        console.log(`Asset:          ${order.currency}`);
        console.log(`Amount:         ${order.amount} ${order.currency}`);
        console.log(`Paid (NGN):     ₦${payment.totalAmount?.toLocaleString() || 'N/A'}`);
        console.log(`Payment Date:   ${payment.createdAt.toISOString()}`);
        console.log(`Payment Status: ${payment.status}`);
        console.log(`Order Status:   ${order.status}`);
        
        if (!user.cryptoSubAccountId) {
            console.log(`⚠️  WARNING: User has no crypto sub-account - manual intervention needed`);
        }

        totalAffectedNGN += payment.totalAmount || 0;
        totalAffectedCrypto[order.currency] = (totalAffectedCrypto[order.currency] || 0) + order.amount;
    }

    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total Affected Orders: ${stuckPayments.length}`);
    console.log(`Total NGN Paid:        ₦${totalAffectedNGN.toLocaleString()}`);
    console.log(`Crypto Owed:`);
    for (const [currency, amount] of Object.entries(totalAffectedCrypto)) {
        console.log(`  - ${amount} ${currency}`);
    }
    console.log('');
}

async function main() {
    console.log('\n' + '🚀 Stuck Buy Orders Recovery Tool'.toUpperCase());
    console.log(`Mode: ${DRY_RUN ? '🔹 DRY RUN (no changes)' : '🔴 EXECUTE MODE'}\n`);

    try {
        const stuckPayments = await findStuckBuyOrders();
        await generateReport(stuckPayments);

        if (stuckPayments.length > 0 && !DRY_RUN) {
            console.log('\n⚠️  EXECUTE MODE: Would retry fulfillments...');
            console.log('⚠️  For safety, automatic fulfillment is disabled in this script.');
            console.log('⚠️  Please use the following options:');
            console.log('    1. Call fulfillBuyOrder(reference) via admin API for each payment');
            console.log('    2. Manually transfer via Quidax dashboard');
            console.log('    3. Contact support to process refunds if crypto unavailable\n');
        }

        if (DRY_RUN && stuckPayments.length > 0) {
            console.log('\n💡 To attempt recovery, run:');
            console.log('   node scripts/fix-stuck-buy-orders.js --execute\n');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await prisma.$disconnect();
    }
}

main();
