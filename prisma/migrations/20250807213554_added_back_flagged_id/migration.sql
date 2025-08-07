/*
  Warnings:

  - A unique constraint covering the columns `[flaggedId]` on the table `Users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Users" ADD COLUMN     "flaggedId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Users_flaggedId_key" ON "Users"("flaggedId");
