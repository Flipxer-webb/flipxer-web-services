-- AlterEnum
ALTER TYPE "KycJourneyType" ADD VALUE 'BUSINESS';

-- AlterEnum
ALTER TYPE "KycStage" ADD VALUE 'BUSINESS_DOCUMENT';

-- CreateEnum
CREATE TYPE "KycAttemptEventType" AS ENUM (
    'SUBMITTED',
    'PROVIDER_CHECK',
    'ADMIN_RECHECK',
    'APPROVED',
    'REJECTED',
    'ESCALATED',
    'RESUBMITTED',
    'IMPORTED_LEGACY_HISTORY'
);

-- CreateEnum
CREATE TYPE "KycActorType" AS ENUM ('USER', 'ADMIN', 'SYSTEM', 'PROVIDER', 'JOB');

-- CreateTable
CREATE TABLE "KycAttemptEvents" (
    "id" SERIAL NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "journeyType" "KycJourneyType" NOT NULL,
    "stage" "KycStage" NOT NULL,
    "eventType" "KycAttemptEventType" NOT NULL,
    "actorType" "KycActorType",
    "actorId" INTEGER,
    "providerName" "KycProviderName",
    "providerStatus" "KycProviderStatus",
    "providerRef" TEXT,
    "legacyVerificationId" INTEGER,
    "note" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycAttemptEvents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KycStageAttempts_userId_journeyType_stage_isCurrent_idx" ON "KycStageAttempts"("userId", "journeyType", "stage", "isCurrent");

-- CreateIndex
CREATE INDEX "KycAttemptEvents_attemptId_createdAt_idx" ON "KycAttemptEvents"("attemptId", "createdAt");

-- CreateIndex
CREATE INDEX "KycAttemptEvents_userId_createdAt_idx" ON "KycAttemptEvents"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "KycAttemptEvents_journeyType_stage_createdAt_idx" ON "KycAttemptEvents"("journeyType", "stage", "createdAt");

-- CreateIndex
CREATE INDEX "KycAttemptEvents_eventType_createdAt_idx" ON "KycAttemptEvents"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "KycAttemptEvents" ADD CONSTRAINT "KycAttemptEvents_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "KycStageAttempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycAttemptEvents" ADD CONSTRAINT "KycAttemptEvents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;