/**
 * Ledger Migration Script
 * 
 * Migrates existing AssetWallet balances to the new LedgerEntry system.
 * 
 * Features:
 * - Atomic per-user transactions
 * - Resume capability via MigrationRun tracking
 * - Dry-run mode for testing
 * - Progress reporting
 * - Verification step
 * 
 * Usage:
 *   # Dry run (no changes)
 *   npx ts-node scripts/migrate-to-ledger.ts --dry-run
 * 
 *   # Full migration
 *   npx ts-node scripts/migrate-to-ledger.ts
 * 
 *   # Resume from last checkpoint
 *   npx ts-node scripts/migrate-to-ledger.ts --resume
 * 
 *   # Verify migration
 *   npx ts-node scripts/migrate-to-ledger.ts --verify-only
 */

import { PrismaClient, LedgerType, EntryStatus, MigrationStatus, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const prisma = new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
        db: {
            url: process.env.DATABASE_URL,
        },
    },
});
const MIGRATION_NAME = "ledger_initial_migration_v1";
const BATCH_SIZE = 50; // Smaller batch size for cloud DB

interface MigrationOptions {
    dryRun: boolean;
    resume: boolean;
    verifyOnly: boolean;
}

interface MigrationStats {
    totalUsers: number;
    processedUsers: number;
    skippedUsers: number;
    totalEntries: number;
    errors: string[];
    startTime: Date;
}

/**
 * Parse command line arguments
 */
function parseArgs(): MigrationOptions {
    const args = process.argv.slice(2);
    return {
        dryRun: args.includes("--dry-run"),
        resume: args.includes("--resume"),
        verifyOnly: args.includes("--verify-only"),
    };
}

/**
 * Get or create migration run record
 */
async function getMigrationRun(resume: boolean): Promise<{
    id: string;
    lastUserId: number;
    isNew: boolean;
}> {
    const existing = await prisma.migrationRun.findFirst({
        where: {
            name: MIGRATION_NAME,
            status: { in: [MigrationStatus.RUNNING, MigrationStatus.PAUSED] },
        },
        orderBy: { startedAt: "desc" },
    });

    if (existing && resume) {
        console.log(`📋 Resuming migration from user ID ${existing.lastUserId}`);
        return {
            id: existing.id,
            lastUserId: existing.lastUserId,
            isNew: false,
        };
    }

    if (existing && !resume) {
        console.log(`⚠️ Found existing migration in progress. Use --resume to continue.`);
        process.exit(1);
    }

    // Check if already completed
    const completed = await prisma.migrationRun.findFirst({
        where: {
            name: MIGRATION_NAME,
            status: MigrationStatus.COMPLETED,
        },
    });

    if (completed) {
        console.log(`✅ Migration already completed at ${completed.completedAt}`);
        process.exit(0);
    }

    // Create new migration run
    const totalUsers = await prisma.user.count({
        where: { isDeleted: false },
    });

    const run = await prisma.migrationRun.create({
        data: {
            name: MIGRATION_NAME,
            totalUsers,
            status: MigrationStatus.RUNNING,
        },
    });

    console.log(`🚀 Starting new migration for ${totalUsers} users`);
    return { id: run.id, lastUserId: 0, isNew: true };
}

/**
 * Update migration progress
 */
async function updateProgress(
    runId: string,
    lastUserId: number,
    processedUsers: number
): Promise<void> {
    await prisma.migrationRun.update({
        where: { id: runId },
        data: { lastUserId, processedUsers },
    });
}

/**
 * Mark migration as completed
 */
async function completeMigration(runId: string): Promise<void> {
    await prisma.migrationRun.update({
        where: { id: runId },
        data: {
            status: MigrationStatus.COMPLETED,
            completedAt: new Date(),
        },
    });
}

/**
 * Mark migration as failed
 */
async function failMigration(runId: string, error: string): Promise<void> {
    await prisma.migrationRun.update({
        where: { id: runId },
        data: {
            status: MigrationStatus.FAILED,
            errorMessage: error,
        },
    });
}

/**
 * Get the last ledger entry for a user/currency to determine balanceAfter
 */
async function getLastBalance(
    tx: Prisma.TransactionClient,
    userId: number,
    currency: string
): Promise<Decimal> {
    const lastEntry = await tx.ledgerEntry.findFirst({
        where: { userId, currency },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true },
    });
    return lastEntry?.balanceAfter ?? new Decimal(0);
}

/**
 * Migrate a single user's wallets to ledger entries
 */
