/**
 * Check for unswept crypto in user sub-accounts
 * 
 * Usage: npx ts-node -r dotenv/config scripts/check-unswept.ts
 */

import { PrismaClient } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET || process.env.QUIDAX_SECRET_KEY;

if (!QUIDAX_SECRET_KEY) {
    console.error("ERROR: QUIDAX_API_SECRET not found. Make sure .env is loaded.");
    process.exit(1);
}

const quidaxApi = axios.create({
    baseURL: QUIDAX_BASE_URL,
    headers: {
        Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        "Content-Type": "application/json",
    },
});

interface UnsweptBalance {
    userId: number;
    email: string;
    subAccountId: string;
    currency: string;
    balance: number;
    estimatedValueUSDT: number;
}

async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║         Check Unswept Balances in Sub-Accounts               ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Get all users with sub-accounts
    const users = await prisma.user.findMany({
        where: {
            cryptoSubAccountId: { not: null },
        },
        select: {
            id: true,
            email: true,
            cryptoSubAccountId: true,
        },
    });

    console.log(`Found ${users.length} users with sub-accounts\n`);

    const unsweptBalances: UnsweptBalance[] = [];
    let processedCount = 0;

    for (const user of users) {
        if (!user.cryptoSubAccountId) continue;

        processedCount++;
        if (processedCount % 50 === 0) {
            console.log(`  Processing user ${processedCount}/${users.length}...`);
        }

        try {
            const response = await quidaxApi.get(`/users/${user.cryptoSubAccountId}/wallets`);
            const wallets = response.data?.data || [];

            for (const wallet of wallets) {
                const availableBalance = parseFloat(wallet.balance || "0");
                // Only report balances above dust threshold
                if (availableBalance > 0.0000001) {
                    unsweptBalances.push({
                        userId: user.id,
                        email: user.email,
                        subAccountId: user.cryptoSubAccountId,
                        currency: wallet.currency.toUpperCase(),
                        balance: availableBalance,
                        estimatedValueUSDT: 0, // We'll skip USDT estimation for now
                    });
                }
            }
        } catch (error: any) {
            if (error.response?.status !== 404) {
                console.error(`  ❌ Error for user ${user.id}: ${error.message}`);
            }
        }

        // Rate limit - Quidax may have limits
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n${"═".repeat(60)}`);
    console.log("UNSWEPT BALANCES REPORT");
    console.log("═".repeat(60));

    if (unsweptBalances.length === 0) {
        console.log("\n✅ No unswept balances found! All sub-accounts are empty.\n");
    } else {
        // Group by currency
        const byCurrency = new Map<string, UnsweptBalance[]>();
        for (const b of unsweptBalances) {
            const existing = byCurrency.get(b.currency) || [];
            existing.push(b);
            byCurrency.set(b.currency, existing);
        }

        console.log(`\nFound ${unsweptBalances.length} unswept balances across ${byCurrency.size} currencies:\n`);

        for (const [currency, balances] of byCurrency) {
            const totalBalance = balances.reduce((sum, b) => sum + b.balance, 0);
            console.log(`\n${currency}:`);
            console.log(`  Total: ${totalBalance.toFixed(8)} ${currency}`);
            console.log(`  Accounts: ${balances.length}`);
            
            // Show top 5 largest balances
            const sorted = balances.sort((a, b) => b.balance - a.balance).slice(0, 5);
            for (const b of sorted) {
                console.log(`    - User ${b.userId} (${b.email}): ${b.balance.toFixed(8)}`);
            }
            if (balances.length > 5) {
                console.log(`    ... and ${balances.length - 5} more`);
            }
        }

        // Summary
        console.log(`\n${"─".repeat(60)}`);
        console.log("SUMMARY:");
        for (const [currency, balances] of byCurrency) {
            const total = balances.reduce((sum, b) => sum + b.balance, 0);
            console.log(`  ${currency}: ${total.toFixed(8)} across ${balances.length} accounts`);
        }
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
});
