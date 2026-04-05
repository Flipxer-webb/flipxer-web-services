/**
 * Test Quidax internal transfer (sub-account to main)
 * 
 * Usage: npx ts-node -r dotenv/config scripts/test-quidax-internal-transfer.ts
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

    // Check current balance
    console.log("\n📊 Checking current balance...\n");
    const walletRes = await quidaxApi.get(`/users/${user7.cryptoSubAccountId}/wallets/usdt`);
    const balance = walletRes.data?.data?.balance;
    console.log(`Current USDT balance: ${balance}`);

    if (parseFloat(balance) <= 0) {
        console.log("No balance to transfer");
        await prisma.$disconnect();
        return;
    }

    console.log("\n=== Testing Internal Transfer (Sub to Main) ===\n");
    console.log(`From: ${user7.cryptoSubAccountId} (sub-account)`);
    console.log(`To: ${MAIN_ACCOUNT_ID} (main account)`);
    console.log(`Amount: ${balance} USDT`);

    // Method 1: Try internal transfer FROM main account perspective
    // Using sender_id to specify the source sub-account
    console.log("\n--- Method 1: Main account initiates transfer FROM sub-account ---");
    try {
        const response = await quidaxApi.post(`/users/me/internal_transfers`, {
            sender_id: user7.cryptoSubAccountId,  // Source is sub-account
            recipient_id: MAIN_ACCOUNT_ID,         // Target is main account
            currency: "usdt",
            amount: balance,
            reason: "Sweep to omnibus wallet",
        });
        console.log("\n✅ SUCCESS with sender_id!");
        console.log(JSON.stringify(response.data, null, 2));
        await prisma.$disconnect();
        return;
    } catch (error: any) {
        console.log("❌ Method 1 failed:", error.response?.data?.message || error.message);
    }

    // Method 2: Try with just recipient (main to main, won't work but let's see error)
    console.log("\n--- Method 2: Standard internal transfer syntax ---");
    try {
        const response = await quidaxApi.post(`/users/me/internal_transfers`, {
            recipient_id: user7.cryptoSubAccountId,  // The other party
            currency: "usdt",
            amount: `-${balance}`,  // Negative to pull?
            reason: "Sweep to omnibus wallet",
        });
        console.log("\n✅ SUCCESS!");
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        console.log("❌ Method 2 failed:", error.response?.data?.message || error.message);
    }

    // Method 3: Check what the internal_transfers endpoint expects
    console.log("\n--- Method 3: List internal transfer options ---");
    try {
        const response = await quidaxApi.get(`/users/me/internal_transfers`);
        console.log("Past transfers:", JSON.stringify(response.data, null, 2));
    } catch (error: any) {
        console.log("❌ Get failed:", error.response?.data?.message || error.message);
    }

    await prisma.$disconnect();
}

main().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
});
