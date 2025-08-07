/*
  Warnings:

  - You are about to drop the column `flaggedId` on the `Users` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Users_flaggedId_key";

-- AlterTable
ALTER TABLE "Users" DROP COLUMN "flaggedId";
