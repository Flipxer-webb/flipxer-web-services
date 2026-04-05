import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function fixCurrency() {
  // Get all entries with lowercase currency
  const entries = await prisma.ledgerEntry.findMany();

  console.log("Found", entries.length, "entries");
  console.log("Updating to uppercase currency...\n");

  let updated = 0;
  for (const entry of entries) {
    const upper = entry.currency.toUpperCase();
    if (entry.currency !== upper) {
      console.log("  Updating", entry.id.slice(0, 8), entry.currency, "->", upper);
      await prisma.ledgerEntry.update({
        where: { id: entry.id },
        data: { currency: upper },
      });
      updated++;
    }
  }

  console.log("\nUpdated", updated, "entries to uppercase!");

  // Verify
  console.log("\n=== Verification ===");
  const afterEntries = await prisma.ledgerEntry.findMany();
  afterEntries.forEach((e) => {
    console.log("User:", e.userId, "| Currency:", e.currency);
  });
}

fixCurrency()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
