
import { PrismaClient, LedgerType, EntryStatus } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });
const prisma = new PrismaClient();

async function refundSwap(swapId: number) {
    const swap = await prisma.order.findUnique({
        where: { id: swapId },
        include: { user: true }
    });

    if (!swap) {
        console.error(`Swap ${swapId} not found`);
        return;
    }

    console.log(`Checking Swap ${swap.id} for user ${swap.user.email}`);

    // 1. Find the debit entry (SWAP_OUT or SELL)
    // The reference for the sell leg is usually just the orderReference
    const sellLeg = await prisma.ledgerEntry.findFirst({
        where: {
            reference: { contains: swap.orderReference || undefined },
            type: { in: [LedgerType.SWAP_OUT, LedgerType.SELL] },
            userId: swap.userId,
            debit: { gt: 0 }
        }
    });

    if (!sellLeg) {
        console.log("No debit ledger entry found for this swap. It might not have executed the first leg.");
        return;
    }

    console.log(`Found debit entry: ${sellLeg.id} - Amount: ${sellLeg.currency} ${sellLeg.debit}`);

    // 2. Check for existing refund
    const refundCheck = await prisma.ledgerEntry.findFirst({
        where: {
            reference: { contains: `${swap.orderReference}_refund` },
            userId: swap.userId
        }
    });

    if (refundCheck) {
        console.log(`Refund already exists: ${refundCheck.id}`);
        return;
    }

    // 3. Process Refund
    console.log("Processing refund...");

    // Calculate new balance
    // We need the user's current balance for that currency to update balanceAfter correctly
    // or rely on a helper if available, but here we do raw prisma
    const latestEntry = await prisma.ledgerEntry.findFirst({
        where: {
            userId: swap.userId,
            currency: sellLeg.currency
        },
        orderBy: { createdAt: 'desc' }
    });

    const currentBalance = latestEntry ? Number(latestEntry.balanceAfter) : 0;
    const refundAmount = Number(sellLeg.debit);
    const newBalance = currentBalance + refundAmount;

    await prisma.$transaction(async (tx) => {
        // Create Refund Entry
        await tx.ledgerEntry.create({
            data: {
                userId: swap.userId,
                currency: sellLeg.currency,
                type: LedgerType.REFUND,
                debit: 0,
                credit: refundAmount,
                balanceAfter: newBalance,
                status: EntryStatus.SETTLED,
                reference: `${swap.orderReference}_refund`,
                description: `Refund for failed swap #${swap.id}`,
                tradeGroupId: sellLeg.tradeGroupId
            }
        });

        // Update Order Note if possible (optional)
        await tx.order.update({
            where: { id: swap.id },
            data: {
                transaction_note: `${swap.transaction_note} | Refunded ${refundAmount} ${sellLeg.currency}`
            }
        });
    });

    console.log(`Successfully refunded ${refundAmount} ${sellLeg.currency} to user.`);
}

// Run for Swap #361
refundSwap(361)
    .catch(console.error)
    .finally(() => prisma.$disconnect());
