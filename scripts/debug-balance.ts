import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function deepDive() {
  // 1. Check ledger entries
  console.log("=== All Ledger Entries ===");
  const allEntries = await prisma.ledgerEntry.findMany();
  allEntries.forEach((e) => {
    console.log(
      "User:",
      e.userId,
      "| Currency:",
      e.currency,
      "| Credit:",
      e.credit.toString(),
      "| BalanceAfter:",
      e.balanceAfter.toString(),
      "| Status:",
      e.status
    );
  });

  // 2. Test case-sensitive query
  console.log("\n=== Testing case-sensitive queries for user 7 ===");
  const userId = 7;

  const lower = await prisma.ledgerEntry.findFirst({
    where: { userId, currency: "usdt" },
  });
  const upper = await prisma.ledgerEntry.findFirst({
    where: { userId, currency: "USDT" },
  });

  console.log("Query usdt:", lower ? lower.balanceAfter.toString() : "null");
  console.log("Query USDT:", upper ? upper.balanceAfter.toString() : "null");

  // 3. Check AssetWallet
  console.log("\n=== User 7 AssetWallets ===");
  const wallets = await prisma.assetWallet.findMany({ where: { userId } });
  wallets.forEach((w) => {
    console.log("Currency:", w.assetCurrency, "| Balance:", w.balance.toString());
  });

  // 4. Simulate getAllBalances
  console.log("\n=== Simulating getAllBalances for user 7 ===");
  const currencies = await prisma.ledgerEntry.findMany({
    where: { userId },
    select: { currency: true },
    distinct: ["currency"],
  });
  console.log("Distinct currencies found:", currencies.map(c => c.currency));

  for (const { currency } of currencies) {
    const lastEntry = await prisma.ledgerEntry.findFirst({
      where: {
        userId,
        currency,
        status: { not: "FAILED" },
      },
      orderBy: { createdAt: "desc" },
      select: { balanceAfter: true },
    });
    console.log(
      `getBalance(${userId}, ${currency}):`,
      lastEntry?.balanceAfter.toString() || "0"
    );
    console.log(`  Would store in map as: ${currency.toUpperCase()}`);
  }

  // 5. Check what asset currencies look like
  console.log("\n=== AssetWallet currency format ===");
  const allWallets = await prisma.assetWallet.findMany({
    where: { userId },
    select: { assetCurrency: true },
  });
  allWallets.forEach((w) => {
    console.log(`  assetCurrency: "${w.assetCurrency}" -> toUpperCase: "${w.assetCurrency.toUpperCase()}"`);
  });
}

deepDive()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
