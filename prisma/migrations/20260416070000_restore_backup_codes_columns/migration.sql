-- Restore columns dropped prematurely by 20260414090000_move_backup_codes_to_table
-- The deployed code still references Users.twoFactorBackupCodes and Users.backupCodesGeneratedAt

ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "twoFactorBackupCodes" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "backupCodesGeneratedAt" TIMESTAMP(3);

-- Backfill from the TwoFactorBackupCodes table (unused codes only)
UPDATE "Users" u
SET "twoFactorBackupCodes" = sub.codes
FROM (
    SELECT "userId", json_agg("codeHash")::text AS codes
    FROM "TwoFactorBackupCodes"
    WHERE "usedAt" IS NULL
    GROUP BY "userId"
) sub
WHERE u.id = sub."userId";

COMMENT ON COLUMN "Users"."twoFactorBackupCodes" IS 'JSON array of hashed backup codes for 2FA recovery (restored for backward compat)';
