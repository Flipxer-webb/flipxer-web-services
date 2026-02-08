-- Drop WebAuthn/Biometric tables (if exists - tables may not have been created yet)
DROP TABLE IF EXISTS "BiometricCredentials";
DROP TABLE IF EXISTS "WebAuthnCredentials";

-- Drop biometric columns from Users (if exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Users' AND column_name = 'biometricVerifiedAt'
    ) THEN
        ALTER TABLE "Users" DROP COLUMN "biometricVerifiedAt";
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Users' AND column_name = 'isBiometricVerified'
    ) THEN
        ALTER TABLE "Users" DROP COLUMN "isBiometricVerified";
    END IF;
END $$;

-- Remove BIOMETRIC from KycVerificationType enum if it exists
-- First update any rows using BIOMETRIC to a different value (e.g., DOCUMENT)

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'KycVerifications') THEN
        -- Only update if BIOMETRIC enum value exists
        IF EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'BIOMETRIC') THEN
            -- Check if type column exists before updating
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'KycVerifications' AND column_name = 'type') THEN
                UPDATE "KycVerifications" SET type = 'DOCUMENT' WHERE type = 'BIOMETRIC';
            END IF;
            -- Also check for verificationType column
            IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'KycVerifications' AND column_name = 'verificationType') THEN
                UPDATE "KycVerifications" SET "verificationType" = 'DOCUMENT' WHERE "verificationType" = 'BIOMETRIC';
            END IF;
        END IF;
    END IF;
END $$;

-- Note: PostgreSQL doesn't support removing enum values directly
-- The enum value will remain but won't be used by new code

