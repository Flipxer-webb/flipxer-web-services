-- Backfill notification category for existing records
-- Notifications with a transactionType are trade-related → "transaction"
-- Notifications without transactionType are security/system → "security"

UPDATE "Notifications"
SET "category" = 'transaction'
WHERE "category" IS NULL
  AND "transactionType" IS NOT NULL;

UPDATE "Notifications"
SET "category" = 'security'
WHERE "category" IS NULL
  AND "transactionType" IS NULL;
