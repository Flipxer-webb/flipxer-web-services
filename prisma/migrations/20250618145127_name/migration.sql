/*
  Warnings:

  - A unique constraint covering the columns `[userId,accountNumber]` on the table `BankDetails` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TransactionFeeCategory" AS ENUM ('BUY', 'SELL', 'SWAP', 'SEND');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PAYSTACK');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'APPROVED', 'FAILED', 'DECLINED', 'REVERSAL', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('P2P_PAYMENT', 'TRANSFER_FUND');

-- CreateEnum
CREATE TYPE "TransactionFlow" AS ENUM ('IN', 'OUT');

-- AlterTable
ALTER TABLE "BankDetails" ADD COLUMN     "bankCode" TEXT;

-- AlterTable
ALTER TABLE "Orders" ADD COLUMN     "destinationBankAccountName" TEXT,
ADD COLUMN     "destinationBankAccountNumber" TEXT,
ADD COLUMN     "destinationBankCode" TEXT,
ADD COLUMN     "destinationBankName" TEXT,
ADD COLUMN     "destinationTag" TEXT,
ADD COLUMN     "paymentStatus" "TransactionStatus",
ADD COLUMN     "totalToReceiveInFiat" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "CryptoRates" (
    "id" SERIAL NOT NULL,
    "currency" TEXT NOT NULL,
    "buyRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sellRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoRates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionFees" (
    "id" SERIAL NOT NULL,
    "category" "TransactionFeeCategory" NOT NULL,
    "currency" TEXT NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionFees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payments" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "amount" DECIMAL(10,2) NOT NULL,
    "chargeFee" DECIMAL(10,2) NOT NULL DEFAULT 0.0,
    "totalAmount" DECIMAL(10,2),
    "expectedCurrency" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "type" "TransactionType",
    "flow" "TransactionFlow",
    "paymentStatus" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "externalReference" TEXT,
    "destinationBankAccountName" TEXT,
    "destinationBankName" TEXT,
    "destinationBankAccountNumber" TEXT,
    "shortDescription" TEXT,
    "isDebit" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CryptoRates_currency_key" ON "CryptoRates"("currency");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionFees_category_currency_key" ON "TransactionFees"("category", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "Payments_transactionId_key" ON "Payments"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payments_reference_key" ON "Payments"("reference");

-- CreateIndex
CREATE INDEX "Payments_sessionId_idx" ON "Payments"("sessionId");

-- CreateIndex
CREATE INDEX "BankDetails_userId_idx" ON "BankDetails"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BankDetails_userId_accountNumber_key" ON "BankDetails"("userId", "accountNumber");

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
