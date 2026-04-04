-- Add missing columns for stuck payment order logic
ALTER TABLE "Payments" ADD COLUMN IF NOT EXISTS "paymentConfirmedByUser" TIMESTAMP(3);
ALTER TABLE "Payments" ADD COLUMN IF NOT EXISTS "stuckAlertSentAt" TIMESTAMP(3);
