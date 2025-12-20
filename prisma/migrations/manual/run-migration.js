/**
 * Safe Migration Script: Add Dojah Document Verification Fields
 * Run with: node prisma/migrations/manual/run-migration.js
 * 
 * This script adds new columns only - NO DATA LOSS
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
    log: ["query", "info", "warn", "error"],
});

async function runMigration() {
    console.log("🚀 Starting safe migration for Dojah document verification...\n");

    try {
        // Test connection
        console.log("1️⃣ Testing database connection...");
        await prisma.$queryRaw`SELECT 1 as test`;
        console.log("   ✅ Connected successfully\n");

        // Step 1: Add documentVerificationStatus to Users
        console.log("2️⃣ Adding documentVerificationStatus to Users table...");
        try {
            await prisma.$executeRaw`
                ALTER TABLE "Users" 
                ADD COLUMN IF NOT EXISTS "documentVerificationStatus" TEXT
            `;
            console.log("   ✅ Done\n");
        } catch (e) {
            console.log(`   ⚠️ Skipped (may already exist): ${e.message}\n`);
        }

        // Step 2: Add columns to UserDocuments
        console.log("3️⃣ Adding Dojah verification fields to UserDocuments...");
        
        const columns = [
            { name: "verificationStatus", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT NOT NULL DEFAULT 'PENDING'` },
            { name: "dojahVerified", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahVerified" BOOLEAN NOT NULL DEFAULT false` },
            { name: "dojahDocumentType", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahDocumentType" TEXT` },
            { name: "dojahCountryCode", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahCountryCode" TEXT` },
            { name: "dojahExtractedFirstName", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahExtractedFirstName" TEXT` },
            { name: "dojahExtractedLastName", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahExtractedLastName" TEXT` },
            { name: "dojahExtractedDob", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahExtractedDob" TEXT` },
            { name: "dojahExtractedDocNumber", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahExtractedDocNumber" TEXT` },
            { name: "dojahNameMatches", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahNameMatches" BOOLEAN` },
            { name: "dojahVerifiedAt", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahVerifiedAt" TIMESTAMP(3)` },
            { name: "dojahRawResponse", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahRawResponse" TEXT` },
            { name: "createdAt", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` },
            { name: "updatedAt", sql: `ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` },
        ];

        for (const col of columns) {
            try {
                await prisma.$executeRawUnsafe(col.sql);
                console.log(`   ✅ ${col.name}`);
            } catch (e) {
                console.log(`   ⚠️ ${col.name} skipped: ${e.message}`);
            }
        }
        console.log("");

        // Step 3: Backfill existing verified documents
        console.log("4️⃣ Backfilling existing verified documents...");
        
        // Update UserDocuments for verified users
        const docResult = await prisma.$executeRaw`
            UPDATE "UserDocuments" ud
            SET "verificationStatus" = 'VERIFIED',
                "dojahVerified" = false,
                "updatedAt" = CURRENT_TIMESTAMP
            FROM "Users" u
            WHERE ud."userId" = u.id 
              AND u."isDocumentVerified" = true
              AND ud."verificationStatus" = 'PENDING'
        `;
        console.log(`   ✅ Updated ${docResult} UserDocument records\n`);

        // Update Users
        const userResult = await prisma.$executeRaw`
            UPDATE "Users"
            SET "documentVerificationStatus" = 'VERIFIED'
            WHERE "isDocumentVerified" = true
              AND "documentVerificationStatus" IS NULL
        `;
        console.log(`   ✅ Updated ${userResult} User records\n`);

        // Verify
        console.log("5️⃣ Verification...");
        const stats = await prisma.$queryRaw`
            SELECT 
                (SELECT COUNT(*) FROM "UserDocuments") as total_docs,
                (SELECT COUNT(*) FROM "UserDocuments" WHERE "verificationStatus" = 'VERIFIED') as verified_docs,
                (SELECT COUNT(*) FROM "UserDocuments" WHERE "verificationStatus" = 'PENDING') as pending_docs,
                (SELECT COUNT(*) FROM "Users" WHERE "isDocumentVerified" = true) as verified_users
        `;
        console.log("   📊 Stats:", stats[0]);

        console.log("\n✅ Migration completed successfully! No data was lost.");

    } catch (error) {
        console.error("\n❌ Migration failed:", error.message);
        throw error;
    } finally {
        await prisma.$disconnect();
    }
}

runMigration()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
