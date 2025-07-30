/*
  Warnings:

  - A unique constraint covering the columns `[transactionId]` on the table `Orders` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[flaggedId]` on the table `Users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "OrderStreamlinedStatus" AS ENUM ('pending', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ReferenceFiatCurrency" AS ENUM ('NGN');

-- AlterTable
ALTER TABLE "BusinessDocuments" ADD COLUMN     "articleOfAssociationFileName" TEXT,
ADD COLUMN     "boardResolutionAuthorizedAcctOpeningFileName" TEXT,
ADD COLUMN     "cacImageFileName" TEXT,
ADD COLUMN     "meansOfIdentificationForBeneficialOwnerFileName" TEXT,
ADD COLUMN     "proofOfAddressForBeneficialOwnerFileName" TEXT;

-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "amountInFiat" DOUBLE PRECISION,
ADD COLUMN     "rateAtConversion" DOUBLE PRECISION,
ADD COLUMN     "referenceFiatCurrency" "ReferenceFiatCurrency" NOT NULL DEFAULT 'NGN',
ADD COLUMN     "streamlinedStatus" "OrderStreamlinedStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "transactionId" TEXT;

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "flaggedId" INTEGER;

-- CreateTable
CREATE TABLE "Flagged" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flagged_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryEmailVerificationRequests" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RecoveryEmailVerificationRequests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Flagged_userId_key" ON "Flagged"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_userId_key" ON "RecoveryEmailVerificationRequests"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_code_key" ON "RecoveryEmailVerificationRequests"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Orders_transactionId_key" ON "Orders"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Users_flaggedId_key" ON "Users"("flaggedId");

-- AddForeignKey
ALTER TABLE "Flagged" ADD CONSTRAINT "Flagged_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryEmailVerificationRequests" ADD CONSTRAINT "RecoveryEmailVerificationRequests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
