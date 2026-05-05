-- CreateEnum
CREATE TYPE "KycJourneyType" AS ENUM ('INDIVIDUAL');

-- CreateEnum
CREATE TYPE "KycStage" AS ENUM ('GOVERNMENT_ID', 'IDENTITY_DOCUMENT', 'ADDRESS', 'INCOME');

-- CreateEnum
CREATE TYPE "KycMethod" AS ENUM (
    'BVN',
    'NIN',
    'INTERNATIONAL_PASSPORT',
    'DRIVER_LICENSE',
    'NIN_SLIP',
    'UTILITY_BILL',
    'BANK_STATEMENT',
    'GOVERNMENT_LETTER',
    'PAYSLIP',
    'EMPLOYMENT_LETTER',
    'CONTRACT',
    'BANK_STATEMENT_INCOME',
    'TAX_RETURN',
    'BUSINESS_REGISTRATION',
    'OTHER'
);

-- CreateEnum
CREATE TYPE "KycAttemptStatus" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED',
    'ESCALATED',
    'EXPIRED'
);

-- CreateEnum
CREATE TYPE "KycProviderName" AS ENUM ('DOJAH', 'OCR', 'NONE');

-- CreateEnum
CREATE TYPE "KycProviderStatus" AS ENUM ('NOT_REQUESTED', 'RUNNING', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'ERROR');

-- CreateEnum
CREATE TYPE "KycDecisionMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "KycEvidenceKind" AS ENUM ('FRONT_IMAGE', 'BACK_IMAGE', 'PDF', 'SUPPORTING_FILE');

-- CreateEnum
CREATE TYPE "KycEvidenceSide" AS ENUM ('FRONT', 'BACK');

-- CreateTable
CREATE TABLE "KycStageAttempts" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "legacyVerificationId" INTEGER,
    "journeyType" "KycJourneyType" NOT NULL DEFAULT 'INDIVIDUAL',
    "stage" "KycStage" NOT NULL,
    "method" "KycMethod" NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "status" "KycAttemptStatus" NOT NULL,
    "providerName" "KycProviderName" NOT NULL DEFAULT 'NONE',
    "providerStatus" "KycProviderStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "decisionMode" "KycDecisionMode" NOT NULL DEFAULT 'MANUAL',
    "providerRef" TEXT,
    "reasonCode" TEXT,
    "reasonMessage" TEXT,
    "reasonDetails" JSONB,
    "extractedFields" JSONB,
    "comparisonSummary" JSONB,
    "evidenceSummary" JSONB,
    "reviewerId" INTEGER,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KycStageAttempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycEvidenceAssets" (
    "id" SERIAL NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "kind" "KycEvidenceKind" NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "storageFieldId" TEXT,
    "originalName" TEXT,
    "mimeType" TEXT NOT NULL,
    "checksumSha256" TEXT,
    "pageCount" INTEGER,
    "side" "KycEvidenceSide",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KycEvidenceAssets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KycStageAttempts_legacyVerificationId_key" ON "KycStageAttempts"("legacyVerificationId");

-- CreateIndex
CREATE UNIQUE INDEX "KycStageAttempts_userId_stage_attemptNo_key" ON "KycStageAttempts"("userId", "stage", "attemptNo");

-- CreateIndex
CREATE INDEX "KycStageAttempts_userId_stage_isCurrent_idx" ON "KycStageAttempts"("userId", "stage", "isCurrent");

-- CreateIndex
CREATE INDEX "KycStageAttempts_stage_isCurrent_idx" ON "KycStageAttempts"("stage", "isCurrent");

-- CreateIndex
CREATE INDEX "KycStageAttempts_status_idx" ON "KycStageAttempts"("status");

-- CreateIndex
CREATE INDEX "KycEvidenceAssets_attemptId_idx" ON "KycEvidenceAssets"("attemptId");

-- CreateIndex
CREATE INDEX "KycEvidenceAssets_kind_idx" ON "KycEvidenceAssets"("kind");

-- AddForeignKey
ALTER TABLE "KycStageAttempts" ADD CONSTRAINT "KycStageAttempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycStageAttempts" ADD CONSTRAINT "KycStageAttempts_legacyVerificationId_fkey" FOREIGN KEY ("legacyVerificationId") REFERENCES "KycVerifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycEvidenceAssets" ADD CONSTRAINT "KycEvidenceAssets_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "KycStageAttempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
