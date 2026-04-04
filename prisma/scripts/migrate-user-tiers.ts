/**
 * Migration script to calculate and set tier for all existing users
 * 
 * Run with: npx ts-node prisma/scripts/migrate-user-tiers.ts
 * 
 * This script:
 * 1. Fetches all users from the database
 * 2. Calculates the appropriate tier based on their verification status
 * 3. Updates the tier field for each user
 */

import { PrismaClient, UserType } from "@prisma/client";

const prisma = new PrismaClient();

type TierLevel = 0 | 1 | 2 | 3;

interface UserWithTier {
    id: number;
    email: string;
    userType: UserType;
    isEmailVerified: boolean;
    isPhoneVerified: boolean;
    isBvnVerified: boolean;
    isDocumentVerified: boolean;
    isAddressVerified?: boolean;
    isBiometricVerified?: boolean;
    isIncomeVerified?: boolean;
    businessRecordCompleted: boolean;
    businessDocumentsUploaded: boolean;
    tier?: number;
}

function calculateTier(user: UserWithTier): TierLevel {
    // Business accounts get Tier 3 automatically when KYC is complete
    if (user.userType === UserType.BUSINESS) {
        if (user.businessRecordCompleted && user.businessDocumentsUploaded) {
            return 3;
        }
        return 0;
    }

    // Individual tier calculation
    // Tier 0: Email + SMS verified (newly onboarded)
    if (!user.isEmailVerified || !user.isPhoneVerified) {
        return 0;
    }

    // Tier 3: Biometric + Income verified
    if (
        user.isDocumentVerified &&
        user.isAddressVerified &&
        user.isBiometricVerified &&
        user.isIncomeVerified
    ) {
        return 3;
    }

    // Tier 2: Document + Address verified
    if (user.isDocumentVerified && user.isAddressVerified) {
        return 2;
    }

    // Tier 1: BVN verified + Document verified
    if (user.isBvnVerified && user.isDocumentVerified) {
        return 1;
    }

    // Tier 0: Only email/phone verified (onboarded but no KYC)
    return 0;
}

async function migrateUserTiers() {
    console.log("🚀 Starting user tier migration...\n");

    try {
        // Fetch all users with relevant fields
        const users = await prisma.$queryRaw<UserWithTier[]>`
            SELECT 
                id, 
                email, 
                "userType",
                "isEmailVerified",
                "isPhoneVerified",
                "isBvnVerified",
                "isDocumentVerified",
                "isAddressVerified",
                "isBiometricVerified",
                "isIncomeVerified",
                "businessRecordCompleted",
                "businessDocumentsUploaded",
                tier
            FROM "Users"
        `;

        console.log(`📊 Found ${users.length} users to process\n`);

        let updated = 0;
        let skipped = 0;
        const tierCounts: Record<TierLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

        for (const user of users) {
            const newTier = calculateTier(user);
            tierCounts[newTier]++;

            if (user.tier !== newTier) {
                await prisma.$executeRaw`
                    UPDATE "Users" 
                    SET tier = ${newTier} 
                    WHERE id = ${user.id}
                `;
                console.log(`  ✅ User ${user.id} (${user.email}): ${user.tier ?? 'null'} → ${newTier}`);
                updated++;
            } else {
                skipped++;
            }
        }

        console.log("\n📈 Migration Summary:");
        console.log(`  - Updated: ${updated} users`);
        console.log(`  - Skipped (already correct): ${skipped} users`);
        console.log("\n📊 Tier Distribution:");
        console.log(`  - Tier 0 (Unverified): ${tierCounts[0]} users`);
        console.log(`  - Tier 1 (Basic ID): ${tierCounts[1]} users`);
        console.log(`  - Tier 2 (Address): ${tierCounts[2]} users`);
        console.log(`  - Tier 3 (Full): ${tierCounts[3]} users`);
        console.log("\n✨ Migration completed successfully!");

    } catch (error) {
        console.error("❌ Migration failed:", error);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

// Run the migration
migrateUserTiers();
