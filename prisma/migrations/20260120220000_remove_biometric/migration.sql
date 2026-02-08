-- Drop the UserBiometricCredential table which was removed from schema.prisma
DROP TABLE IF EXISTS "UserBiometricCredential";

-- Ensure biometric columns are removed from User table (safety net)
-- The User model is mapped to "Users" table in the database
ALTER TABLE "Users" DROP COLUMN IF EXISTS "isBiometricVerified";
ALTER TABLE "Users" DROP COLUMN IF EXISTS "biometricVerifiedAt";
