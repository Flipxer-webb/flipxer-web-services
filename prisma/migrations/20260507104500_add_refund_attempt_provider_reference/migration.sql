ALTER TABLE "RefundAttempts"
ADD COLUMN "providerReference" TEXT;

CREATE INDEX "RefundAttempts_provider_providerReference_idx"
ON "RefundAttempts"("provider", "providerReference");