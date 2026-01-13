import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check if enums exist
  const enums = await prisma.$queryRaw<{typname: string}[]>`
    SELECT typname FROM pg_type WHERE typtype = 'e' ORDER BY typname;
  `;
  
  console.log('\n=== Enums in database ===');
  enums.forEach(e => console.log(`  - ${e.typname}`));
  
  // Check if LedgerType enum exists
  const hasLedgerType = enums.some(e => e.typname === 'LedgerType');
  console.log(`\nLedgerType enum: ${hasLedgerType ? 'EXISTS' : 'DOES NOT EXIST'}`);
  
  if (hasLedgerType) {
    // Show enum values
    const values = await prisma.$queryRaw<{enumlabel: string}[]>`
      SELECT enumlabel FROM pg_enum 
      WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'LedgerType')
      ORDER BY enumsortorder;
    `;
    console.log('\nLedgerType values:');
    values.forEach(v => console.log(`  - ${v.enumlabel}`));
  }
  
  // Try to manually create LedgerEntries table
  console.log('\n=== Attempting to create LedgerEntries table ===');
  
  try {
    await prisma.$executeRaw`
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
    `;
    console.log('✅ LedgerEntries table created (or already exists)');
    
    // Create indexes
    await prisma.$executeRaw`CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntries_type_reference_key" ON "LedgerEntries"("type", "reference");`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_idx" ON "LedgerEntries"("userId", "currency");`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "LedgerEntries_status_idx" ON "LedgerEntries"("status");`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "LedgerEntries_sweepStatus_idx" ON "LedgerEntries"("sweepStatus");`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "LedgerEntries_tradeGroupId_idx" ON "LedgerEntries"("tradeGroupId");`;
    console.log('✅ LedgerEntries indexes created');
    
    // Create other tables
    await prisma.$executeRaw`
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
    `;
    await prisma.$executeRaw`CREATE UNIQUE INDEX IF NOT EXISTS "FloatConfigs_currency_key" ON "FloatConfigs"("currency");`;
    console.log('✅ FloatConfigs table created');
    
    await prisma.$executeRaw`
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
    `;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "WithdrawalQueues_userId_currency_idx" ON "WithdrawalQueues"("userId", "currency");`;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "WithdrawalQueues_reason_idx" ON "WithdrawalQueues"("reason");`;
    console.log('✅ WithdrawalQueues table created');
    
    await prisma.$executeRaw`
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
    `;
    await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS "ReconciliationLogs_currency_createdAt_idx" ON "ReconciliationLogs"("currency", "createdAt");`;
    console.log('✅ ReconciliationLogs table created');
    
    await prisma.$executeRaw`
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
    `;
    console.log('✅ AdjustmentRequests table created');
    
    await prisma.$executeRaw`
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
    `;
    await prisma.$executeRaw`CREATE UNIQUE INDEX IF NOT EXISTS "WebhookLogs_provider_reference_key" ON "WebhookLogs"("provider", "reference");`;
    console.log('✅ WebhookLogs table created');
    
    await prisma.$executeRaw`
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
    `;
    console.log('✅ MigrationRuns table created');
    
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "AdminQueueSeen" (
          "id" TEXT NOT NULL,
          "adminId" INTEGER NOT NULL,
          "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "AdminQueueSeen_pkey" PRIMARY KEY ("id")
      );
    `;
    await prisma.$executeRaw`CREATE UNIQUE INDEX IF NOT EXISTS "AdminQueueSeen_adminId_key" ON "AdminQueueSeen"("adminId");`;
    console.log('✅ AdminQueueSeen table created');
    
    // Verify tables exist now
    const tablesAfter = await prisma.$queryRaw<{tablename: string}[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('LedgerEntries', 'FloatConfigs', 'WithdrawalQueues', 'ReconciliationLogs', 'AdjustmentRequests', 'WebhookLogs', 'MigrationRuns', 'AdminQueueSeen');
    `;
    console.log('\n=== New tables created ===');
    tablesAfter.forEach(t => console.log(`  - ${t.tablename}`));
    
  } catch (error) {
    console.error('Failed to create tables:', error);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
