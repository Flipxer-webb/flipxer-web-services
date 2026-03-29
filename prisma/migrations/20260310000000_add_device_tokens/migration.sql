-- CreateTable
CREATE TABLE "DeviceTokens" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceTokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceTokens_token_idx" ON "DeviceTokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceTokens_userId_token_key" ON "DeviceTokens"("userId", "token");

-- AddForeignKey
ALTER TABLE "DeviceTokens" ADD CONSTRAINT "DeviceTokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing tokens from Users.notificationToken to DeviceTokens
INSERT INTO "DeviceTokens" ("userId", "token", "platform", "updatedAt")
SELECT "id", "notificationToken", 'web', NOW()
FROM "Users"
WHERE LENGTH(TRIM(COALESCE("notificationToken", ''))) > 0;
