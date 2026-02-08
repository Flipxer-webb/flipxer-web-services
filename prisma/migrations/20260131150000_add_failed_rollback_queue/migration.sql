-- CreateEnum
CREATE TYPE "RollbackStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "FailedRollbacks" (
    "id" TEXT NOT NULL,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "status" "RollbackStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "originalError" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "FailedRollbacks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedRollbacks_status_createdAt_idx" ON "FailedRollbacks"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FailedRollbacks_userId_idx" ON "FailedRollbacks"("userId");

-- AddForeignKey
ALTER TABLE "FailedRollbacks" ADD CONSTRAINT "FailedRollbacks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailedRollbacks" ADD CONSTRAINT "FailedRollbacks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
