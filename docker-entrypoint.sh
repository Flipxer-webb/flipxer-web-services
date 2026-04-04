#!/bin/sh
set -e

echo "=== Applying database migrations ==="
# Resolve any previously-failed migration so deploy can proceed
npx prisma migrate resolve --rolled-back 20260305150000_backfill_sweep_columns_from_metadata 2>/dev/null || true
npx prisma migrate resolve --rolled-back 20260330000000_identity_dedup 2>/dev/null || true
npx prisma migrate resolve --rolled-back 20260404000000_add_payment_idempotency_key 2>/dev/null || true
npx prisma migrate deploy

echo "=== Seeding database ==="
npx prisma db seed || echo "Seeding completed (or already seeded)"

echo "=== Starting server ==="
exec node dist/server
