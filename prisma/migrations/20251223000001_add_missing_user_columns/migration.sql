-- Add missing tables and columns that were previously added via db push
-- These are needed before the performance indexes migration can run

-- =====================================================
-- ENUMS (only create if not exists)
-- =====================================================

DO $$ BEGIN
    CREATE TYPE "PriceDirection" AS ENUM ('ABOVE', 'BELOW');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "KycVerificationType" AS ENUM ('BVN', 'NIN', 'DOCUMENT', 'ADDRESS', 'INCOME');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ESCALATED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "LiquidityAlertType" AS ENUM ('LOW_BALANCE', 'HIGH_BALANCE', 'UNUSUAL_ACTIVITY', 'RATE_DEVIATION');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "LiquidityAlertStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =====================================================
-- SESSIONS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "Sessions" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "deviceName" TEXT,
    "deviceType" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "ipAddress" TEXT,
    "location" TEXT,
    "deviceToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "trustedAt" TIMESTAMP(3),
    "trustExpiresAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Sessions_userId_idx" ON "Sessions"("userId");
CREATE INDEX IF NOT EXISTS "Sessions_isActive_idx" ON "Sessions"("isActive");
CREATE INDEX IF NOT EXISTS "Sessions_deviceToken_idx" ON "Sessions"("deviceToken");

ALTER TABLE "Sessions" DROP CONSTRAINT IF EXISTS "Sessions_userId_fkey";
ALTER TABLE "Sessions" ADD CONSTRAINT "Sessions_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- USER BIOMETRIC CREDENTIALS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "UserBiometricCredentials" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "publicKey" TEXT NOT NULL,
    "publicKeyAlgorithm" INTEGER NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceName" TEXT NOT NULL,
    "aaguid" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBiometricCredentials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserBiometricCredentials_userId_idx" ON "UserBiometricCredentials"("userId");

ALTER TABLE "UserBiometricCredentials" DROP CONSTRAINT IF EXISTS "UserBiometricCredentials_userId_fkey";
ALTER TABLE "UserBiometricCredentials" ADD CONSTRAINT "UserBiometricCredentials_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- USER PREFERENCES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "UserPreferences" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "defaultFiatCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "favoriteAssets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quickActionOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quickActionUsage" JSONB,
    "hideZeroBalances" BOOLEAN NOT NULL DEFAULT false,
    "dashboardLayout" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserPreferences_userId_key" ON "UserPreferences"("userId");

ALTER TABLE "UserPreferences" DROP CONSTRAINT IF EXISTS "UserPreferences_userId_fkey";
ALTER TABLE "UserPreferences" ADD CONSTRAINT "UserPreferences_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- NOTIFICATION PREFERENCES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "NotificationPreferences" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "emailTransactions" BOOLEAN NOT NULL DEFAULT true,
    "emailMarketing" BOOLEAN NOT NULL DEFAULT false,
    "emailSecurityAlerts" BOOLEAN NOT NULL DEFAULT true,
    "pushTransactions" BOOLEAN NOT NULL DEFAULT true,
    "pushPriceAlerts" BOOLEAN NOT NULL DEFAULT true,
    "pushSecurityAlerts" BOOLEAN NOT NULL DEFAULT true,
    "pushMarketing" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "NotificationPreferences_userId_key" ON "NotificationPreferences"("userId");

ALTER TABLE "NotificationPreferences" DROP CONSTRAINT IF EXISTS "NotificationPreferences_userId_fkey";
ALTER TABLE "NotificationPreferences" ADD CONSTRAINT "NotificationPreferences_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- PRICE ALERTS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "PriceAlerts" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "targetPrice" DOUBLE PRECISION NOT NULL,
    "direction" "PriceDirection" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggeredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceAlerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PriceAlerts_userId_idx" ON "PriceAlerts"("userId");
CREATE INDEX IF NOT EXISTS "PriceAlerts_isActive_idx" ON "PriceAlerts"("isActive");
CREATE INDEX IF NOT EXISTS "PriceAlerts_currency_idx" ON "PriceAlerts"("currency");

