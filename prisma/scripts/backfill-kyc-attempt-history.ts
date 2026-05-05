/*
 * Retired after 20260502120000_drop_legacy_kyc_verifications.
 * Imported legacy history is now fully represented on KycStageAttempt and
 * KycAttemptEvent, and the legacy KycVerifications table no longer exists.
 */

function main(): never {
    throw new Error(
        "prisma/scripts/backfill-kyc-attempt-history.ts was retired after the legacy KYC schema cutover. "
        + "Use docs/kyc-stage-consolidation-migration-spec.md for historical migration context.",
    );
}

main();
