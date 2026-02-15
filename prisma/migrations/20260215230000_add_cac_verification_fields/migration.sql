-- AlterTable
ALTER TABLE "BusinessDocuments"
ADD COLUMN     "cacVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cacVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "cacCompanyName" TEXT,
ADD COLUMN     "cacCompanyStatus" TEXT,
ADD COLUMN     "cacRegistrationDate" TEXT,
ADD COLUMN     "cacNameMatches" BOOLEAN,
ADD COLUMN     "cacRawResponse" TEXT,

ADD COLUMN     "tinVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tinVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "tinTaxpayerName" TEXT,
ADD COLUMN     "tinNameMatches" BOOLEAN,
ADD COLUMN     "tinRawResponse" TEXT,

ADD COLUMN     "cacOcrVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cacOcrVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "cacOcrExtractedNumber" TEXT,
ADD COLUMN     "cacOcrExtractedName" TEXT,
ADD COLUMN     "cacOcrNumberMatches" BOOLEAN,
ADD COLUMN     "cacOcrRawResponse" TEXT;
