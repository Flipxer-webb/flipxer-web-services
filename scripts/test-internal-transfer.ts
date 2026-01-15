/**
 * Test internal transfer from sub-account to main
 * 
 * Usage: npx ts-node -r dotenv/config scripts/test-internal-transfer.ts
 */

import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://app.quidax.io/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;
const MAIN_ACCOUNT_ID = "2adc37bb-05e1-44cb-b32f-d4a2f958cbcf";

if (!QUIDAX_SECRET_KEY) {
    console.error("ERROR: QUIDAX_API_SECRET not found");
    process.exit(1);
}

const quidaxApi = axios.create({
    baseURL: QUIDAX_BASE_URL,
    headers: {
        Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        "Content-Type": "application/json",
    },
});

async function main() {
    const user7 = await prisma.user.findUnique({
        where: { id: 7 },
        select: { id: true, email: true, cryptoSubAccountId: true }
    });

    if (!user7?.cryptoSubAccountId) {
        console.error("User 7 has no sub-account");
        return;
    }

    console.log("\n📊 Testing sub-account to main transfer...\n");
    console.log(`Sub-account ID: ${user7.cryptoSubAccountId}`);
    console.log(`Main account ID: ${MAIN_ACCOUNT_ID}`);

    // Method 1: Try withdrawal with network specified
    console.log("\n\n=== Method 1: Withdrawal with network ===");
    const mainWalletAddress = "0xE9b29902DF46300FF6D9DC0428da48Da402A42f6";
    
    // First check if there are any fees
    console.log("\nChecking withdrawal requirements...");
    try {
        const feeResponse = await quidaxApi.get(`/users/${user7.cryptoSubAccountId}/wallets/usdt`);
        const balance = feeResponse.data?.data?.balance;
        console.log(`Current balance: ${balance} USDT`);
    } catch (error: any) {
        console.log("Error checking balance:", error.message);
    }
    
    // Try with a smaller amount to see if fees are the issue
    console.log("\nTrying with amount: 10 USDT (leaving 2 for fees)...");
    try {
        const response = await quidaxApi.post(`/users/${user7.cryptoSubAccountId}/withdraws`, {
            currency: "usdt",
            amount: "10",
            fund_uid: mainWalletAddress,
            network: "bep20",
            transaction_note: "Sweep to main wallet",
            narration: "Test sweep",
        });
        console.log("Success:", JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        console.log("Error:", error.response?.data?.message || error.message);
        
        // Try TRC20 which has lower fees
        console.log("\nTrying TRC20 network (lower fees)...");
        try {
            // Need TRC20 address - let's get it
            const trcWallet = await quidaxApi.get(`/users/me/wallets/usdt?network=trc20`);
            console.log("Main TRC20 address:", trcWallet.data?.data?.deposit_address);
        } catch (e: any) {
            console.log("Error getting TRC20 address:", e.message);
        }
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
});
