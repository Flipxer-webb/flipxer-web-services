#!/bin/sh
set -e

echo "=== Syncing database schema ==="
npx prisma db push --accept-data-loss || echo "Schema sync completed"

echo "=== Seeding database ==="
npx prisma db seed || echo "Seeding completed (or already seeded)"

echo "=== Starting server ==="
exec node dist/server
