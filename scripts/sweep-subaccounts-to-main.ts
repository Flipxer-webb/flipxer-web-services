/**
 * Sweep Sub-accounts to Main Wallet
 * 
 * This script transfers real crypto from user sub-accounts to the main omnibus wallet.
 * After this, users will have virtual balances (tracked in ledger) but the actual
 * crypto will be held centrally in the main wallet.
 * 
 * Usage:
 *   # Dry run - see what would be swept
 *   npx ts-node scripts/sweep-subaccounts-to-main.ts --dry-run
 * 
 *   # Execute sweep
 *   npx ts-node scripts/sweep-subaccounts-to-main.ts
 */

import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const prisma = new PrismaClient();

// Quidax API configuration
const QUIDAX_API_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

// Minimum amounts to sweep (set very low since internal transfers are free)
const MIN_SWEEP_AMOUNTS: Record<string, number> = {
  btc: 0.00000001,
  eth: 0.00000001,
  usdt: 0.00001,
  usdc: 0.00001,
  trx: 0.001,
  sol: 0.00001,
  xrp: 0.001,
  bnb: 0.00001,
};

interface SweepResult {
  userId: number;
  subAccountId: string;
  currency: string;
  amount: string;
  success: boolean;
  txId?: string;
  error?: string;
}

async function getSubAccountBalance(subAccountId: string, currency: string): Promise<string> {
  try {
    const response = await axios.get(
      `${QUIDAX_API_URL}/users/${subAccountId}/wallets/${currency.toLowerCase()}`,
      {
        headers: {
          Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        },
      }
    );
    return response.data?.data?.balance || "0";
  } catch (error: any) {
    console.error(`Failed to get balance for ${subAccountId}/${currency}:`, error.message);
    return "0";
  }
}

// Main account ID on Quidax (the API key owner)
const MAIN_ACCOUNT_ID = "2adc37bb-05e1-44cb-b32f-d4a2f958cbcf";

async function internalTransferToMain(
  subAccountId: string,
  currency: string,
  amount: string
): Promise<{ success: boolean; txId?: string; error?: string }> {
  try {
    // Use Quidax internal transfer - NOT an on-chain withdrawal
    // From sub-account to main account - this is FREE (no network fees)
    const response = await axios.post(
      `${QUIDAX_API_URL}/users/${subAccountId}/withdraws`,
      {
        currency: currency.toLowerCase(),
        amount: amount,
        fund_uid: MAIN_ACCOUNT_ID, // Main account ID for internal transfer
        transaction_note: "Sweep to main wallet - virtual balance migration",
        narration: "Platform sweep to omnibus",
      },
      {
        headers: {
          Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data?.status === "success") {
      return { success: true, txId: response.data?.data?.id };
    } else {
      return { success: false, error: response.data?.message || "Unknown error" };
    }
  } catch (error: any) {
    const errorMsg = error.response?.data?.message || error.message;
    const errorDetails = error.response?.data ? JSON.stringify(error.response.data) : "";
    return { 
      success: false, 
      error: `${errorMsg} ${errorDetails}`.trim()
    };
  }
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║       Sweep Sub-accounts to Main Wallet                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (isDryRun) {
    console.log("🔸 DRY RUN MODE - No actual transfers will be made\n");
  }

  if (!QUIDAX_SECRET_KEY) {
    console.error("❌ QUIDAX_SECRET_KEY not set in environment");
    process.exit(1);
  }

  // Get all users with sub-accounts
  const users = await prisma.user.findMany({
    where: {
      isDeleted: false,
      cryptoSubAccountId: { not: null },
    },
    select: {
      id: true,
      email: true,
      cryptoSubAccountId: true,
    },
  });

  console.log(`Found ${users.length} users with sub-accounts\n`);

  // Currencies to sweep
  const currencies = ["btc", "eth", "usdt", "usdc", "trx", "sol", "xrp", "bnb"];

  // We don't need main wallet addresses for internal transfers
  // Internal transfers use "me" as the destination which refers to main account

  console.log("--- Starting sweep (using internal transfers to main account) ---\n");

  const results: SweepResult[] = [];
  let totalSwept = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const user of users) {
    if (!user.cryptoSubAccountId) continue;

    console.log(`\nUser ${user.id} (${user.email}):`);
    console.log(`  Sub-account: ${user.cryptoSubAccountId}`);

    for (const currency of currencies) {
      // Get sub-account balance
      const balance = await getSubAccountBalance(user.cryptoSubAccountId, currency);
      const balanceNum = parseFloat(balance);
      const minAmount = MIN_SWEEP_AMOUNTS[currency] || 0.001;

      if (balanceNum < minAmount) {
        if (balanceNum > 0) {
          console.log(`    ${currency.toUpperCase()}: ${balance} (below minimum ${minAmount}, skipping)`);
          totalSkipped++;
        }
        continue;
      }

      console.log(`    ${currency.toUpperCase()}: ${balance} → internal transfer to main...`);

      if (isDryRun) {
        results.push({
          userId: user.id,
          subAccountId: user.cryptoSubAccountId,
          currency,
          amount: balance,
          success: true,
          txId: "DRY_RUN",
        });
        totalSwept++;
        continue;
      }

      // Execute the internal transfer (FREE - no network fees)
      const result = await internalTransferToMain(
        user.cryptoSubAccountId,
        currency,
        balance
      );

      results.push({
        userId: user.id,
        subAccountId: user.cryptoSubAccountId,
        currency,
        amount: balance,
        ...result,
      });

      if (result.success) {
        console.log(`      ✅ Success! TX: ${result.txId}`);
        totalSwept++;
      } else {
        console.log(`      ❌ Failed: ${result.error}`);
        totalFailed++;
      }

      // Rate limiting - wait 500ms between API calls
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Summary
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                       Summary                            ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log(`Total users processed: ${users.length}`);
  console.log(`Sweeps executed: ${totalSwept}`);
  console.log(`Skipped (below minimum): ${totalSkipped}`);
  console.log(`Failed: ${totalFailed}`);

  if (results.length > 0) {
    console.log("\n--- Sweep Details ---");
    console.table(results.map(r => ({
      userId: r.userId,
      currency: r.currency.toUpperCase(),
      amount: r.amount,
      success: r.success ? "✅" : "❌",
      txId: r.txId || r.error || "",
    })));
  }

  if (isDryRun) {
    console.log("\n⚠️  This was a DRY RUN. Run without --dry-run to execute sweeps.");
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
