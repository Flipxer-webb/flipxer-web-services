/*
  Warnings:

  - The values [CUSTOMER] on the enum `UserType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `isVerified` on the `Users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email,code]` on the table `AccountVerificationRequests` will be added. If there are existing duplicate values, this will fail.
  - Made the column `isDeleted` on table `Users` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "Country" AS ENUM ('NIGERIA');

-- CreateEnum
CREATE TYPE "DocumentVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'DECLINED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INTERNATIONAL_PASSPORT', 'NIN', 'DRIVER_LICENSE');

-- AlterEnum
BEGIN;
CREATE TYPE "UserType_new" AS ENUM ('ADMIN', 'INDIVIDUAL', 'BUSINESS');
ALTER TABLE "Users" ALTER COLUMN "userType" TYPE "UserType_new" USING ("userType"::text::"UserType_new");
ALTER TYPE "UserType" RENAME TO user_type_old;
ALTER TYPE "UserType_new" RENAME TO "UserType";
DROP TYPE user_type_old;
COMMIT;

-- AlterTable
ALTER TABLE "Users" DROP COLUMN "isVerified",
ADD COLUMN     "businessDocumentVerificationStatus" "DocumentVerificationStatus",
ADD COLUMN     "businessRecordCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bvn" TEXT,
ADD COLUMN     "bvnRegisteredPhone" TEXT,
ADD COLUMN     "country" "Country" NOT NULL DEFAULT 'NIGERIA',
ADD COLUMN     "isBvnVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDocumentVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPasswordCreated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "firstName" DROP NOT NULL,
ALTER COLUMN "lastName" DROP NOT NULL,
ALTER COLUMN "password" DROP NOT NULL,
ALTER COLUMN "isDeleted" SET NOT NULL;

-- CreateTable
CREATE TABLE "BusinessRecords" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "businessName" TEXT NOT NULL,
    "natureOfBusiness" TEXT NOT NULL,
    "taxIdentificationNumber" TEXT NOT NULL,
    "expectedTransactionVolume" TEXT NOT NULL,
    "expectedTransactionFrequency" TEXT NOT NULL,

    CONSTRAINT "BusinessRecords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDocuments" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "type" "DocumentType" NOT NULL,
    "country" "Country" NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "documentImageUrl" TEXT NOT NULL,
    "documentImageFieldId" TEXT NOT NULL,

    CONSTRAINT "UserDocuments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessDocuments" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER,
    "cacDocumentNumber" TEXT NOT NULL,
    "cacImageUrl" TEXT NOT NULL,
    "articleOfAssociationNumber" TEXT,
    "articleOfAssociationImageUrl" TEXT NOT NULL,
    "boardResolutionAuthorzedAcctOpeningImageUrl" TEXT NOT NULL,
    "proofOfAddressForBeneficialOwner" TEXT NOT NULL,
    "meansOfIdentificatioForBeneficialOwner" TEXT NOT NULL,

    CONSTRAINT "BusinessDocuments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneVerificationRequests" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PhoneVerificationRequests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessRecords_userId_key" ON "BusinessRecords"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDocuments_userId_key" ON "UserDocuments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessDocuments_userId_key" ON "BusinessDocuments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneVerificationRequests_phone_key" ON "PhoneVerificationRequests"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneVerificationRequests_code_key" ON "PhoneVerificationRequests"("code");

-- CreateIndex
CREATE INDEX "PhoneVerificationRequests_phone_code_idx" ON "PhoneVerificationRequests"("phone", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneVerificationRequests_phone_code_key" ON "PhoneVerificationRequests"("phone", "code");

-- CreateIndex
CREATE INDEX "AccountVerificationRequests_email_code_idx" ON "AccountVerificationRequests"("email", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AccountVerificationRequests_email_code_key" ON "AccountVerificationRequests"("email", "code");

-- AddForeignKey
ALTER TABLE "BusinessRecords" ADD CONSTRAINT "BusinessRecords_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDocuments" ADD CONSTRAINT "UserDocuments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessDocuments" ADD CONSTRAINT "BusinessDocuments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
