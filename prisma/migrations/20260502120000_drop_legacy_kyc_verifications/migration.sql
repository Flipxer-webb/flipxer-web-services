-- DropForeignKey
ALTER TABLE "KycStageAttempts" DROP CONSTRAINT IF EXISTS "KycStageAttempts_legacyVerificationId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "KycStageAttempts_legacyVerificationId_key";

-- AlterTable
ALTER TABLE "KycAttemptEvents" DROP COLUMN IF EXISTS "legacyVerificationId";
ALTER TABLE "KycStageAttempts" DROP COLUMN IF EXISTS "legacyVerificationId";

-- DropTable
DROP TABLE IF EXISTS "KycVerifications";

-- DropEnum
DROP TYPE IF EXISTS "KycVerificationType";