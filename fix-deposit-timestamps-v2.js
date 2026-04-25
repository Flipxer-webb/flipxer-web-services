require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function fixTimestamps() {
    console.log("Fetching existing deposits...\n");

    // Get all RECEIVE orders
    const deposits = await prisma.order.findMany({
        where: {
            orderCategory: "RECEIVE",
        },
        orderBy: { createdAt: "asc" },
    });

    console.log(`Found ${deposits.length} RECEIVE orders:\n`);
    
    for (const deposit of deposits) {
        console.log(`ID: ${deposit.id}`);
        console.log(`  Provider ID: ${deposit.providerOrderId}`);
        console.log(`  Amount: ${deposit.amount} ${deposit.currency}`);
        console.log(`  Status: ${deposit.status}`);
        console.log(`  Current CreatedAt: ${deposit.createdAt.toISOString()}`);
        console.log(`  Current UpdatedAt: ${deposit.updatedAt.toISOString()}`);
        console.log('');
    }

    // If you have the actual timestamps from Quidax, uncomment and update:
    /*
    console.log("\nUpdating timestamps...\n");
    
    for (const correction of DEPOSIT_CORRECTIONS) {
        const result = await prisma.order.updateMany({
            where: { providerOrderId: correction.providerOrderId },
            data: {
                createdAt: new Date(correction.created_at),
                updatedAt: correction.done_at ? new Date(correction.done_at) : new Date(correction.created_at),
            },
        });
        
        if (result.count > 0) {
            console.log(`✓ Updated deposit ${correction.providerOrderId}`);
        } else {
            console.log(`⚠ Deposit ${correction.providerOrderId} not found`);
        }
    }
    */
    
    console.log("\nTo fix timestamps, you need to:");
    console.log("1. Get the actual created_at/done_at from Quidax API");
    console.log("2. Update DEPOSIT_CORRECTIONS array with correct providerOrderIds and timestamps");
    console.log("3. Uncomment the update section and run again");
}

fixTimestamps()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
