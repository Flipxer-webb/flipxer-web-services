-- Add missing enum values for EntryStatus
ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'HOLD';
ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'SETTLED';
ALTER TYPE "EntryStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- Add missing enum values for SweepStatus  
ALTER TYPE "SweepStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
ALTER TYPE "SweepStatus" ADD VALUE IF NOT EXISTS 'NOT_APPLICABLE';

-- Add description column to LedgerEntries
ALTER TABLE "LedgerEntries" ADD COLUMN IF NOT EXISTS "description" TEXT;
