ALTER TABLE "Payments"
ADD COLUMN IF NOT EXISTS "providerAccountReference" TEXT;

CREATE INDEX IF NOT EXISTS "Payments_providerAccountReference_idx"
ON "Payments"("providerAccountReference");