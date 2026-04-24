-- DropColumns: remove legacy twoFactorBackupCodes and backupCodesGeneratedAt from Users
-- These columns were kept temporarily by migration 20260416070000 for rollback safety.
-- All reads/writes now use the TwoFactorBackupCodes table (created in 20260414090000).

ALTER TABLE "Users" DROP COLUMN IF EXISTS "twoFactorBackupCodes";
ALTER TABLE "Users" DROP COLUMN IF EXISTS "backupCodesGeneratedAt";
