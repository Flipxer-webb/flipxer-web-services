-- AlterTable - Add blockThreshold and autoApproveHours to FloatConfigs (if not exists)
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'FloatConfigs' AND column_name = 'blockThreshold') THEN
        ALTER TABLE "FloatConfigs" ADD COLUMN "blockThreshold" DECIMAL(5,2) NOT NULL DEFAULT 95.00;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'FloatConfigs' AND column_name = 'autoApproveHours') THEN
        ALTER TABLE "FloatConfigs" ADD COLUMN "autoApproveHours" INTEGER NOT NULL DEFAULT 24;
    END IF;
END $$;

-- CreateEnum (if not exists)
DO $$ BEGIN CREATE TYPE "DepositReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED', 'EXPIRED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE "DepositReviewQueues" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "txHash" TEXT,
    "floatAtDeposit" DECIMAL(5,2) NOT NULL,
    "status" "DepositReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" INTEGER,
    "notes" TEXT,
    "autoApproveAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositReviewQueues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositReviewQueues_status_queuedAt_idx" ON "DepositReviewQueues"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "DepositReviewQueues_userId_currency_idx" ON "DepositReviewQueues"("userId", "currency");

-- AddForeignKey
ALTER TABLE "DepositReviewQueues" ADD CONSTRAINT "DepositReviewQueues_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositReviewQueues" ADD CONSTRAINT "DepositReviewQueues_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
