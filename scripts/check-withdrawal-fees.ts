/**
 * Check Quidax withdrawal fees for USDT
 * 
 * Usage: npx ts-node -r dotenv/config scripts/check-withdrawal-fees.ts
 */

import axios from "axios";

const QUIDAX_BASE_URL = process.env.QUIDAX_BASE_URL || "https://app.quidax.io/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

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
    console.log("\n📊 Checking USDT withdrawal fees on Quidax...\n");

    // Check fees for USDT withdrawal
    const currencies = ["usdt", "btc", "eth"];
    
    for (const currency of currencies) {
        try {
            const response = await quidaxApi.get(`/users/me/wallets/${currency}/withdraw_fees`);
            console.log(`\n${currency.toUpperCase()} Withdrawal Fees:`);
            console.log(JSON.stringify(response.data, null, 2));
        } catch (error: any) {
            console.log(`\n${currency.toUpperCase()} Fees: Error - ${error.response?.data?.message || error.message}`);
        }
    }

    // Also check the main wallet balance
    console.log("\n\n📊 Main wallet USDT balance:");
    try {
        const response = await quidaxApi.get(`/users/me/wallets/usdt`);
        console.log(JSON.stringify(response.data?.data, null, 2));
    } catch (error: any) {
        console.log(`Error: ${error.response?.data?.message || error.message}`);
    }

    // Check sub-account balance for user 7
    console.log("\n\n📊 User 7 sub-account USDT details:");
    
    // First get user 7's sub-account ID from database
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    
    const user7 = await prisma.user.findUnique({
        where: { id: 7 },
        select: { id: true, email: true, cryptoSubAccountId: true }
    });
    
    if (user7?.cryptoSubAccountId) {
        console.log(`User 7 sub-account ID: ${user7.cryptoSubAccountId}`);
        
        try {
            const walletResponse = await quidaxApi.get(`/users/${user7.cryptoSubAccountId}/wallets/usdt`);
            console.log("\nUSDT Wallet:");
            console.log(JSON.stringify(walletResponse.data?.data, null, 2));
        } catch (error: any) {
            console.log(`Error: ${error.response?.data?.message || error.message}`);
        }
    } else {
        console.log("User 7 has no sub-account ID");
    }
    
    await prisma.$disconnect();
}

main().catch(console.error);
