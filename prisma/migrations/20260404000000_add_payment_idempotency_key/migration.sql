-- Add idempotencyKey column to Payments table.
-- Column was added to schema.prisma without a corresponding migration, so
-- the column is absent from any database that was migrated before this fix.
-- All statements are idempotent.

ALTER TABLE "Payments"
ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

DO $$ BEGIN
    ALTER TABLE "Payments"
    ADD CONSTRAINT "Payments_idempotencyKey_key" UNIQUE ("idempotencyKey");
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;
