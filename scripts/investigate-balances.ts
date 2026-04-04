/**
 * Investigate Balance Discrepancy - Corrected
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== Balance Investigation Report ===\n");

  // 1. LedgerEntries by Currency
  console.log("--- LedgerEntries by Currency ---");
  const ledgerByCurrency = await prisma.$queryRaw`
    SELECT 
      currency,
      COUNT(*) as entry_count,
      SUM(credit) as total_credits,
      SUM(debit) as total_debits,
      SUM(credit) - SUM(debit) as net_balance
    FROM "LedgerEntries"
    GROUP BY currency
    ORDER BY currency
  `;
  console.log(ledgerByCurrency);

  // 2. AssetWallets by Currency (corrected column names)
  console.log("\n--- AssetWallets by Currency ---");
  const walletsByCurrency = await prisma.$queryRaw`
    SELECT 
      "assetCurrency",
      COUNT(*) as wallet_count,
      SUM(balance) as total_balance,
      SUM(locked) as total_locked
    FROM "AssetWallets"
    GROUP BY "assetCurrency"
    ORDER BY "assetCurrency"
  `;
  console.log(walletsByCurrency);

  // 3. Distinct currencies comparison
  console.log("\n--- Currency Format Comparison ---");
  const ledgerCurrencies = await prisma.$queryRaw<{ currency: string }[]>`
    SELECT DISTINCT currency FROM "LedgerEntries" ORDER BY currency
  `;
  const walletCurrencies = await prisma.$queryRaw<{ assetCurrency: string }[]>`
    SELECT DISTINCT "assetCurrency" FROM "AssetWallets" ORDER BY "assetCurrency"
  `;

  console.log("LedgerEntries currencies:", ledgerCurrencies.map(r => r.currency));
  console.log("AssetWallets currencies:", walletCurrencies.map(r => r.assetCurrency));

  // 4. Check for case mismatches
  console.log("\n--- Case Mismatch Analysis ---");
  let mismatches = 0;
  for (const lc of ledgerCurrencies) {
    const matchingWallet = walletCurrencies.find(
      w => w.assetCurrency.toUpperCase() === lc.currency.toUpperCase()
    );
    if (matchingWallet && matchingWallet.assetCurrency !== lc.currency) {
      console.log(`⚠️  CASE MISMATCH: LedgerEntry="${lc.currency}" vs AssetWallet="${matchingWallet.assetCurrency}"`);
      mismatches++;
    }
  }
  if (mismatches === 0) {
    console.log("✅ No case mismatches found between LedgerEntries and AssetWallets");
  }

  // 5. Check currencies in Ledger but not in AssetWallets (or vice versa)
  console.log("\n--- Missing Currency Analysis ---");
  const ledgerSet = new Set(ledgerCurrencies.map(r => r.currency.toUpperCase()));
  const walletSet = new Set(walletCurrencies.map(r => r.assetCurrency.toUpperCase()));

  for (const lc of ledgerCurrencies) {
    if (!walletSet.has(lc.currency.toUpperCase())) {
      console.log(`❓ In LedgerEntries but NOT in AssetWallets: ${lc.currency}`);
    }
  }
  for (const wc of walletCurrencies) {
    if (!ledgerSet.has(wc.assetCurrency.toUpperCase())) {
      console.log(`❓ In AssetWallets but NOT in LedgerEntries: ${wc.assetCurrency}`);
    }
  }

  // 6. Sample user comparison
  console.log("\n--- Sample User Comparison (User ID 7 - magpiep18@gmail.com) ---");
  const userLedger = await prisma.$queryRaw`
    SELECT 
      currency,
      SUM(credit) - SUM(debit) as ledger_balance
    FROM "LedgerEntries"
    WHERE "userId" = 7
    GROUP BY currency
  `;
  console.log("Ledger balances:", userLedger);

  const userWallets = await prisma.$queryRaw`
    SELECT 
      "assetCurrency",
      balance,
      locked
    FROM "AssetWallets"
    WHERE "userId" = 7
  `;
  console.log("AssetWallet balances:", userWallets);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
});
