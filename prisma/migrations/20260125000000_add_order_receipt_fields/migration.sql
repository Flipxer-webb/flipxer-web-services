-- AlterTable: add optional fields for receipt display (network, paymentMethod)
ALTER TABLE "Orders" ADD COLUMN "network" TEXT;
ALTER TABLE "Orders" ADD COLUMN "paymentMethod" TEXT;
