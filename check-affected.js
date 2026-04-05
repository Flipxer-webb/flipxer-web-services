const { PrismaClient } = require("@prisma/client");

async function checkAffected() {
  const prisma = new PrismaClient();
  
  try {
    // Check tables affected by the duplicate migrations
    
    // 1. drop_biometric_credentials - affects UserBiometricCredentials table
    console.log("=== 20251222000001_drop_biometric_credentials ===\n");
    try {
      const biometric = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) as total FROM \"UserBiometricCredentials\""
      );
      console.log("UserBiometricCredentials table exists with " + biometric[0].total + " records");
    } catch (e) {
      console.log("UserBiometricCredentials table: " + (e.message.includes("does not exist") ? "Table was dropped (expected)" : e.message.substring(0, 60)));
    }
    
    // 2. virtual_balance_ledger_system - affects LedgerEntries, WithdrawalQueues
    console.log("\n=== 20260112172309_virtual_balance_ledger_system ===\n");
    
    try {
      const ledger = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) as total FROM \"LedgerEntries\""
      );
      console.log("LedgerEntries: " + ledger[0].total + " records");
    } catch (e) {
      console.log("LedgerEntries: " + e.message.substring(0, 60));
    }
    
    try {
      const queue = await prisma.$queryRawUnsafe(
        "SELECT COUNT(*) as total FROM \"WithdrawalQueues\""
      );
      console.log("WithdrawalQueues: " + queue[0].total + " records");
    } catch (e) {
      console.log("WithdrawalQueues: " + e.message.substring(0, 60));
    }
    
    // Check other key tables
    console.log("\n=== Other key tables ===\n");
    
    const tables = ["Users", "Orders", "AssetWallets", "BankDetails", "Sessions"];
    for (const table of tables) {
      try {
        const result = await prisma.$queryRawUnsafe(
          "SELECT COUNT(*) as total FROM \"" + table + "\""
        );
        console.log(table + ": " + result[0].total + " records");
      } catch (e) {
        console.log(table + ": Error - " + e.message.substring(0, 40));
      }
    }
    
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkAffected();
