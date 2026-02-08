-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATED', 'SETTLED', 'FAILED', 'CANCELLED', 'RETRIED', 'HOLD_PLACED', 'HOLD_RELEASED');

-- CreateTable
CREATE TABLE "LedgerAuditLogs" (
    "id" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAuditLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerAuditLogs_ledgerEntryId_idx" ON "LedgerAuditLogs"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "LedgerAuditLogs_createdAt_idx" ON "LedgerAuditLogs"("createdAt");

-- AddForeignKey
ALTER TABLE "LedgerAuditLogs" ADD CONSTRAINT "LedgerAuditLogs_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
