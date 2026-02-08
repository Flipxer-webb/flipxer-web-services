-- CreateEnum
CREATE TYPE "HoldResolution" AS ENUM ('REFUND', 'SETTLE', 'DISMISS');

-- CreateTable
CREATE TABLE "OrphanedHoldReviews" (
    "id" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "resolution" "HoldResolution",
    "notes" TEXT,

    CONSTRAINT "OrphanedHoldReviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrphanedHoldReviews_ledgerEntryId_key" ON "OrphanedHoldReviews"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "OrphanedHoldReviews_resolvedAt_idx" ON "OrphanedHoldReviews"("resolvedAt");

-- CreateIndex
CREATE INDEX "OrphanedHoldReviews_detectedAt_idx" ON "OrphanedHoldReviews"("detectedAt");

-- AddForeignKey
ALTER TABLE "OrphanedHoldReviews" ADD CONSTRAINT "OrphanedHoldReviews_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrphanedHoldReviews" ADD CONSTRAINT "OrphanedHoldReviews_resolvedBy_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
