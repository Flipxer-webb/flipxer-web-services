/*
  Warnings:

  - A unique constraint covering the columns `[transactionId]` on the table `Orders` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[flaggedId]` on the table `Users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "OrderStreamlinedStatus" AS ENUM ('pending', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ReferenceFiatCurrency" AS ENUM ('NGN');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PUSH_NOTIFICATION', 'MESSAGE');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "NotificationBeneficiary" AS ENUM ('ALL', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "UserNotificationTarget" AS ENUM ('ALL', 'SINGLE');

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
ADD COLUMN     "sender" TEXT,
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
CREATE TABLE "DailyTransactions" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "totalUSD" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyTransactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyTransactions" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "totalUSD" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthlyTransactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllowedIps" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ip" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllowedIps_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "Notifications" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "senderId" INTEGER,
    "userId" INTEGER,
    "target" "UserNotificationTarget" NOT NULL DEFAULT 'ALL',
    "beneficiary" "NotificationBeneficiary" NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'MESSAGE',
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "transactionType" "OrderCategory",
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Flagged_userId_key" ON "Flagged"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTransactions_userId_year_month_day_key" ON "DailyTransactions"("userId", "year", "month", "day");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyTransactions_userId_year_month_key" ON "MonthlyTransactions"("userId", "year", "month");

-- CreateIndex
CREATE INDEX "AllowedIps_userId_idx" ON "AllowedIps"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AllowedIps_userId_ip_key" ON "AllowedIps"("userId", "ip");

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
ALTER TABLE "DailyTransactions" ADD CONSTRAINT "DailyTransactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyTransactions" ADD CONSTRAINT "MonthlyTransactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllowedIps" ADD CONSTRAINT "AllowedIps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryEmailVerificationRequests" ADD CONSTRAINT "RecoveryEmailVerificationRequests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
