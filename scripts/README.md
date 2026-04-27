# Backend Scripts

This directory is intentionally split into two buckets:

- `supported/`: curated operational helpers that are still meant to be run.
- `incident-archive/`: historical one-off incident, debugging, and investigation helpers kept only as reference.

Single-incident scripts with hard-coded order IDs, user IDs, payment references, or swap IDs are removed instead of being preserved in `incident-archive`.
Sensitive scripts with hard-coded credentials, personal emails, production endpoints, or obsolete duplicates of the supported helpers are also removed instead of being retained in the archive.

Supported operational scripts in this folder:

- `supported/backup-utils.js`: database backup/list/restore helper. Use the package shortcuts `pnpm db:backup`, `pnpm db:backup:list`, `pnpm db:backup:restore <file>`, and `pnpm db:backup:help`.
- `supported/replay-local-nomba-webhook.js`: local Docker Nomba webhook replay helper. Use `pnpm nomba:replay:local -- --reference <payment-reference>` or `pnpm nomba:replay:local -- --latest-pending-buy`.
- `supported/fix-stuck-buy-orders.js`: reporting and guided recovery helper for stuck BUY orders.

Supported bootstrap and seed scripts are kept in `../prisma/scripts/` because the Docker bootstrap and package scripts call them directly:

- `bootstrap-admin.ts`
- `create-tier-users.ts`
- `setup-income-review-test-user.ts`
- `setup-2fa-test-user.ts`
- `setup-local-quidax-test-users.ts`
- `get-test-2fa-code.js`
- `pre-migrate-check.ts`

The intentionally retained historical scripts in `incident-archive/` are limited to the small set with lasting implementation value:

- `incident-archive/migrate-to-ledger.ts`: documented virtual-balance migration script.
- `incident-archive/backfill-platform-entries.ts`: documented double-entry backfill script for platform counterparts.
- `incident-archive/backfill-identity-subjects.js`: identity-subject backfill for verified identifiers.
- `incident-archive/backfill-name-dob-identifiers.js`: NAME_DOB identifier backfill for identity deduplication.

Anything not listed above should be treated as archived or legacy, even if it still exists in source control.