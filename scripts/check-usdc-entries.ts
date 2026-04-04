import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
    // Check all USDC ledger entries
    const usdcEntries = await p.ledgerEntry.findMany({
        where: { currency: 'USDC' },
        select: { userId: true, currency: true, credit: true, balanceAfter: true },
        orderBy: { createdAt: 'desc' },
    });

    console.log("All USDC LedgerEntries:");
    for (const e of usdcEntries) {
        console.log(`  userId=${e.userId}: credit=${e.credit}, balanceAfter=${e.balanceAfter}`);
    }

    // Check all USDT ledger entries
    const usdtEntries = await p.ledgerEntry.findMany({
        where: { currency: 'USDT' },
        select: { userId: true, currency: true, credit: true, balanceAfter: true },
        orderBy: { createdAt: 'desc' },
    });

    console.log("\nAll USDT LedgerEntries:");
    for (const e of usdtEntries) {
        console.log(`  userId=${e.userId}: credit=${e.credit}, balanceAfter=${e.balanceAfter}`);
    }

    await p.$disconnect();
}

main();
