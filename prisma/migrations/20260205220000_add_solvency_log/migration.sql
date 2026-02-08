-- CreateTable
CREATE TABLE "SolvencyLogs" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "userLiabilities" DECIMAL(20,8) NOT NULL,
    "platformReserves" DECIMAL(20,8) NOT NULL,
    "reserveRatio" DECIMAL(10,4) NOT NULL,
    "pendingWithdrawals" DECIMAL(20,8) NOT NULL,
    "effectiveReserveRatio" DECIMAL(10,4) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolvencyLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SolvencyLogs_currency_createdAt_idx" ON "SolvencyLogs"("currency", "createdAt");

-- CreateIndex
CREATE INDEX "SolvencyLogs_status_idx" ON "SolvencyLogs"("status");
