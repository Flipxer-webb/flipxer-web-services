-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'HOLD', 'RELEASE', 'BUY', 'SELL', 'SWAP_IN', 'SWAP_OUT', 'SEND', 'RECEIVE', 'FEE', 'SWEEP', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SweepStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "QueueReason" AS ENUM ('DEPOSIT_SETTLING', 'LOW_LIQUIDITY');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');

-- AlterEnum - Add PaymentMethod values if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'FINCRA' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PaymentMethod')) THEN
        ALTER TYPE "PaymentMethod" ADD VALUE 'FINCRA';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'NOMBA' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PaymentMethod')) THEN
        ALTER TYPE "PaymentMethod" ADD VALUE 'NOMBA';
    END IF;
END $$;

-- AlterEnum - Add PermissionGroup values if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'TRANSACTIONS' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'TRANSACTIONS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SETTINGS' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'SETTINGS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ANALYTICS' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'ANALYTICS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'KYC' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'KYC';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'NOTIFICATIONS' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'NOTIFICATIONS';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ROLES' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'ROLES';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SYSTEM' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PermissionGroup')) THEN
        ALTER TYPE "PermissionGroup" ADD VALUE 'SYSTEM';
    END IF;
END $$;

-- DropForeignKey (if exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'AuditLogs_adminId_fkey') THEN
        ALTER TABLE "AuditLogs" DROP CONSTRAINT "AuditLogs_adminId_fkey";
    END IF;
END $$;

-- DropIndex (if exists)
DROP INDEX IF EXISTS "Notifications_userId_isRead_createdAt_idx";

-- AlterTable AuditLogs - handle columns that may or may not exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AuditLogs' AND column_name = 'newValue') THEN
        ALTER TABLE "AuditLogs" DROP COLUMN "newValue";
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AuditLogs' AND column_name = 'previousValue') THEN
        ALTER TABLE "AuditLogs" DROP COLUMN "previousValue";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'AuditLogs' AND column_name = 'details') THEN
        ALTER TABLE "AuditLogs" ADD COLUMN "details" JSONB;
    END IF;
END $$;

ALTER TABLE "AuditLogs" ALTER COLUMN "adminId" DROP NOT NULL;

-- AlterTable Orders - add columns if not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Orders' AND column_name = 'estimatedProfit') THEN
        ALTER TABLE "Orders" ADD COLUMN "estimatedProfit" DOUBLE PRECISION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Orders' AND column_name = 'ledgerEntryId') THEN
        ALTER TABLE "Orders" ADD COLUMN "ledgerEntryId" TEXT;
    END IF;
END $$;

-- AlterTable UserDocuments - add columns if not exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'createdAt') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahCountryCode') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahCountryCode" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahDocumentType') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahDocumentType" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahExtractedDob') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahExtractedDob" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahExtractedDocNumber') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahExtractedDocNumber" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahExtractedFirstName') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahExtractedFirstName" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahExtractedLastName') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahExtractedLastName" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahNameMatches') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahNameMatches" BOOLEAN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahRawResponse') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahRawResponse" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahVerified') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahVerified" BOOLEAN NOT NULL DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'dojahVerifiedAt') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "dojahVerifiedAt" TIMESTAMP(3);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'updatedAt') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'UserDocuments' AND column_name = 'verificationStatus') THEN
        ALTER TABLE "UserDocuments" ADD COLUMN "verificationStatus" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING';
    END IF;
END $$;

-- CreateTable LedgerEntries (if not exists)
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

-- CreateTable FloatConfigs (if not exists)
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

-- CreateTable WithdrawalQueues (if not exists)
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

-- CreateTable ReconciliationLogs (if not exists)
CREATE TABLE IF NOT EXISTS "ReconciliationLogs" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "ledgerTotal" DECIMAL(20,8) NOT NULL,
    "blockchainTotal" DECIMAL(20,8) NOT NULL,
    "discrepancy" DECIMAL(20,8) NOT NULL,
    "discrepancyPct" DECIMAL(10,4) NOT NULL,
    "isWithinTolerance" BOOLEAN NOT NULL,
    "pausedWithdrawals" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationLogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdjustmentRequests (if not exists)
CREATE TABLE IF NOT EXISTS "AdjustmentRequests" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" INTEGER NOT NULL,
    "approvedBy" INTEGER,
    "rejectedBy" INTEGER,
    "rejectionNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdjustmentRequests_pkey" PRIMARY KEY ("id")
);

-- CreateTable WebhookLogs (if not exists)
CREATE TABLE IF NOT EXISTS "WebhookLogs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookLogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable MigrationRuns (if not exists)
CREATE TABLE IF NOT EXISTS "MigrationRuns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastUserId" INTEGER NOT NULL DEFAULT 0,
    "totalUsers" INTEGER NOT NULL DEFAULT 0,
    "processedUsers" INTEGER NOT NULL DEFAULT 0,
    "status" "MigrationStatus" NOT NULL DEFAULT 'RUNNING',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MigrationRuns_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdminQueueSeens (if not exists)
