/*
  Warnings:

  - The values [TRADE,WITHDRAWER,DEPOSIT] on the enum `OrderCategory` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `boardResolutionAuthorzedAcctOpeningImageUrl` on the `BusinessDocuments` table. All the data in the column will be lost.
  - You are about to drop the column `meansOfIdentificatioForBeneficialOwner` on the `BusinessDocuments` table. All the data in the column will be lost.
  - You are about to drop the `RecoveryEmails` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `cacImageUrlFieldId` to the `BusinessDocuments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OrderCategory_new" AS ENUM ('BUY', 'SELL', 'SWAP', 'SEND', 'RECEIVE');
ALTER TABLE "Orders" ALTER COLUMN "orderCategory" TYPE "OrderCategory_new" USING ("orderCategory"::text::"OrderCategory_new");
ALTER TYPE "OrderCategory" RENAME TO order_category_old;
ALTER TYPE "OrderCategory_new" RENAME TO "OrderCategory";
DROP TYPE order_category_old;
COMMIT;

-- DropForeignKey
ALTER TABLE "RecoveryEmails" DROP CONSTRAINT "RecoveryEmails_userId_fkey";

-- AlterTable
ALTER TABLE "BusinessDocuments" DROP COLUMN "boardResolutionAuthorzedAcctOpeningImageUrl",
DROP COLUMN "meansOfIdentificatioForBeneficialOwner",
ADD COLUMN     "articleOfAssociationImageUrlFieldId" TEXT,
ADD COLUMN     "boardResolutionAuthorizedAcctOpeningImageUrl" TEXT,
ADD COLUMN     "boardResolutionAuthorizedAcctOpeningImageUrlFieldId" TEXT,
ADD COLUMN     "cacImageUrlFieldId" TEXT NOT NULL,
ADD COLUMN     "meansOfIdentificationForBeneficialOwner" TEXT,
ADD COLUMN     "meansOfIdentificationForBeneficialOwnerImageFieldId" TEXT,
ADD COLUMN     "proofOfAddressForBeneficialOwnerImageFieldId" TEXT,
ALTER COLUMN "articleOfAssociationImageUrl" DROP NOT NULL,
ALTER COLUMN "proofOfAddressForBeneficialOwner" DROP NOT NULL;

-- AlterTable
ALTER TABLE "UserDocuments" ADD COLUMN     "documentImage2FieldId" TEXT,
ADD COLUMN     "documentImageUrl2" TEXT;

-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "businessDocumentsUploaded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recoveryEmail" TEXT;

-- DropTable
DROP TABLE "RecoveryEmails";
