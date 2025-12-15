require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// User ID for test user
const USER_ID = 6;

async function deleteDepositsForResync() {
    console.log(`Deleting RECEIVE orders for user ${USER_ID} to allow re-sync with correct timestamps...\n`);

    // Get existing deposits first
    const deposits = await prisma.order.findMany({
        where: {
            userId: USER_ID,
            orderCategory: "RECEIVE",
        },
    });

    console.log(`Found ${deposits.length} RECEIVE orders to delete:`);
    for (const d of deposits) {
        console.log(`  - ${d.id}: ${d.amount} ${d.currency} (${d.providerOrderId})`);
    }

    if (deposits.length === 0) {
        console.log("\nNo deposits to delete.");
        return;
    }

    // Ask for confirmation via command line arg
    if (!process.argv.includes('--confirm')) {
        console.log("\nTo confirm deletion, run with --confirm flag:");
        console.log("  node delete-deposits-for-resync.js --confirm");
        return;
    }

    // Delete the deposits
    const result = await prisma.order.deleteMany({
        where: {
            userId: USER_ID,
            orderCategory: "RECEIVE",
        },
    });

    console.log(`\n✓ Deleted ${result.count} RECEIVE orders.`);
    console.log("\nNow you need to:");
    console.log("1. Deploy the code with the timestamp fix to production");
    console.log("2. Run: node test-sync-deposits.js");
    console.log("   This will re-sync the deposits with correct timestamps from Quidax");
}

deleteDepositsForResync()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
