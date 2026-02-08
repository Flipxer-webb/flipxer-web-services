-- Drop columns from "Session" table
ALTER TABLE "Session" DROP COLUMN IF EXISTS "isTrusted";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "trustedAt";
ALTER TABLE "Session" DROP COLUMN IF EXISTS "deviceToken";

-- Drop column from "User" table
ALTER TABLE "User" DROP COLUMN IF EXISTS "skipTwoFactorForTrustedDevices";
