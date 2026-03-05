-- Backfill sweepTxId and sweepRetryCount from metadata JSON into dedicated columns.
-- This is safe to run multiple times (idempotent).

-- Backfill sweepTxId from metadata JSON
UPDATE "LedgerEntries"
SET "sweepTxId" = metadata->>'sweepTxId'
WHERE metadata->>'sweepTxId' IS NOT NULL
  AND "sweepTxId" IS NULL;

-- Backfill sweepRetryCount from metadata JSON
UPDATE "LedgerEntries"
SET "sweepRetryCount" = (metadata->>'sweepRetryCount')::integer
WHERE metadata->>'sweepRetryCount' IS NOT NULL
  AND "sweepRetryCount" = 0;
