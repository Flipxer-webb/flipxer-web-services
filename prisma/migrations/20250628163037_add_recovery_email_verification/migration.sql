-- CreateTable
CREATE TABLE "RecoveryEmailVerificationRequests" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RecoveryEmailVerificationRequests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_email_key" ON "RecoveryEmailVerificationRequests"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_code_key" ON "RecoveryEmailVerificationRequests"("code");

-- CreateIndex
CREATE INDEX "RecoveryEmailVerificationRequests_email_code_idx" ON "RecoveryEmailVerificationRequests"("email", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmailVerificationRequests_email_code_key" ON "RecoveryEmailVerificationRequests"("email", "code");
