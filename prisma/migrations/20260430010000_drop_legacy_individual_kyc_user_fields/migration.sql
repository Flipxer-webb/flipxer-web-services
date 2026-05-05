-- Drop legacy individual-only KYC compatibility columns now derived from current stage attempts
ALTER TABLE "Users"
    DROP COLUMN IF EXISTS "isBvnVerified",
    DROP COLUMN IF EXISTS "isNinVerified",
    DROP COLUMN IF EXISTS "isAddressVerified",
    DROP COLUMN IF EXISTS "isIncomeVerified",
    DROP COLUMN IF EXISTS "addressVerificationStatus",
    DROP COLUMN IF EXISTS "incomeVerificationStatus";