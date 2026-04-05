-- Add paymentConfirmedByUser and stuckAlertSentAt columns to Payments table.
-- These were added to schema.prisma without a corresponding migration.
-- All statements are idempotent.

ALTER TABLE "Payments"
ADD COLUMN IF NOT EXISTS "paymentConfirmedByUser" TIMESTAMP(3);

ALTER TABLE "Payments"
ADD COLUMN IF NOT EXISTS "stuckAlertSentAt" TIMESTAMP(3);
