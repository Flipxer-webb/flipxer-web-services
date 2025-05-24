/*
  Warnings:

  - A unique constraint covering the columns `[cryptoSubAccountId]` on the table `Users` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CryptoWalletStatus" AS ENUM ('ACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "NetworkTypes" AS ENUM ('trc20', 'erc20', 'bep20', 'btc', 'ltc', 'dash', 'doge', 'bch', 'ripple', 'stellar', 'cardano', 'solana', 'polygon');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'filled', 'partial', 'cancelled', 'failed', 'confirmed', 'initiated', 'completed', 'reversed', 'done', 'processing', 'rejected', 'submitted', 'on_hold', 'accepted');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('limit', 'market');

-- CreateEnum
CREATE TYPE "OrderCategory" AS ENUM ('TRADE', 'SWAP', 'WITHDRAWER', 'DEPOSIT');

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "cryptoSubAccountId" TEXT,
ADD COLUMN     "refreshToken" TEXT;

-- CreateTable
CREATE TABLE "AssetWallets" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "quidaxWalletId" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "assetCurrency" TEXT NOT NULL,
    "balance" DECIMAL(20,18) NOT NULL,
    "locked" DECIMAL(20,18) NOT NULL,
    "staked" DECIMAL(20,18) NOT NULL,
    "convertedBalance" DECIMAL(20,8) NOT NULL,
    "referenceCurrency" TEXT NOT NULL,
    "isCrypto" BOOLEAN NOT NULL,
    "defaultNetwork" TEXT NOT NULL,
    "blockchainEnabled" BOOLEAN NOT NULL,
    "depositAddress" TEXT,
    "destinationTag" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "addressSynced" BOOLEAN NOT NULL DEFAULT false,
    "networks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetWallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptoWalletAddresses" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "walletAddressId" TEXT NOT NULL,
    "address" TEXT,
    "totalPayments" DECIMAL(65,30) NOT NULL DEFAULT 0.0,
    "lastSyncedAt" TIMESTAMP(3),
    "network" "NetworkTypes",
    "destination_tag" TEXT,
    "status" "CryptoWalletStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CryptoWalletAddresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Orders" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "orderCategory" "OrderCategory" NOT NULL,
    "market" TEXT,
    "orderType" "OrderType",
    "orderSide" "OrderSide",
    "volume" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "status" "OrderStatus" NOT NULL,
    "quotationId" TEXT,
    "fromCurrency" TEXT,
    "toCurrency" TEXT,
    "fromAmount" DOUBLE PRECISION,
    "toAmount" DOUBLE PRECISION,
    "quoted_price" DOUBLE PRECISION,
    "quoted_currency" TEXT,
    "executionPrice" DOUBLE PRECISION,
    "swapExpiresAt" TIMESTAMP(3),
    "currency" TEXT,
    "narration" TEXT,
    "reason" TEXT,
    "transaction_note" TEXT,
    "recipient" TEXT,
    "amount" DOUBLE PRECISION,
    "fee" DOUBLE PRECISION,
    "total" DOUBLE PRECISION,
    "sourceType" TEXT,
    "blockchain_txid" TEXT,
    "providerOrderId" TEXT,
    "orderReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Banks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "longCode" TEXT,
    "logo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssetWallets_quidaxWalletId_key" ON "AssetWallets"("quidaxWalletId");

-- CreateIndex
CREATE INDEX "AssetWallets_userId_idx" ON "AssetWallets"("userId");

-- CreateIndex
CREATE INDEX "AssetWallets_assetCurrency_idx" ON "AssetWallets"("assetCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "AssetWallets_userId_assetCurrency_key" ON "AssetWallets"("userId", "assetCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWalletAddresses_walletAddressId_key" ON "CryptoWalletAddresses"("walletAddressId");

-- CreateIndex
CREATE UNIQUE INDEX "CryptoWalletAddresses_userId_assetSymbol_network_key" ON "CryptoWalletAddresses"("userId", "assetSymbol", "network");

-- CreateIndex
CREATE UNIQUE INDEX "Orders_providerOrderId_key" ON "Orders"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Orders_orderReference_key" ON "Orders"("orderReference");

-- CreateIndex
CREATE UNIQUE INDEX "Banks_slug_key" ON "Banks"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Banks_code_key" ON "Banks"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Users_cryptoSubAccountId_key" ON "Users"("cryptoSubAccountId");

-- AddForeignKey
ALTER TABLE "AssetWallets" ADD CONSTRAINT "AssetWallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CryptoWalletAddresses" ADD CONSTRAINT "CryptoWalletAddresses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Orders" ADD CONSTRAINT "Orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
