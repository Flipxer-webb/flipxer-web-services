/**
 * Script to update tiers for all existing users based on their verification status
 * 
 * Tier Requirements:
 * - Tier 0: Basic (no transactions allowed)
 * - Tier 1: BVN verified + Document verified ($10K limit)
 * - Tier 2: Document verified + Address verified ($50K limit)
 * - Tier 3: Document verified + Address verified + Income verified (unlimited)
 * 
 * Business accounts: Tier 3 when businessRecordCompleted + businessDocumentsUploaded
 * 
 * Run with: node update-user-tiers.js
 */

const { PrismaClient, UserType } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL + "?sslmode=require",
    },
  },
});

function calculateIndividualTier(user) {
  // Must have email and phone verified first
  if (!user.isEmailVerified || !user.isPhoneVerified) {
    return 0;
  }

  // Tier 3: Document + Address + Income verified
  if (user.isDocumentVerified && user.isAddressVerified && user.isIncomeVerified) {
    return 3;
  }

  // Tier 2: Document + Address verified
  if (user.isDocumentVerified && user.isAddressVerified) {
    return 2;
  }

  // Tier 1: BVN + Document verified
  if (user.isBvnVerified && user.isDocumentVerified) {
    return 1;
  }

  return 0;
}

function calculateBusinessTier(user) {
  if (user.businessRecordCompleted && user.businessDocumentsUploaded) {
    return 3;
  }
  return 0;
}

function calculateTier(user) {
  if (user.userType === UserType.BUSINESS) {
    return calculateBusinessTier(user);
  }
  return calculateIndividualTier(user);
}

async function updateAllUserTiers() {
  console.log("Fetching all users...");
  
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      userType: true,
      tier: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      isBvnVerified: true,
      isDocumentVerified: true,
      isAddressVerified: true,
      isIncomeVerified: true,
      businessRecordCompleted: true,
      businessDocumentsUploaded: true,
    },
  });

  console.log(`Found ${users.length} users to process\n`);

  let updated = 0;
  let unchanged = 0;
  let errors = 0;

  const tierChanges = {
    "0 -> 1": [],
    "0 -> 2": [],
    "0 -> 3": [],
    "1 -> 2": [],
    "1 -> 3": [],
    "2 -> 3": [],
  };

  for (const user of users) {
    try {
      const currentTier = user.tier ?? 0;
      const newTier = calculateTier(user);

      if (currentTier !== newTier) {
        const changeKey = `${currentTier} -> ${newTier}`;
        if (tierChanges[changeKey]) {
          tierChanges[changeKey].push(user.email);
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { tier: newTier },
        });

        console.log(`✅ Updated ${user.email}: Tier ${currentTier} -> ${newTier}`);
        updated++;
      } else {
        unchanged++;
      }
    } catch (error) {
      console.error(`❌ Error updating user ${user.id} (${user.email}):`, error.message);
      errors++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total users processed: ${users.length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Errors: ${errors}`);

  console.log("\nTier Changes:");
  for (const [change, emails] of Object.entries(tierChanges)) {
    if (emails.length > 0) {
      console.log(`  ${change}: ${emails.length} users`);
      emails.forEach((email) => console.log(`    - ${email}`));
    }
  }
}

// Dry run mode - show what would change without actually updating
async function dryRun() {
  console.log("=".repeat(60));
  console.log("DRY RUN - No changes will be made");
  console.log("=".repeat(60) + "\n");

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      userType: true,
      tier: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      isBvnVerified: true,
      isDocumentVerified: true,
      isAddressVerified: true,
      isIncomeVerified: true,
      businessRecordCompleted: true,
      businessDocumentsUploaded: true,
    },
  });

  console.log(`Found ${users.length} users\n`);

  const wouldUpdate = [];
  
  for (const user of users) {
    const currentTier = user.tier ?? 0;
    const newTier = calculateTier(user);

    if (currentTier !== newTier) {
      wouldUpdate.push({
        email: user.email,
        currentTier,
        newTier,
        verifications: {
          email: user.isEmailVerified,
          phone: user.isPhoneVerified,
          bvn: user.isBvnVerified,
          document: user.isDocumentVerified,
          address: user.isAddressVerified,
          income: user.isIncomeVerified,
        },
      });
    }
  }

  if (wouldUpdate.length === 0) {
    console.log("✅ All users have correct tiers. No updates needed.");
  } else {
    console.log(`Found ${wouldUpdate.length} users that need tier updates:\n`);
    for (const user of wouldUpdate) {
      console.log(`${user.email}:`);
      console.log(`  Current: Tier ${user.currentTier} -> Would update to: Tier ${user.newTier}`);
      console.log(`  Verifications: BVN=${user.verifications.bvn}, Doc=${user.verifications.document}, Addr=${user.verifications.address}`);
      console.log();
    }
  }

  console.log("\nTo apply these changes, run: node update-user-tiers.js --apply");
}

async function main() {
  const args = process.argv.slice(2);
  const shouldApply = args.includes("--apply");

  try {
    if (shouldApply) {
      await updateAllUserTiers();
    } else {
      await dryRun();
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
