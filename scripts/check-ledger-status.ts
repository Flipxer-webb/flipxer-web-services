
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    console.log("=== Ledger Entry Summary ===");
    const totalEntries = await prisma.$queryRaw`SELECT COUNT(*) as count FROM "LedgerEntries"`;
    console.log("Total Ledger Entries:", totalEntries);

    console.log("\n=== Entries by Type ===");
    const byType = await prisma.$queryRaw`
    SELECT type, COUNT(*) as count, SUM(credit) as total_credits, SUM(debit) as total_debits
    FROM "LedgerEntries"
    GROUP BY type
    ORDER BY count DESC
  `;
    console.log(byType);

    console.log("\n=== Sweep Status Summary ===");
    const sweepStatus = await prisma.$queryRaw`
    SELECT "sweepStatus", COUNT(*) as count
    FROM "LedgerEntries"
    WHERE "sweepStatus" IS NOT NULL
    GROUP BY "sweepStatus"
  `;
    console.log(sweepStatus);

    await prisma.$disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
