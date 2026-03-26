-- Add sender detail fields to Payment for underpayment tracking (OB-001)
ALTER TABLE "Payments" ADD COLUMN "senderAccountNumber" TEXT;
ALTER TABLE "Payments" ADD COLUMN "senderAccountName" TEXT;
ALTER TABLE "Payments" ADD COLUMN "senderBankName" TEXT;
ALTER TABLE "Payments" ADD COLUMN "receivedAmount" DECIMAL(10, 2);
