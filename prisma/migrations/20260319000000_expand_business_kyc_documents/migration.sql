-- Expand BusinessDocuments with additional business KYC document fields
ALTER TABLE "BusinessDocuments"
  ADD COLUMN "certificateOfIncorporationUrl" TEXT,
  ADD COLUMN "certificateOfIncorporationFieldId" TEXT,
  ADD COLUMN "certificateOfIncorporationFileName" TEXT,
  ADD COLUMN "applicationForRegistrationUrl" TEXT,
  ADD COLUMN "applicationForRegistrationFieldId" TEXT,
  ADD COLUMN "applicationForRegistrationFileName" TEXT,
  ADD COLUMN "memartUrl" TEXT,
  ADD COLUMN "memartFieldId" TEXT,
  ADD COLUMN "memartFileName" TEXT,
  ADD COLUMN "companyUtilityBillsUrl" TEXT,
  ADD COLUMN "companyUtilityBillsFieldId" TEXT,
  ADD COLUMN "companyUtilityBillsFileName" TEXT,
  ADD COLUMN "companyAmlPolicyUrl" TEXT,
  ADD COLUMN "companyAmlPolicyFieldId" TEXT,
  ADD COLUMN "companyAmlPolicyFileName" TEXT,
  ADD COLUMN "scumlCertificateUrl" TEXT,
  ADD COLUMN "scumlCertificateFieldId" TEXT,
  ADD COLUMN "scumlCertificateFileName" TEXT,
  ADD COLUMN "companyOrganogramUrl" TEXT,
  ADD COLUMN "companyOrganogramFieldId" TEXT,
  ADD COLUMN "companyOrganogramFileName" TEXT,
  ADD COLUMN "companyLicenseUrl" TEXT,
  ADD COLUMN "companyLicenseFieldId" TEXT,
  ADD COLUMN "companyLicenseFileName" TEXT,
  ADD COLUMN "flowsBusinessFundsUrl" TEXT,
  ADD COLUMN "flowsBusinessFundsFieldId" TEXT,
  ADD COLUMN "flowsBusinessFundsFileName" TEXT,
  ADD COLUMN "companyWebsite" TEXT,
  ADD COLUMN "companyTaxId" TEXT,
  ADD COLUMN "companyAddress" TEXT,
  ADD COLUMN "natureOfBusiness" TEXT,
  ADD COLUMN "purposeOfTransaction" TEXT,
  ADD COLUMN "purposeOfTransactionOther" TEXT;

-- Directors (structured)
CREATE TABLE "BusinessDirectors" (
  "id" SERIAL PRIMARY KEY,
  "businessDocumentId" INTEGER NOT NULL,
  "fullName" TEXT NOT NULL,
  "nationality" TEXT NOT NULL,
  "dateOfBirth" TIMESTAMP(3) NOT NULL,
  "residentialAddress" TEXT NOT NULL,
  "businessAddress" TEXT NOT NULL,
  "nin" TEXT,
  "idDocumentUrl" TEXT,
  "idDocumentFieldId" TEXT,
  "idDocumentFileName" TEXT,
  "proofOfAddressUrl" TEXT,
  "proofOfAddressFieldId" TEXT,
  "proofOfAddressFileName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessDirectors_businessDocumentId_fkey"
    FOREIGN KEY ("businessDocumentId") REFERENCES "BusinessDocuments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BusinessDirectors_businessDocumentId_idx"
  ON "BusinessDirectors"("businessDocumentId");

-- Shareholders (structured)
CREATE TABLE "BusinessShareholders" (
  "id" SERIAL PRIMARY KEY,
  "businessDocumentId" INTEGER NOT NULL,
  "fullName" TEXT NOT NULL,
  "nationality" TEXT NOT NULL,
  "dateOfBirth" TIMESTAMP(3) NOT NULL,
  "residentialAddress" TEXT NOT NULL,
  "businessAddress" TEXT NOT NULL,
  "nin" TEXT,
  "ownershipPercentage" DOUBLE PRECISION NOT NULL,
  "idDocumentUrl" TEXT,
  "idDocumentFieldId" TEXT,
  "idDocumentFileName" TEXT,
  "proofOfAddressUrl" TEXT,
  "proofOfAddressFieldId" TEXT,
  "proofOfAddressFileName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessShareholders_businessDocumentId_fkey"
    FOREIGN KEY ("businessDocumentId") REFERENCES "BusinessDocuments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "BusinessShareholders_businessDocumentId_idx"
  ON "BusinessShareholders"("businessDocumentId");

