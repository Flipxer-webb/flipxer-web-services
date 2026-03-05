-- Create columns + backfill from metadata JSON.
-- Migration 20260302000000 was baseline'd (SQL never ran), so columns must be
-- created here. All statements are idempotent (IF NOT EXISTS / IF EXISTS).

-- =====================================================
-- 1. sequenceNumber (F-001: monotonic ordering)
-- =====================================================
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sequenceNumber" BIGINT;

CREATE SEQUENCE IF NOT EXISTS "LedgerEntries_sequenceNumber_seq";

-- Backfill existing rows in createdAt ASC order
WITH ordered AS (
    SELECT id,
        ROW_NUMBER() OVER (
            ORDER BY "createdAt" ASC, "id" ASC
        ) AS rn
    FROM "LedgerEntries"
    WHERE "sequenceNumber" IS NULL
)
UPDATE "LedgerEntries"
SET "sequenceNumber" = ordered.rn
FROM ordered
WHERE "LedgerEntries".id = ordered.id;

-- Advance sequence past highest backfilled value
SELECT setval(
    '"LedgerEntries_sequenceNumber_seq"',
    COALESCE(
        (SELECT MAX("sequenceNumber") FROM "LedgerEntries"),
        0
    ) + 1,
    false
);

-- Apply NOT NULL + default + unique constraints
ALTER TABLE "LedgerEntries"
ALTER COLUMN "sequenceNumber" SET NOT NULL;

ALTER TABLE "LedgerEntries"
ALTER COLUMN "sequenceNumber"
SET DEFAULT nextval('"LedgerEntries_sequenceNumber_seq"');

ALTER SEQUENCE "LedgerEntries_sequenceNumber_seq"
OWNED BY "LedgerEntries"."sequenceNumber";

DO $$ BEGIN
    ALTER TABLE "LedgerEntries"
    ADD CONSTRAINT "LedgerEntries_sequenceNumber_key" UNIQUE ("sequenceNumber");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_seq_idx"
ON "LedgerEntries" ("userId", "currency", "sequenceNumber" DESC);

-- =====================================================
-- 2. sweepTxId (SW-001: webhook correlation)
-- =====================================================
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sweepTxId" TEXT;

DO $$ BEGIN
    ALTER TABLE "LedgerEntries"
    ADD CONSTRAINT "LedgerEntries_sweepTxId_key" UNIQUE ("sweepTxId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "LedgerEntries_sweepTxId_idx"
ON "LedgerEntries" ("sweepTxId")
WHERE "sweepTxId" IS NOT NULL;

-- =====================================================
-- 3. sweepRetryCount (SW-002: retry tracking)
-- =====================================================
ALTER TABLE "LedgerEntries"
ADD COLUMN IF NOT EXISTS "sweepRetryCount" INTEGER NOT NULL DEFAULT 0;

-- =====================================================
-- 4. Backfill from metadata JSON
-- =====================================================
UPDATE "LedgerEntries"
SET "sweepTxId" = metadata->>'sweepTxId'
WHERE metadata->>'sweepTxId' IS NOT NULL
  AND "sweepTxId" IS NULL;

UPDATE "LedgerEntries"
SET "sweepRetryCount" = (metadata->>'sweepRetryCount')::integer
WHERE metadata->>'sweepRetryCount' IS NOT NULL
  AND "sweepRetryCount" = 0;
