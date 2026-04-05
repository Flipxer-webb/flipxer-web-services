import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
    // Check ledger entries for user 7
    const entries = await p.ledgerEntry.findMany({
        where: { userId: 7 },
        select: { currency: true, credit: true, debit: true, balanceAfter: true },
        orderBy: { createdAt: 'desc' },
    });

    console.log("LedgerEntries for user 7:");
    for (const e of entries) {
        console.log(`  ${e.currency}: credit=${e.credit}, debit=${e.debit}, balanceAfter=${e.balanceAfter}`);
    }

    // Check asset wallets
    const wallets = await p.assetWallet.findMany({
        where: { userId: 7 },
        select: { assetCurrency: true, balance: true },
    });

    console.log("\nAssetWallets for user 7:");
    for (const w of wallets) {
        console.log(`  ${w.assetCurrency}: balance=${w.balance}`);
    }

    await p.$disconnect();
}

main();
