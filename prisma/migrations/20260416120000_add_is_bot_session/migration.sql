-- AlterTable
ALTER TABLE "Sessions" ADD COLUMN "isBotSession" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Sessions_isBotSession_idx" ON "Sessions"("isBotSession");
