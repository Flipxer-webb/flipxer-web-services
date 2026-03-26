-- Drop columns from "Sessions" table
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "isTrusted";
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "trustedAt";
ALTER TABLE "Sessions" DROP COLUMN IF EXISTS "deviceToken";

-- Drop column from "Users" table
ALTER TABLE "Users" DROP COLUMN IF EXISTS "skipTwoFactorForTrustedDevices";
