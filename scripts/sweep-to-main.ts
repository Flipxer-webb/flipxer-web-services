/**
 * Sweep Sub-Account Balances to Main Wallet
 * 
 * This script transfers all crypto from user sub-accounts to the main 
 * platform wallet using Quidax internal transfer.
 * 
 * Usage:
 *   npx ts-node scripts/sweep-to-main.ts --dry-run    # Preview only
 *   npx ts-node scripts/sweep-to-main.ts              # Execute sweep
 */

import { PrismaClient } from "@prisma/client";
import axios from "axios";

const prisma = new PrismaClient();

// Parse args
const isDryRun = process.argv.includes("--dry-run");

// Quidax API config
const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET || process.env.QUIDAX_SECRET_KEY;

if (!QUIDAX_SECRET_KEY) {
    console.error("ERROR: QUIDAX_API_SECRET environment variable is required");
    process.exit(1);
}

const quidaxApi = axios.create({
    baseURL: QUIDAX_BASE_URL,
    headers: {
        Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        "Content-Type": "application/json",
    },
});

interface SubAccountBalance {
    userId: number;
    email: string;
    subAccountId: string;
    currency: string;
    balance: number;
}

async function getSubAccountBalances(): Promise<SubAccountBalance[]> {
    console.log("\n📊 Fetching sub-account balances...\n");

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

    console.log(`Found ${users.length} users with sub-accounts`);

    const balances: SubAccountBalance[] = [];

    for (const user of users) {
        if (!user.cryptoSubAccountId) continue;

        try {
            // Get all wallets for this sub-account
            const response = await quidaxApi.get(`/users/${user.cryptoSubAccountId}/wallets`);
            const wallets = response.data?.data || [];

            for (const wallet of wallets) {
                const availableBalance = parseFloat(wallet.balance || "0");
                if (availableBalance > 0) {
                    balances.push({
                        userId: user.id,
                        email: user.email,
                        subAccountId: user.cryptoSubAccountId,
                        currency: wallet.currency.toUpperCase(),
                        balance: availableBalance,
                    });
                }
            }
        } catch (error: any) {
            console.error(`  ❌ Error fetching wallets for user ${user.id}: ${error.message}`);
        }
    }

    return balances;
}

async function executeInternalTransfer(
    fromSubAccountId: string,
    currency: string,
    amount: number
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    try {
        // Use Quidax internal transfer API
        const response = await quidaxApi.post("/users/me/internal_transfers", {
            recipient_id: fromSubAccountId,  // Actually we want TO main, so we reverse
            currency: currency.toLowerCase(),
            amount: amount.toString(),
            reason: "Sweep to main wallet for omnibus model",
        });

        // Wait - internal_transfer is FROM main TO sub. We need sub TO main.
        // For sub-to-main, we use withdrawal to main wallet address

        return { success: false, error: "Internal transfer direction issue - see comment" };
    } catch (error: any) {
        return { success: false, error: error.response?.data?.message || error.message };
    }
}

async function getMainWalletAddress(currency: string): Promise<string | null> {
    try {
        const response = await quidaxApi.get(`/users/me/wallets/${currency.toLowerCase()}`);
        return response.data?.data?.deposit_address || null;
    } catch (error: any) {
        console.error(`  ❌ Error getting main wallet address for ${currency}: ${error.message}`);
        return null;
    }
}

async function createWithdrawal(
    subAccountId: string,
    currency: string,
    amount: number,
    toAddress: string
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    try {
        const response = await quidaxApi.post(`/users/${subAccountId}/withdraws`, {
            currency: currency.toLowerCase(),
            amount: amount.toString(),
            fund_uid: toAddress,
            transaction_note: "Sweep to main wallet",
            narration: `Omnibus sweep ${Date.now()}`,
        });

        return {
            success: true,
            transactionId: response.data?.data?.id
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.response?.data?.message || error.message
        };
    }
}

async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║          Sweep Sub-Accounts to Main Wallet               ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    if (isDryRun) {
        console.log("🔸 DRY RUN MODE - No actual transfers will be made\n");
    }

    // Step 1: Get all sub-account balances
    const balances = await getSubAccountBalances();

    if (balances.length === 0) {
        console.log("\n✅ No balances to sweep - all sub-accounts are empty");
        await prisma.$disconnect();
        return;
    }

    console.log("\n📋 Balances to sweep:");
    console.log("─".repeat(60));
    for (const b of balances) {
        console.log(`  User ${b.userId} (${b.email}): ${b.balance} ${b.currency}`);
    }
    console.log("─".repeat(60));
    console.log(`  Total: ${balances.length} balances across ${new Set(balances.map(b => b.currency)).size} currencies\n`);

    if (isDryRun) {
        console.log("🔸 Dry run complete. Run without --dry-run to execute sweeps.\n");
        await prisma.$disconnect();
        return;
    }

    // Step 2: Execute sweeps
    let success = 0;
    let failed = 0;

    for (const balance of balances) {
        console.log(`\n🔄 Sweeping ${balance.balance} ${balance.currency} from user ${balance.userId}...`);

        // Get main wallet address
        const mainAddress = await getMainWalletAddress(balance.currency);
        if (!mainAddress) {
            console.log(`  ❌ Could not get main wallet address for ${balance.currency}`);
            failed++;
            continue;
        }

        // Create withdrawal from sub-account to main wallet
        const result = await createWithdrawal(
            balance.subAccountId,
            balance.currency,
            balance.balance,
            mainAddress
        );

        if (result.success) {
            console.log(`  ✅ Sweep initiated | txId: ${result.transactionId}`);
            success++;
        } else {
            console.log(`  ❌ Sweep failed: ${result.error}`);
            failed++;
        }

        // Small delay between requests
        await new Promise(r => setTimeout(r, 500));
    }

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║                    Sweep Complete                         ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
    console.log(`   ✅ Successful: ${success}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log(`   📊 Total: ${balances.length}\n`);

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error("Fatal error:", e);
    await prisma.$disconnect();
    process.exit(1);
});
