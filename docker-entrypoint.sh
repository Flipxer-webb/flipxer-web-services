#!/bin/sh
set -e

echo "=== Running database migrations ==="
npx prisma migrate deploy

echo "=== Seeding database ==="
npx prisma db seed || echo "Seeding completed (or already seeded)"

echo "=== Starting server ==="
exec node dist/server
