-- Add dojahExtractedExpiryDate column to UserDocuments table
ALTER TABLE "UserDocuments" ADD COLUMN IF NOT EXISTS "dojahExtractedExpiryDate" TEXT;
