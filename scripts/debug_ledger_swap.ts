
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

async function main() {
    console.log('--- Checking Recent Swaps (Last 5) ---');
    const recentSwaps = await prisma.order.findMany({
        where: {
            orderCategory: 'SWAP',
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
            user: {
                select: { email: true, id: true } // Select minimal fields to avoid huge output
            }
        }
    });

    if (recentSwaps.length === 0) {
        console.log('No swaps found.');
    } else {
        recentSwaps.forEach(swap => {
            console.log(`Swap ID: ${swap.id} (Tx: ${swap.transactionId}) - Status: ${swap.status} - Streamlined: ${swap.streamlinedStatus}`);
            console.log(`  User: ${swap.user?.email || 'N/A'}`);
            console.log(`  Created: ${swap.createdAt.toISOString()}`);
            console.log(`  Amount: ${swap.fromAmount} ${swap.fromCurrency} -> ${swap.toAmount} ${swap.toCurrency}`);
            console.log(`  Quidax Order ID: ${swap.providerOrderId || 'N/A'}`);
            console.log(`  Quidax Reference: ${swap.orderReference || 'N/A'}`);
            console.log(`  Error/Note: ${swap.transaction_note || 'N/A'}`);
            console.log('  -----------------------------------');
        });
    }

    console.log('\n--- Checking Recent Ledger Entries (Last 10) ---');
    const ledgerEntries = await prisma.ledgerEntry.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
            user: { select: { email: true } }
        }
    });

    if (ledgerEntries.length === 0) {
        console.log('No ledger entries found.');
    } else {
        ledgerEntries.forEach(entry => {
            console.log(`Entry ID: ${entry.id} - Type: ${entry.type} - Status: ${entry.status}`);
            console.log(`  User: ${entry.user?.email || 'System'}`);
            console.log(`  Amount: ${entry.currency} ${Number(entry.debit) > 0 ? '-' + entry.debit : '+' + entry.credit}`);
            console.log(`  Hold Amount: ${entry.holdAmount}`);
            console.log(`  Reference: ${entry.reference}`);
            console.log(`  Desc: ${entry.description}`);
            console.log('  ...................................');
        });
    }

    console.log('\n--- Checking Deposit Review Queue ---');
    const depositQueue = await prisma.depositReviewQueue.findMany({
        where: { status: 'PENDING' },
        take: 5
    });
    console.log(depositQueue.length > 0 ? depositQueue : 'No pending deposits.');

    console.log('\n--- Checking Withdrawal Queue ---');
    const withdrawalQueue = await prisma.withdrawalQueue.findMany({
        take: 5,
        orderBy: { queuedAt: 'desc' },
        include: { user: { select: { email: true } } }
    });
    if (withdrawalQueue.length === 0) {
        console.log('No queued withdrawals.');
    } else {
        withdrawalQueue.forEach(wq => {
            console.log(`Queue ID: ${wq.id} - User: ${wq.user.email} - Amount: ${wq.amount} ${wq.currency} - Reason: ${wq.reason} - Position: ${wq.position}`);
        });
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