async function migrateUser(
    userId: number,
    dryRun: boolean
): Promise<{ entries: number; skipped: boolean }> {
    // Get all asset wallets for this user
    const wallets = await prisma.assetWallet.findMany({
        where: {
            userId,
            isActive: true,
        },
    });

    if (wallets.length === 0) {
        return { entries: 0, skipped: true };
    }

    let entriesCreated = 0;

    // Use transaction for atomicity
    await prisma.$transaction(async (tx) => {
        for (const wallet of wallets) {
            const balance = new Decimal(wallet.balance.toString());
            const locked = new Decimal(wallet.locked.toString());
            const currency = wallet.assetCurrency.toLowerCase();

            // Skip if no balance
            if (balance.isZero() && locked.isZero()) {
                continue;
            }

            // Check if entry already exists (idempotency)
            const existingEntry = await tx.ledgerEntry.findFirst({
                where: {
                    userId,
                    currency,
                    reference: `migration_${MIGRATION_NAME}_${wallet.id}`,
                },
            });

            if (existingEntry) {
                console.log(`  ⏭️ Skipping ${currency} - already migrated`);
                continue;
            }

            if (dryRun) {
                console.log(`  [DRY RUN] Would create entry: ${balance} ${currency}`);
                entriesCreated++;
                continue;
            }

            // Get current balance (should be 0 for new user)
            const currentBalance = await getLastBalance(tx, userId, currency);

            // Create the available balance entry
            if (!balance.isZero()) {
                const newBalance = currentBalance.plus(balance);
                await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type: "MIGRATION" as LedgerType, // Use string literal for new enum values
                        debit: new Decimal(0),
                        credit: balance,
                        balanceAfter: newBalance,
                        reference: `migration_${MIGRATION_NAME}_${wallet.id}`,
                        description: `Initial balance migration from AssetWallet`,
                        status: EntryStatus.SETTLED,
                        metadata: {
                            assetWalletId: wallet.id,
                            originalBalance: balance.toString(),
                            originalLocked: locked.toString(),
                            migratedAt: new Date().toISOString(),
                        },
                    },
                });
                entriesCreated++;
            }

            // Create held balance entry if there's locked funds
            if (!locked.isZero()) {
                const balanceAfterHold = await getLastBalance(tx, userId, currency);
                await tx.ledgerEntry.create({
                    data: {
                        userId,
                        currency,
                        type: "MIGRATION_HOLD" as LedgerType, // Use string literal for new enum values
                        debit: new Decimal(0),
                        credit: new Decimal(0),
                        holdAmount: locked,
                        balanceAfter: balanceAfterHold, // Held doesn't change available balance
                        reference: `migration_hold_${MIGRATION_NAME}_${wallet.id}`,
                        description: `Initial locked balance migration`,
                        status: EntryStatus.HOLD,
                        metadata: {
                            assetWalletId: wallet.id,
                            lockedAmount: locked.toString(),
                        },
                    },
                });
                entriesCreated++;
            }
        }
    }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30000,
    });

    return { entries: entriesCreated, skipped: false };
}

/**
 * Verify migration by comparing AssetWallet balances to Ledger balances
 */
async function verifyMigration(): Promise<{
    matches: number;
    mismatches: { userId: number; currency: string; wallet: string; ledger: string }[];
}> {
    console.log("\n🔍 Verifying migration...\n");

    const mismatches: { userId: number; currency: string; wallet: string; ledger: string }[] = [];
    let matches = 0;

    // Get all users with asset wallets
    const users = await prisma.user.findMany({
        where: { isDeleted: false },
        select: { id: true },
    });

    for (const user of users) {
        const wallets = await prisma.assetWallet.findMany({
            where: { userId: user.id, isActive: true },
        });

        for (const wallet of wallets) {
            const currency = wallet.assetCurrency.toLowerCase();
            const walletBalance = new Decimal(wallet.balance.toString());

            // Get ledger balance
            const lastEntry = await prisma.ledgerEntry.findFirst({
                where: {
                    userId: user.id,
                    currency,
                    status: EntryStatus.SETTLED,
                },
                orderBy: { createdAt: "desc" },
                select: { balanceAfter: true },
            });

            const ledgerBalance = lastEntry?.balanceAfter ?? new Decimal(0);

            if (!walletBalance.equals(ledgerBalance)) {
                mismatches.push({
                    userId: user.id,
                    currency,
                    wallet: walletBalance.toString(),
                    ledger: ledgerBalance.toString(),
                });
            } else if (!walletBalance.isZero()) {
                matches++;
            }
        }
    }

    return { matches, mismatches };
}

