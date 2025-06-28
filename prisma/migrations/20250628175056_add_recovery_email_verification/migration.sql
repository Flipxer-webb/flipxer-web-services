/*
  Warnings:

  - A unique constraint covering the columns `[userId,code]` on the table `RecoveryEmailVerificationRequests` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `userId` to the `RecoveryEmailVerificationRequests` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "RecoveryEmailVerificationRequests_email_code_idx";

-- DropIndex
DROP INDEX "RecoveryEmailVerificationRequests_email_code_key";

-- DropIndex
DROP INDEX "RecoveryEmailVerificationRequests_email_key";

-- AlterTable
ALTER TABLE "RecoveryEmailVerificationRequests" ADD COLUMN     "userId" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "RecoveryEmailVerificationRequests_userId_code_idx" ON "RecoveryEmailVerificationRequests"("userId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_userId_code_key" ON "RecoveryEmailVerificationRequests"("userId", "code");

-- AddForeignKey
ALTER TABLE "RecoveryEmailVerificationRequests" ADD CONSTRAINT "RecoveryEmailVerificationRequests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
