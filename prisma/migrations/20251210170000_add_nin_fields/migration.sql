-- AlterTable: Add NIN verification fields to Users table
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "nin" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "ninRegisteredPhone" TEXT;
ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "isNinVerified" BOOLEAN NOT NULL DEFAULT false;
