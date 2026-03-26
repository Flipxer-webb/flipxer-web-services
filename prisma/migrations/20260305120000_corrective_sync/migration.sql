-- Corrective migration: fix schema drift caused by db push / wrong table names
-- All statements are idempotent (IF EXISTS / IF NOT EXISTS) so this is safe
-- whether the DB was managed by db push, migrate deploy, or a mix of both.

-- =====================================================
-- 1. Fix botched table drop from migration #28
--    (targeted "UserBiometricCredential" singular,
--     but migration #19 created "UserBiometricCredentials" plural)
-- =====================================================

DROP TABLE IF EXISTS "UserBiometricCredentials";
DROP TABLE IF EXISTS "UserBiometricCredential";

-- =====================================================
-- 2. Fix botched column drops from migration #29
--    (targeted "Session"/"User" singular,
--     but actual tables are "Sessions"/"Users")
-- =====================================================

ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "isTrusted";
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "trustedAt";
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "trustExpiresAt";
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "deviceToken";
ALTER TABLE "Users" DROP COLUMN IF EXISTS "skipTwoFactorForTrustedDevices";

-- =====================================================
-- 3. Add missing enum values
--    (exist in schema.prisma but no migration ever added them)
-- =====================================================

ALTER TYPE "KycVerificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_DOCUMENT';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'REFUND';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'MIGRATION';
ALTER TYPE "LedgerType" ADD VALUE IF NOT EXISTS 'MIGRATION_HOLD';

-- =====================================================
-- 4. Add missing KycVerifications columns
--    (exist in schema.prisma but no migration ever added them)
-- =====================================================

ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);
ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "escalatedById" INTEGER;
ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "providerRef" TEXT;
ALTER TABLE "KycVerifications" ADD COLUMN IF NOT EXISTS "providerRawResponse" JSONB;

CREATE INDEX IF NOT EXISTS "KycVerifications_userId_verificationType_isActive_idx"
  ON "KycVerifications"("userId", "verificationType", "isActive");
