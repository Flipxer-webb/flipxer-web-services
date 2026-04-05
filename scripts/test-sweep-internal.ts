/**
 * Test Internal Transfer via Withdraw API with fund_uid
 * 
 * This tests the approach used in sweep-subaccounts-to-main.ts
 * where fund_uid is set to the main account ID for internal transfer
 */

import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const QUIDAX_API_URL = process.env.QUIDAX_BASE_URL || "https://www.quidax.com/api/v1";
const QUIDAX_SECRET_KEY = process.env.QUIDAX_API_SECRET;

// Main account ID (the API key owner)
const MAIN_ACCOUNT_ID = "2adc37bb-05e1-44cb-b32f-d4a2f958cbcf";

// User 7's sub-account (has remaining 1 USDT after the 10 USDT sweep)
const SUB_ACCOUNT_ID = "beb9e402-68e3-4ec5-9ddd-6fb4c5a4e3b4";

async function checkBalance() {
  try {
    const response = await axios.get(
      `${QUIDAX_API_URL}/users/${SUB_ACCOUNT_ID}/wallets/usdt`,
      {
        headers: {
          Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
        },
      }
    );
    return response.data?.data?.balance || "0";
  } catch (error: any) {
    console.error("Failed to get balance:", error.response?.data || error.message);
    return "0";
  }
}

async function testInternalTransfer() {
  console.log("\n=== Testing Internal Transfer via Withdraw API ===\n");
  console.log("This uses fund_uid = main account ID for internal transfer");
  console.log("(should be FREE - no network fees)\n");

  if (!QUIDAX_SECRET_KEY) {
    console.error("❌ QUIDAX_SECRET_KEY not set");
    process.exit(1);
  }

  // Check current balance
  console.log("Step 1: Checking sub-account balance...");
  const balance = await checkBalance();
  console.log(`  Balance: ${balance} USDT\n`);

  const balanceNum = parseFloat(balance);
  if (balanceNum < 0.01) {
    console.log("❌ Not enough balance to test");
    process.exit(0);
  }

  // Try internal transfer using fund_uid
  console.log("Step 2: Testing internal transfer with fund_uid...");
  console.log(`  From: ${SUB_ACCOUNT_ID} (sub-account)`);
  console.log(`  To (fund_uid): ${MAIN_ACCOUNT_ID} (main account)`);
  console.log(`  Amount: ${balance} USDT\n`);

  try {
    const response = await axios.post(
      `${QUIDAX_API_URL}/users/${SUB_ACCOUNT_ID}/withdraws`,
      {
        currency: "usdt",
        amount: balance,
        fund_uid: MAIN_ACCOUNT_ID, // This should trigger internal transfer
        transaction_note: "Test internal transfer to main",
        narration: "Test sweep",
      },
      {
        headers: {
          Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Response:", JSON.stringify(response.data, null, 2));
    
    if (response.data?.status === "success") {
      console.log("\n🎉 Internal transfer successful!");
      console.log(`TX ID: ${response.data?.data?.id}`);
      console.log(`Status: ${response.data?.data?.state || response.data?.data?.status}`);
      console.log(`Fee: ${response.data?.data?.fee || "N/A"}`);
    }
  } catch (error: any) {
    console.log("❌ Failed:", error.response?.data || error.message);
    
    // Check if it's an address requirement error
    if (error.response?.data) {
      const errData = error.response.data;
      console.log("\n--- Full Error Response ---");
      console.log(JSON.stringify(errData, null, 2));
      
      // Try alternative: use "me" instead of the ID
      console.log("\n--- Trying alternative: fund_uid = 'me' ---");
      try {
        const altResponse = await axios.post(
          `${QUIDAX_API_URL}/users/${SUB_ACCOUNT_ID}/withdraws`,
          {
            currency: "usdt",
            amount: balance,
            fund_uid: "me", // "me" refers to the main account
            transaction_note: "Test internal transfer to main",
            narration: "Test sweep",
          },
          {
            headers: {
              Authorization: `Bearer ${QUIDAX_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log("✅ Alternative Response:", JSON.stringify(altResponse.data, null, 2));
      } catch (altError: any) {
        console.log("❌ Alternative also failed:", altError.response?.data || altError.message);
      }
    }
  }

  // Check balance after attempt
  console.log("\n--- Balance After Attempt ---");
  const newBalance = await checkBalance();
  console.log(`Balance: ${newBalance} USDT`);
}

testInternalTransfer().catch(console.error);
