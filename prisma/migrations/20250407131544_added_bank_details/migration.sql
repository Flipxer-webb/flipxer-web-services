-- CreateTable
CREATE TABLE "AccountLimits" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "sellTokenFiat" INTEGER DEFAULT 50000,
    "buyToken" TEXT DEFAULT 'unlimited',
    "swapToken" TEXT DEFAULT 'unlimited',
    "sendToken" INTEGER DEFAULT 50000,
    "receiveToken" TEXT DEFAULT 'unlimited',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLimits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDetails" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountLimits_userId_key" ON "AccountLimits"("userId");

-- CreateIndex
CREATE INDEX "Users_id_bvn_idx" ON "Users"("id", "bvn");

-- AddForeignKey
ALTER TABLE "AccountLimits" ADD CONSTRAINT "AccountLimits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDetails" ADD CONSTRAINT "BankDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
