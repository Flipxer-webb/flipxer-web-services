-- Migration: Add sequenceNumber, sweepTxId, sweepRetryCount to LedgerEntries
-- Fixes: F-001, SW-001, SW-002
-- Step 1: Add column and sequence
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sequenceNumber" BIGINT;
CREATE SEQUENCE IF NOT EXISTS "LedgerEntries_sequenceNumber_seq";
-- Step 2: Backfill existing rows in createdAt ASC order
WITH ordered AS (
    SELECT id,
        ROW_NUMBER() OVER (
            ORDER BY "createdAt" ASC,
                "id" ASC
        ) AS rn
    FROM "LedgerEntries"
    WHERE "sequenceNumber" IS NULL
)
UPDATE "LedgerEntries"
SET "sequenceNumber" = ordered.rn
FROM ordered
WHERE "LedgerEntries".id = ordered.id;
-- Step 3: Advance sequence past highest backfilled value
SELECT setval(
        '"LedgerEntries_sequenceNumber_seq"',
        COALESCE(
            (
                SELECT MAX("sequenceNumber")
                FROM "LedgerEntries"
            ),
            0
        ) + 1,
        false
    );
-- Step 4: Apply constraints
ALTER TABLE "LedgerEntries"
ALTER COLUMN "sequenceNumber"
SET NOT NULL;
ALTER TABLE "LedgerEntries"
ALTER COLUMN "sequenceNumber"
SET DEFAULT nextval('"LedgerEntries_sequenceNumber_seq"');
ALTER SEQUENCE "LedgerEntries_sequenceNumber_seq" OWNED BY "LedgerEntries"."sequenceNumber";
ALTER TABLE "LedgerEntries"
ADD CONSTRAINT "LedgerEntries_sequenceNumber_key" UNIQUE ("sequenceNumber");
CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_seq_idx" ON "LedgerEntries" ("userId", "currency", "sequenceNumber" DESC);
-- SW-001: sweepTxId
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sweepTxId" TEXT;
ALTER TABLE "LedgerEntries"
ADD CONSTRAINT "LedgerEntries_sweepTxId_key" UNIQUE ("sweepTxId");
CREATE INDEX IF NOT EXISTS "LedgerEntries_sweepTxId_idx" ON "LedgerEntries" ("sweepTxId")
WHERE "sweepTxId" IS NOT NULL;
-- SW-002: sweepRetryCount
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sweepRetryCount" INTEGER NOT NULL DEFAULT 0;