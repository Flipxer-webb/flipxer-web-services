# KYC Stage Consolidation Baseline Snapshot

Status: Archived pre-cutover baseline

## Capture metadata

- Branch: `temp/kyc-stage-consolidation-cutover-20260502`
- Commit: `01ab99bd0ec89df10a9d9a97ba8989ba6c1ea805`
- Focused test artifact captured at `2026-05-02T09:18:52Z`
- DB baseline captured at `2026-05-02T09:21:44.929Z`
- API baseline captured at `2026-05-02T09:22:13.480Z`

## Locked artifacts

- `_artifacts/kyc-stage-consolidation-baseline/jest-auth-kyc-user.json`
- `_artifacts/kyc-stage-consolidation-baseline/db-baseline.json`
- `_artifacts/kyc-stage-consolidation-baseline/api-baseline.json`

This document preserves the exact pre-cutover baseline captured before the final schema drop. Remaining legacy field names below are retained only when they are part of the archived DB or API snapshot.

## Local deploy result

- Deploy target: local Prisma datasource `flipxer_dev` at `127.0.0.1:5433`
- Applied command: `node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma`
- Applied migration: `20260502_add_kyc_attempt_events_and_business_stage_support`
- Deploy outcome: success
- Prisma deploy confirmation: `All migrations have been successfully applied.`
- `_prisma_migrations` verification: `migration_name=20260502_add_kyc_attempt_events_and_business_stage_support`, `finished_at=2026-05-02 09:51:55.621044+00`, `applied_steps_count=1`, `rolled_back_at=null`
- Post-deploy object verification: `to_regclass('public."KycAttemptEvents"') = "KycAttemptEvents"`

## Baseline checks

- Focused backend regression baseline: `3` suites passed, `251` tests passed, `0` failed.
- Admin queue baseline: `6` queue records captured from `GET /admin/kyc/queue?queueView=all&pageNumber=1&pageSize=25`.
- Admin detail baseline: captured for `tier0.test@flipxer.local` (`userId=2`) and `tier1.test@flipxer.local` (`userId=3`).
- User profile baseline: captured for `tier0.test@flipxer.local` and `tier1.test@flipxer.local` from `GET /user/profile`.

## Parity inputs

### Individual approve-path fixture

- Email: `tier0.test@flipxer.local`
- User ID: `2`
- Current tier at capture: `1`
- Legacy verification row at capture: `id=14`, `verificationType=BVN`, `status=APPROVED`, `version=3`
- Stage attempt row at capture: `id=19`, `journeyType=INDIVIDUAL`, `stage=GOVERNMENT_ID`, `status=APPROVED`, `version=3`, `legacyVerificationId=14`
- Required parity views: DB row, admin detail payload, user profile payload

### Individual reject-path fixture

- Email: `tier1.test@flipxer.local`
- User ID: `3`
- Current tier at capture: `0`
- Legacy verification row at capture: `id=15`, `verificationType=BVN`, `status=REJECTED`, `version=6`
- Stage attempt row at capture: `id=20`, `journeyType=INDIVIDUAL`, `stage=GOVERNMENT_ID`, `status=REJECTED`, `version=6`, `legacyVerificationId=15`
- Required parity views: DB row, admin detail payload, user profile payload

### Business parity prerequisite

- Expected fixture from local-test instructions: `business.test@flipxer.local`
- Actual local DB state during M0 capture: no `BUSINESS` users present
- Impact: business parity is not blocked at schema level, but runtime business-parity validation needs either a reseeded business fixture or an agreed replacement fixture before M4 business cutover work

## Notes

- The M0 capture intentionally preserved the then-live hybrid contract: the legacy verification table was still present in the DB baseline and stage attempts still linked back through `legacyVerificationId`.
- The business fixture gap is recorded explicitly so later milestones do not treat missing business evidence as a silent pass.