/**
 * Main migration function
 */
async function main(): Promise<void> {
    const options = parseArgs();
    const stats: MigrationStats = {
        totalUsers: 0,
        processedUsers: 0,
        skippedUsers: 0,
        totalEntries: 0,
        errors: [],
        startTime: new Date(),
    };

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║        Virtual Balance Ledger Migration Script           ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    if (options.dryRun) {
        console.log("🔸 DRY RUN MODE - No changes will be made\n");
    }

    // Handle verify-only mode
    if (options.verifyOnly) {
        const { matches, mismatches } = await verifyMigration();
        console.log(`\n✅ Matched: ${matches}`);
        if (mismatches.length > 0) {
            console.log(`❌ Mismatches: ${mismatches.length}`);
            for (const m of mismatches.slice(0, 10)) {
                console.log(`   User ${m.userId} ${m.currency}: Wallet=${m.wallet}, Ledger=${m.ledger}`);
            }
            if (mismatches.length > 10) {
                console.log(`   ... and ${mismatches.length - 10} more`);
            }
            process.exit(1);
        }
        console.log("\n✅ All balances match!\n");
        process.exit(0);
    }

    // Get or create migration run
    let runId: string | null = null;
    let lastUserId = 0;

    if (!options.dryRun) {
        const run = await getMigrationRun(options.resume);
        runId = run.id;
        lastUserId = run.lastUserId;
    }

    try {
        // Get users to migrate
        const users = await prisma.user.findMany({
            where: {
                id: { gt: lastUserId },
                isDeleted: false,
            },
            orderBy: { id: "asc" },
            select: { id: true, email: true },
        });

        stats.totalUsers = users.length;
        console.log(`📊 Processing ${users.length} users...\n`);

        // Process in batches
        for (let i = 0; i < users.length; i += BATCH_SIZE) {
            const batch = users.slice(i, i + BATCH_SIZE);

            for (const user of batch) {
                try {
                    const result = await migrateUser(user.id, options.dryRun);

                    if (result.skipped) {
                        stats.skippedUsers++;
                    } else {
                        stats.processedUsers++;
                        stats.totalEntries += result.entries;
                    }

                    // Update progress every user
                    if (runId && !options.dryRun) {
                        await updateProgress(runId, user.id, stats.processedUsers);
                    }
                } catch (error) {
                    const errorMsg = `User ${user.id}: ${error instanceof Error ? error.message : String(error)}`;
                    stats.errors.push(errorMsg);
                    console.error(`❌ Error: ${errorMsg}`);
                }
            }

            // Progress report
            const progress = Math.round(((i + batch.length) / users.length) * 100);
            console.log(`📈 Progress: ${progress}% (${i + batch.length}/${users.length})`);
        }

        // Mark as completed
        if (runId && !options.dryRun) {
            await completeMigration(runId);
        }

        // Summary
        const duration = (Date.now() - stats.startTime.getTime()) / 1000;
        console.log("\n╔══════════════════════════════════════════════════════════╗");
        console.log("║                    Migration Complete                     ║");
        console.log("╚══════════════════════════════════════════════════════════╝\n");
        console.log(`📊 Summary:`);
        console.log(`   - Total users: ${stats.totalUsers}`);
        console.log(`   - Processed: ${stats.processedUsers}`);
        console.log(`   - Skipped (no balance): ${stats.skippedUsers}`);
        console.log(`   - Ledger entries created: ${stats.totalEntries}`);
        console.log(`   - Errors: ${stats.errors.length}`);
        console.log(`   - Duration: ${duration.toFixed(2)}s`);

        if (stats.errors.length > 0) {
            console.log(`\n⚠️ Errors encountered:`);
            for (const error of stats.errors.slice(0, 10)) {
                console.log(`   - ${error}`);
            }
        }

        // Run verification
        if (!options.dryRun) {
            const { matches, mismatches } = await verifyMigration();
            if (mismatches.length > 0) {
                console.log(`\n⚠️ Post-migration verification found ${mismatches.length} mismatches`);
                process.exit(1);
            }
            console.log(`\n✅ Verification passed: ${matches} balances match\n`);
        }

    } catch (error) {
        console.error("\n❌ Migration failed:", error);
        if (runId) {
            await failMigration(runId, error instanceof Error ? error.message : String(error));
        }
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

// Run migration
main().catch(console.error);
