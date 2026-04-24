-- CreateTable
CREATE TABLE "TwoFactorBackupCodes" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "TwoFactorBackupCodes_pkey" PRIMARY KEY ("id")
);

-- Backfill legacy JSON backup codes into one row per code
INSERT INTO "TwoFactorBackupCodes" ("userId", "codeHash", "createdAt")
SELECT
    "Users"."id",
    parsed_codes.code_hash,
    COALESCE("Users"."backupCodesGeneratedAt", "Users"."updatedAt", "Users"."createdAt", CURRENT_TIMESTAMP)
FROM "Users"
CROSS JOIN LATERAL jsonb_array_elements_text("Users"."twoFactorBackupCodes"::jsonb) AS parsed_codes(code_hash)
WHERE "Users"."twoFactorBackupCodes" IS NOT NULL;

-- CreateIndex
CREATE INDEX "TwoFactorBackupCodes_userId_usedAt_idx" ON "TwoFactorBackupCodes"("userId", "usedAt");
CREATE INDEX "TwoFactorBackupCodes_userId_createdAt_idx" ON "TwoFactorBackupCodes"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "TwoFactorBackupCodes"
ADD CONSTRAINT "TwoFactorBackupCodes_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop legacy columns after backfill
ALTER TABLE "Users" DROP COLUMN "twoFactorBackupCodes";
ALTER TABLE "Users" DROP COLUMN "backupCodesGeneratedAt";