/**
 * Check detailed sub-account balances
 * Shows available vs locked balances and withdrawal limits
 */

import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const prisma = new PrismaClient();

const QUIDAX_API_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

async function getWalletDetails(subAccountId: string, currency: string) {
  try {
    const response = await axios.get(
      `${QUIDAX_API_URL}/users/${subAccountId}/wallets/${currency.toLowerCase()}`,
      {
        headers: {
          Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        },
      }
    );
    return response.data?.data || null;
  } catch (error: any) {
    return { error: error.message };
  }
}

async function main() {
  console.log("\n=== Detailed Sub-account Balance Check ===\n");

  // Get users with non-zero balances in our system
  const usersWithBalances = [11, 7, 6, 22]; // Users that showed balances
  
  const users = await prisma.user.findMany({
    where: {
      id: { in: usersWithBalances },
      cryptoSubAccountId: { not: null },
    },
    select: {
      id: true,
      email: true,
      cryptoSubAccountId: true,
    },
  });

  const currencies = ["usdt", "usdc"];

  for (const user of users) {
    console.log(`\n--- User ${user.id} (${user.email}) ---`);
    console.log(`Sub-account: ${user.cryptoSubAccountId}`);
    
    for (const currency of currencies) {
      const wallet = await getWalletDetails(user.cryptoSubAccountId!, currency);
      
      if (wallet && !wallet.error) {
        console.log(`\n  ${currency.toUpperCase()}:`);
        console.log(`    Balance: ${wallet.balance}`);
        console.log(`    Locked: ${wallet.locked}`);
        console.log(`    Available: ${wallet.available_balance || wallet.balance}`);
        console.log(`    Deposit Address: ${wallet.deposit_address ? 'Yes' : 'No'}`);
        console.log(`    Withdrawal Enabled: ${wallet.withdrawal_enabled !== false}`);
        
        // Log full wallet object for debugging
        console.log(`    Full details:`, JSON.stringify(wallet, null, 2).split('\n').map(l => '      ' + l).join('\n'));
      } else {
        console.log(`  ${currency.toUpperCase()}: Error - ${wallet?.error || 'No data'}`);
      }
      
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
