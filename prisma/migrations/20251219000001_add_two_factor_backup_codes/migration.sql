-- AlterTable
ALTER TABLE "Users" ADD COLUMN "twoFactorBackupCodes" TEXT;

-- Add comment
COMMENT ON COLUMN "Users"."twoFactorBackupCodes" IS 'JSON array of hashed backup codes for 2FA recovery';