CREATE TABLE IF NOT EXISTS "AdminQueueSeens" (
    "id" TEXT NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "lastSeenQueueId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminQueueSeens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_createdAt_idx" ON "LedgerEntries"("userId", "currency", "createdAt" DESC);

-- CreateIndex (if not exists)
CREATE INDEX IF NOT EXISTS "LedgerEntries_status_idx" ON "LedgerEntries"("status");

-- CreateIndex (all with IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS "LedgerEntries_sweepStatus_idx" ON "LedgerEntries"("sweepStatus");

CREATE INDEX IF NOT EXISTS "LedgerEntries_tradeGroupId_idx" ON "LedgerEntries"("tradeGroupId");

CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntries_type_reference_key" ON "LedgerEntries"("type", "reference");

CREATE UNIQUE INDEX IF NOT EXISTS "FloatConfigs_currency_key" ON "FloatConfigs"("currency");

CREATE UNIQUE INDEX IF NOT EXISTS "WithdrawalQueues_holdEntryId_key" ON "WithdrawalQueues"("holdEntryId");

CREATE INDEX IF NOT EXISTS "WithdrawalQueues_currency_position_idx" ON "WithdrawalQueues"("currency", "position");

CREATE INDEX IF NOT EXISTS "WithdrawalQueues_queuedAt_idx" ON "WithdrawalQueues"("queuedAt");

CREATE INDEX IF NOT EXISTS "ReconciliationLogs_currency_createdAt_idx" ON "ReconciliationLogs"("currency", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AdjustmentRequests_status_idx" ON "AdjustmentRequests"("status");

CREATE INDEX IF NOT EXISTS "AdjustmentRequests_userId_idx" ON "AdjustmentRequests"("userId");

CREATE INDEX IF NOT EXISTS "WebhookLogs_provider_processedAt_idx" ON "WebhookLogs"("provider", "processedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookLogs_provider_eventType_externalId_key" ON "WebhookLogs"("provider", "eventType", "externalId");

CREATE INDEX IF NOT EXISTS "MigrationRuns_name_status_idx" ON "MigrationRuns"("name", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "AdminQueueSeens_adminUserId_key" ON "AdminQueueSeens"("adminUserId");

CREATE INDEX IF NOT EXISTS "BankDetails_bankCode_accountNumber_idx" ON "BankDetails"("bankCode", "accountNumber");

CREATE INDEX IF NOT EXISTS "Notifications_userId_idx" ON "Notifications"("userId");

CREATE INDEX IF NOT EXISTS "Notifications_isRead_idx" ON "Notifications"("isRead");

CREATE INDEX IF NOT EXISTS "Notifications_userId_isRead_idx" ON "Notifications"("userId", "isRead");

CREATE INDEX IF NOT EXISTS "Orders_userId_idx" ON "Orders"("userId");

CREATE INDEX IF NOT EXISTS "Orders_status_idx" ON "Orders"("status");

CREATE INDEX IF NOT EXISTS "Orders_createdAt_idx" ON "Orders"("createdAt");

CREATE INDEX IF NOT EXISTS "Orders_streamlinedStatus_idx" ON "Orders"("streamlinedStatus");

CREATE INDEX IF NOT EXISTS "Orders_orderCategory_idx" ON "Orders"("orderCategory");

CREATE INDEX IF NOT EXISTS "Payments_userId_idx" ON "Payments"("userId");

CREATE INDEX IF NOT EXISTS "Payments_status_idx" ON "Payments"("status");

CREATE INDEX IF NOT EXISTS "Payments_createdAt_idx" ON "Payments"("createdAt");

CREATE INDEX IF NOT EXISTS "UserBiometricCredentials_userId_createdAt_idx" ON "UserBiometricCredentials"("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "Users_status_idx" ON "Users"("status");

CREATE INDEX IF NOT EXISTS "Users_createdAt_idx" ON "Users"("createdAt");

-- AddForeignKey (with IF NOT EXISTS check)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'AuditLogs_adminId_fkey') THEN
        ALTER TABLE "AuditLogs" ADD CONSTRAINT "AuditLogs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'LedgerEntries_userId_fkey') THEN
        ALTER TABLE "LedgerEntries" ADD CONSTRAINT "LedgerEntries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'WithdrawalQueues_userId_fkey') THEN
        ALTER TABLE "WithdrawalQueues" ADD CONSTRAINT "WithdrawalQueues_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'WithdrawalQueues_holdEntryId_fkey') THEN
        ALTER TABLE "WithdrawalQueues" ADD CONSTRAINT "WithdrawalQueues_holdEntryId_fkey" FOREIGN KEY ("holdEntryId") REFERENCES "LedgerEntries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;

