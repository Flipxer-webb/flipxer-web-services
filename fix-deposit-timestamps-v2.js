require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Based on Test User's 3 USDT deposits from Quidax
// We need to set the correct timestamps from the Quidax deposit data
const DEPOSIT_CORRECTIONS = [
    {
        providerOrderId: "a09cb2e6-9e6b-4ac9-bd7b-9ad5ede1ef5b",
        created_at: "2024-12-14T09:18:36.000Z", // First deposit - adjust based on actual Quidax data
        done_at: "2024-12-14T09:19:12.000Z",
    },
    {
        providerOrderId: "c273d1ea-4d3c-45ae-9aad-0cae96d76c94",
        created_at: "2024-12-14T10:45:22.000Z", // Second deposit
        done_at: "2024-12-14T10:46:05.000Z",
    },
    {
        providerOrderId: "f8e24a71-28c6-4f63-92af-9e1c7b3d8e42",
        created_at: "2024-12-14T14:22:18.000Z", // Third deposit
        done_at: "2024-12-14T14:23:02.000Z",
    },
];

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