ALTER TABLE "PriceAlerts" DROP CONSTRAINT IF EXISTS "PriceAlerts_userId_fkey";
ALTER TABLE "PriceAlerts" ADD CONSTRAINT "PriceAlerts_userId_fkey" 
    FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- SWAP PAIRS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "SwapPairs" (
    "id" SERIAL NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SwapPairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SwapPairs_fromCurrency_toCurrency_key" ON "SwapPairs"("fromCurrency", "toCurrency");

-- =====================================================
-- AUDIT LOGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "AuditLogs" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "previousValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditLogs_adminId_idx" ON "AuditLogs"("adminId");
CREATE INDEX IF NOT EXISTS "AuditLogs_action_idx" ON "AuditLogs"("action");
CREATE INDEX IF NOT EXISTS "AuditLogs_resource_idx" ON "AuditLogs"("resource");
CREATE INDEX IF NOT EXISTS "AuditLogs_createdAt_idx" ON "AuditLogs"("createdAt");

ALTER TABLE "AuditLogs" DROP CONSTRAINT IF EXISTS "AuditLogs_adminId_fkey";
ALTER TABLE "AuditLogs" ADD CONSTRAINT "AuditLogs_adminId_fkey" 
    FOREIGN KEY ("adminId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- KYC VERIFICATIONS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "KycVerifications" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "verificationType" "KycVerificationType" NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "reviewerId" INTEGER,
    "reviewNote" TEXT,
    "documentUrl" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycVerifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "KycVerifications_userId_idx" ON "KycVerifications"("userId");
CREATE INDEX IF NOT EXISTS "KycVerifications_status_idx" ON "KycVerifications"("status");
CREATE INDEX IF NOT EXISTS "KycVerifications_verificationType_idx" ON "KycVerifications"("verificationType");

-- =====================================================
-- LIQUIDITY ALERTS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "LiquidityAlerts" (
    "id" SERIAL NOT NULL,
    "currency" TEXT NOT NULL,
    "alertType" "LiquidityAlertType" NOT NULL,
    "threshold" DECIMAL(20,8) NOT NULL,
    "currentValue" DECIMAL(20,8),
    "status" "LiquidityAlertStatus" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiquidityAlerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LiquidityAlerts_currency_idx" ON "LiquidityAlerts"("currency");
CREATE INDEX IF NOT EXISTS "LiquidityAlerts_status_idx" ON "LiquidityAlerts"("status");
CREATE INDEX IF NOT EXISTS "LiquidityAlerts_createdAt_idx" ON "LiquidityAlerts"("createdAt");

-- =====================================================
-- SLACK WEBHOOKS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "SlackWebhooks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "channel" TEXT,
    "alertTypes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastTriggered" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackWebhooks_pkey" PRIMARY KEY ("id")
);

-- =====================================================
-- ALERT COOLDOWNS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "AlertCooldowns" (
    "id" SERIAL NOT NULL,
    "alertKey" TEXT NOT NULL,
    "lastAlertedAt" TIMESTAMP(3) NOT NULL,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertCooldowns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AlertCooldowns_alertKey_key" ON "AlertCooldowns"("alertKey");
CREATE INDEX IF NOT EXISTS "AlertCooldowns_alertKey_idx" ON "AlertCooldowns"("alertKey");

-- =====================================================
-- SYSTEM SETTINGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "SystemSettings" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SystemSettings_key_key" ON "SystemSettings"("key");
CREATE INDEX IF NOT EXISTS "SystemSettings_key_idx" ON "SystemSettings"("key");

-- =====================================================
-- FEATURE FLAGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS "FeatureFlags" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FeatureFlags_key_key" ON "FeatureFlags"("key");
CREATE INDEX IF NOT EXISTS "FeatureFlags_key_idx" ON "FeatureFlags"("key");
CREATE INDEX IF NOT EXISTS "FeatureFlags_isEnabled_idx" ON "FeatureFlags"("isEnabled");

-- =====================================================
-- FEATURE FLAG AUDIT LOGS TABLE
-- =====================================================

DO $$ BEGIN
    CREATE TYPE "FeatureFlagAction" AS ENUM ('CREATED', 'ENABLED', 'DISABLED', 'CONDITIONS_UPDATED', 'DELETED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "FeatureFlagAuditLogs" (
    "id" SERIAL NOT NULL,
    "flagId" INTEGER NOT NULL,
    "action" "FeatureFlagAction" NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "changedById" INTEGER NOT NULL,
    "changedByEmail" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlagAuditLogs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FeatureFlagAuditLogs_flagId_idx" ON "FeatureFlagAuditLogs"("flagId");
CREATE INDEX IF NOT EXISTS "FeatureFlagAuditLogs_changedById_idx" ON "FeatureFlagAuditLogs"("changedById");
CREATE INDEX IF NOT EXISTS "FeatureFlagAuditLogs_createdAt_idx" ON "FeatureFlagAuditLogs"("createdAt");

ALTER TABLE "FeatureFlagAuditLogs" DROP CONSTRAINT IF EXISTS "FeatureFlagAuditLogs_flagId_fkey";
ALTER TABLE "FeatureFlagAuditLogs" ADD CONSTRAINT "FeatureFlagAuditLogs_flagId_fkey" 
    FOREIGN KEY ("flagId") REFERENCES "FeatureFlags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =====================================================
-- MISSING USER COLUMNS
-- =====================================================

-- Tier verification level
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "tier" INTEGER NOT NULL DEFAULT 0;

-- Address verification fields
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "isAddressVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "addressVerificationStatus" "DocumentVerificationStatus";
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "addressDocumentUrl" TEXT;

-- Income verification fields  
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "isIncomeVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "incomeVerificationStatus" "DocumentVerificationStatus";
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "incomeDocumentUrl" TEXT;

-- Identity document verification status (separate from business document)
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "documentVerificationStatus" "DocumentVerificationStatus";

-- Two-factor authentication fields
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "isTwoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "twoFactorSecret" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "tradingPassword" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "skipTwoFactorForTrustedDevices" BOOLEAN NOT NULL DEFAULT false;

-- Account lockout for brute force protection
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "lastFailedLogin" TIMESTAMP(3);
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);

-- Recovery email (re-add if dropped)
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "recoveryEmail" TEXT;

