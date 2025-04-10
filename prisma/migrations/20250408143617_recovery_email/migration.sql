-- CreateTable
CREATE TABLE "RecoveryEmails" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "recoveryEmail" TEXT,
    "recoveryPin" TEXT,
    "lastPinGeneratedAt" TIMESTAMP(3),

    CONSTRAINT "RecoveryEmails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryEmails_userId_key" ON "RecoveryEmails"("userId");

-- AddForeignKey
ALTER TABLE "RecoveryEmails" ADD CONSTRAINT "RecoveryEmails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
