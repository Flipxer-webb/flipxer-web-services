ALTER TABLE "Payments"
ADD COLUMN "senderBankCode" TEXT;

CREATE TABLE "RefundAttempts" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "originalPaymentId" INTEGER NOT NULL,
    "payoutPaymentId" INTEGER,
    "provider" "PaymentMethod" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "externalReference" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "destinationBankAccountName" TEXT,
    "destinationBankAccountNumber" TEXT,
    "destinationBankCode" TEXT,
    "destinationBankName" TEXT,
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "initiatedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundAttempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefundAttempts_payoutPaymentId_key" ON "RefundAttempts"("payoutPaymentId");
CREATE UNIQUE INDEX "RefundAttempts_reference_key" ON "RefundAttempts"("reference");
CREATE INDEX "RefundAttempts_orderId_idx" ON "RefundAttempts"("orderId");
CREATE INDEX "RefundAttempts_originalPaymentId_idx" ON "RefundAttempts"("originalPaymentId");
CREATE INDEX "RefundAttempts_status_idx" ON "RefundAttempts"("status");
CREATE INDEX "RefundAttempts_reasonCode_idx" ON "RefundAttempts"("reasonCode");
CREATE INDEX "RefundAttempts_provider_reference_idx" ON "RefundAttempts"("provider", "reference");

ALTER TABLE "RefundAttempts"
ADD CONSTRAINT "RefundAttempts_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundAttempts"
ADD CONSTRAINT "RefundAttempts_originalPaymentId_fkey"
FOREIGN KEY ("originalPaymentId") REFERENCES "Payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundAttempts"
ADD CONSTRAINT "RefundAttempts_payoutPaymentId_fkey"
FOREIGN KEY ("payoutPaymentId") REFERENCES "Payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "TransactionType" ADD VALUE 'BANK_TRANSFER_REFUND';