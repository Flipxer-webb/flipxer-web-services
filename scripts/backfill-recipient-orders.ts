
import { PrismaClient, OrderCategory, OrderStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting backfill for internal transfer recipients...');

    // 1. Find all SEND orders that are likely internal transfers
    // Logic: OrderCategory.SEND and recipient (email) matches a user in our system
    const sendOrders = await prisma.order.findMany({
        where: {
            orderCategory: OrderCategory.SEND,
            recipient: { not: null },
            status: OrderStatus.completed, // Only completed transfers
        },
        include: {
            user: true, // Sender
        }
    });

    console.log(`Found ${sendOrders.length} completed SEND orders. Analyzing for internal transfers...`);

    let createdCount = 0;
    let skippedCount = 0;

    for (const order of sendOrders) {
        if (!order.recipient) continue;

        // Check if recipient is an internal user
        const recipientUser = await prisma.user.findFirst({
            where: { email: { equals: order.recipient, mode: 'insensitive' } }
        });

        if (!recipientUser) {
            // Recipient is not a user (External transfer)
            continue;
        }

        if (recipientUser.id === order.userId) {
            // Sending to self? Valid, but ensure history logic holds.
        }

        // It's an internal transfer. Check if RECEIVE record exists.
        // We look for an order with:
        // - userId = recipientUser.id
        // - orderCategory = RECEIVE
        // - transactionId based on original or linked

        // Strategy: We didn't have a strict linking ID before. 
        // We can check if a RECEIVE order exists with similar details (amount, currency, sender=order.user.email)
        // created around the same time?
        // OR search by our new specific transactionId format if it happens to exist (unlikely for old ones).
        // Best bet for uniqueness: Unique transactionId we generate now.

        // Let's generate the expected transaction ID for the backfill: `${order.transactionId}-2`
        // But for old ones, we might just want to ensure ANY receive record exists.

        const existingReceiveOrder = await prisma.order.findFirst({
            where: {
                userId: recipientUser.id,
                orderCategory: OrderCategory.RECEIVE,
                currency: order.currency,
                amount: order.amount,
                sender: order.user?.email,
                // Optional: Check createdAt window if needed, but uniqueness is better.
                // If we use the transactionId logic:
            }
        });

        if (existingReceiveOrder) {
            // Already exists (maybe from manual fix or coincidental)
            skippedCount++;
            continue;
        }

        console.log(`Creating missing RECEIVE record for TxID ${order.transactionId} -> Recipient ${recipientUser.email}`);

        // Create the missing order
        const baseTxId = order.transactionId || `TX-${order.orderReference}`;

        await prisma.order.create({
            data: {
                orderCategory: OrderCategory.RECEIVE,
                status: OrderStatus.completed,
                streamlinedStatus: "completed",
                // Generate a unique reference based on original
                orderReference: `RCV-${order.orderReference || order.id}`,
                transactionId: `${baseTxId}-2`, // Consistent with new logic
                userId: recipientUser.id,
                currency: order.currency || 'USD', // Fallback if null, though shouldn't be
                narration: order.narration,
                transaction_note: order.transaction_note,
                sender: order.user?.email || 'Unknown',
                amount: order.amount,
                amountInFiat: order.amountInFiat,
                rateAtConversion: order.rateAtConversion,
                // We don't link ledgerEntryId as we don't know the credit entry easily without deep search
                fulfilled: true,
                createdAt: order.createdAt, // Backdate it to original time? Yes, for history accuracy.
                updatedAt: order.updatedAt,
            }
        });

        createdCount++;
    }

    console.log(`Migration Complete.`);
    console.log(`Created: ${createdCount}`);
    console.log(`Skipped (Already Existed): ${skippedCount}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
