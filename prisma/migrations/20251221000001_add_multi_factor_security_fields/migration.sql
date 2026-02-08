-- AlterTable: Add multi-factor security fields to Users table
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "securityMethods" JSONB;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "requiredMethodCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "backupCodesGeneratedAt" TIMESTAMP(3);

-- Comment: securityMethods stores {sms: boolean, email: boolean, authenticator: boolean, tradingPassword: boolean}
-- Comment: requiredMethodCount is how many methods must be verified per transaction (tier-based minimum)
-- Comment: backupCodesGeneratedAt tracks when universal backup codes were last generated

-- CreateTable: TransactionOTPs for SMS/Email transaction verification
CREATE TABLE IF NOT EXISTS "TransactionOTPs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionOTPs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TransactionOTPs_userId_method_key" ON "TransactionOTPs"("userId", "method");
CREATE INDEX IF NOT EXISTS "TransactionOTPs_userId_idx" ON "TransactionOTPs"("userId");
