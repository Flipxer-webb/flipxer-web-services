-- Add provider metadata fields to KYC verification audit records
ALTER TABLE "KycVerifications"
ADD COLUMN "providerRef" TEXT,
ADD COLUMN "providerRawResponse" JSONB;
