-- CreateTable
CREATE TABLE "LimitOverrides" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "dailyLimitUSD" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "grantedBy" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LimitOverrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LimitOverrides_userId_key" ON "LimitOverrides"("userId");

-- AddForeignKey
ALTER TABLE "LimitOverrides" ADD CONSTRAINT "LimitOverrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
