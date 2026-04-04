import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== Creating Missing Enums and Tables ===\n');

  // Create enums first
  console.log('Creating enums...');
  
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerType') THEN
        CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'HOLD', 'RELEASE', 'BUY', 'SELL', 'SWAP_IN', 'SWAP_OUT', 'SEND', 'RECEIVE', 'FEE', 'SWEEP', 'ADJUSTMENT', 'MIGRATION', 'MIGRATION_HOLD');
      END IF;
    END $$;
  `);
  console.log('  ✅ LedgerType enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryStatus') THEN
        CREATE TYPE "EntryStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
      END IF;
    END $$;
  `);
  console.log('  ✅ EntryStatus enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SweepStatus') THEN
        CREATE TYPE "SweepStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
      END IF;
    END $$;
  `);
  console.log('  ✅ SweepStatus enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'QueueReason') THEN
        CREATE TYPE "QueueReason" AS ENUM ('DEPOSIT_SETTLING', 'LOW_LIQUIDITY');
      END IF;
    END $$;
  `);
  console.log('  ✅ QueueReason enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdjustmentType') THEN
        CREATE TYPE "AdjustmentType" AS ENUM ('CREDIT', 'DEBIT');
      END IF;
    END $$;
  `);
  console.log('  ✅ AdjustmentType enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ApprovalStatus') THEN
        CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
      END IF;
    END $$;
  `);
  console.log('  ✅ ApprovalStatus enum');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MigrationStatus') THEN
        CREATE TYPE "MigrationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');
      END IF;
    END $$;
  `);
  console.log('  ✅ MigrationStatus enum');

  // Now create tables
  console.log('\nCreating tables...');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "LedgerEntries" (
        "id" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "currency" TEXT NOT NULL,
        "type" "LedgerType" NOT NULL,
        "debit" DECIMAL(20,8) NOT NULL,
        "credit" DECIMAL(20,8) NOT NULL,
        "balanceAfter" DECIMAL(20,8) NOT NULL,
        "status" "EntryStatus" NOT NULL DEFAULT 'PENDING',
        "sweepStatus" "SweepStatus",
        "holdAmount" DECIMAL(20,8),
        "reference" TEXT NOT NULL,
        "tradeGroupId" TEXT,
        "exchangeRate" DECIMAL(20,8),
        "counterpartyUserId" INTEGER,
        "paymentReference" TEXT,
        "metadata" JSONB,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "LedgerEntries_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntries_type_reference_key" ON "LedgerEntries"("type", "reference");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_idx" ON "LedgerEntries"("userId", "currency");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LedgerEntries_status_idx" ON "LedgerEntries"("status");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LedgerEntries_sweepStatus_idx" ON "LedgerEntries"("sweepStatus");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LedgerEntries_tradeGroupId_idx" ON "LedgerEntries"("tradeGroupId");`);
  console.log('  ✅ LedgerEntries table + indexes');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FloatConfigs" (
        "id" TEXT NOT NULL,
        "currency" TEXT NOT NULL,
        "floatAllowance" DECIMAL(20,8) NOT NULL,
        "alertThreshold" DECIMAL(5,2) NOT NULL,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "FloatConfigs_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "FloatConfigs_currency_key" ON "FloatConfigs"("currency");`);
  console.log('  ✅ FloatConfigs table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WithdrawalQueues" (
        "id" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "currency" TEXT NOT NULL,
        "amount" DECIMAL(20,8) NOT NULL,
        "holdEntryId" TEXT NOT NULL,
        "reason" "QueueReason" NOT NULL,
        "position" INTEGER NOT NULL,
        "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "processedAt" TIMESTAMP(3),
        "releasedAt" TIMESTAMP(3),
        CONSTRAINT "WithdrawalQueues_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "WithdrawalQueues_userId_currency_idx" ON "WithdrawalQueues"("userId", "currency");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "WithdrawalQueues_reason_idx" ON "WithdrawalQueues"("reason");`);
  console.log('  ✅ WithdrawalQueues table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReconciliationLogs" (
        "id" TEXT NOT NULL,
        "currency" TEXT NOT NULL,
        "ledgerBalance" DECIMAL(20,8) NOT NULL,
        "chainBalance" DECIMAL(20,8) NOT NULL,
        "discrepancy" DECIMAL(20,8) NOT NULL,
        "discrepancyPercent" DECIMAL(10,6) NOT NULL,
        "status" TEXT NOT NULL,
        "notes" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ReconciliationLogs_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReconciliationLogs_currency_createdAt_idx" ON "ReconciliationLogs"("currency", "createdAt");`);
  console.log('  ✅ ReconciliationLogs table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AdjustmentRequests" (
        "id" TEXT NOT NULL,
        "userId" INTEGER NOT NULL,
        "currency" TEXT NOT NULL,
        "type" "AdjustmentType" NOT NULL,
        "amount" DECIMAL(20,8) NOT NULL,
        "reason" TEXT NOT NULL,
        "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
        "requestedBy" INTEGER NOT NULL,
        "approvedBy" INTEGER,
        "approvedAt" TIMESTAMP(3),
        "ledgerEntryId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "AdjustmentRequests_pkey" PRIMARY KEY ("id")
    );
  `);
  console.log('  ✅ AdjustmentRequests table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WebhookLogs" (
        "id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "eventType" TEXT NOT NULL,
        "reference" TEXT NOT NULL,
        "payload" JSONB NOT NULL,
        "processedAt" TIMESTAMP(3),
        "status" TEXT NOT NULL DEFAULT 'RECEIVED',
        "error" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "WebhookLogs_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "WebhookLogs_provider_reference_key" ON "WebhookLogs"("provider", "reference");`);
  console.log('  ✅ WebhookLogs table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "MigrationRuns" (
        "id" TEXT NOT NULL,
        "status" "MigrationStatus" NOT NULL,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" TIMESTAMP(3),
        "lastProcessedUserId" INTEGER,
        "totalUsers" INTEGER NOT NULL,
        "processedUsers" INTEGER NOT NULL DEFAULT 0,
        "skippedUsers" INTEGER NOT NULL DEFAULT 0,
        "errors" JSONB,
        CONSTRAINT "MigrationRuns_pkey" PRIMARY KEY ("id")
    );
  `);
  console.log('  ✅ MigrationRuns table');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AdminQueueSeen" (
        "id" TEXT NOT NULL,
        "adminId" INTEGER NOT NULL,
        "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AdminQueueSeen_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AdminQueueSeen_adminId_key" ON "AdminQueueSeen"("adminId");`);
  console.log('  ✅ AdminQueueSeen table');

  // Verify tables
  console.log('\n=== Verification ===');
  const tables = await prisma.$queryRaw<{tablename: string}[]>`
    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename IN ('LedgerEntries', 'FloatConfigs', 'WithdrawalQueues', 'ReconciliationLogs', 'AdjustmentRequests', 'WebhookLogs', 'MigrationRuns', 'AdminQueueSeen')
    ORDER BY tablename;
  `;
  console.log(`Created ${tables.length} tables:`);
  tables.forEach(t => console.log(`  - ${t.tablename}`));

  const enums = await prisma.$queryRaw<{typname: string}[]>`
    SELECT typname FROM pg_type 
    WHERE typtype = 'e' AND typname IN ('LedgerType', 'EntryStatus', 'SweepStatus', 'QueueReason', 'AdjustmentType', 'ApprovalStatus', 'MigrationStatus')
    ORDER BY typname;
  `;
  console.log(`\nCreated ${enums.length} enums:`);
  enums.forEach(e => console.log(`  - ${e.typname}`));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
