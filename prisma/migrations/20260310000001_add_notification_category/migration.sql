-- AlterTable
ALTER TABLE "Notifications" ADD COLUMN "category" TEXT;

-- CreateIndex
CREATE INDEX "Notifications_category_idx" ON "Notifications"("category");
