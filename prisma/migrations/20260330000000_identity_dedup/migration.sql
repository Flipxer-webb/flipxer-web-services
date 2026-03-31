-- Identity Deduplication: Phase 1
-- Adds unique constraints on BVN/NIN and creates the identity graph tables.

-- =============================================================================
-- 1. Create IdentityIdType enum
-- =============================================================================
CREATE TYPE "IdentityIdType" AS ENUM ('BVN', 'NIN');

-- =============================================================================
-- 2. Create IdentitySubjects table
-- =============================================================================
CREATE TABLE "IdentitySubjects" (
    "id"           SERIAL       PRIMARY KEY,
    "mergedIntoId" INTEGER      REFERENCES "IdentitySubjects"("id"),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "IdentitySubjects_mergedIntoId_idx" ON "IdentitySubjects"("mergedIntoId");

-- =============================================================================
-- 3. Create IdentityIdentifiers table
-- =============================================================================
CREATE TABLE "IdentityIdentifiers" (
    "id"          SERIAL            PRIMARY KEY,
    "subjectId"   INTEGER           NOT NULL REFERENCES "IdentitySubjects"("id") ON DELETE CASCADE,
    "type"        "IdentityIdType"  NOT NULL,
    "valueHash"   TEXT              NOT NULL,
    "maskedValue" TEXT              NOT NULL,
    "verifiedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Deterministic dedup wall: one identifier value per type globally
CREATE UNIQUE INDEX "IdentityIdentifiers_type_valueHash_key" ON "IdentityIdentifiers"("type", "valueHash");
CREATE INDEX "IdentityIdentifiers_subjectId_idx" ON "IdentityIdentifiers"("subjectId");

-- =============================================================================
-- 4. Add identitySubjectId FK on Users
-- =============================================================================
ALTER TABLE "Users" ADD COLUMN "identitySubjectId" INTEGER;
ALTER TABLE "Users" ADD CONSTRAINT "Users_identitySubjectId_fkey"
    FOREIGN KEY ("identitySubjectId") REFERENCES "IdentitySubjects"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "Users_identitySubjectId_key" ON "Users"("identitySubjectId") WHERE "identitySubjectId" IS NOT NULL;

-- =============================================================================
-- 5. Add unique partial indexes on BVN and NIN
-- =============================================================================
-- Drop old non-unique composite index first
DROP INDEX IF EXISTS "Users_id_bvn_idx";

CREATE UNIQUE INDEX "Users_bvn_unique" ON "Users"("bvn") WHERE "bvn" IS NOT NULL;
CREATE UNIQUE INDEX "Users_nin_unique" ON "Users"("nin") WHERE "nin" IS NOT NULL;
