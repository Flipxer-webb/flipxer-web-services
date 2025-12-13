#!/bin/bash

# Database Backup Script
# Usage: ./scripts/backup-database.sh

set -e

# Load environment variables
if [ -f .env ]; then
  export $(cat .env | grep -v '#' | xargs)
fi

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./backups"
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql"

# Create backup directory if it doesn't exist
mkdir -p $BACKUP_DIR

echo "🔄 Starting database backup..."

# Extract database connection details from DATABASE_URL
# Format: postgresql://user:password@host:port/database
DB_URL=$DATABASE_URL

# Use pg_dump to create backup
pg_dump "$DB_URL" > "$BACKUP_FILE"

echo "✅ Backup created: $BACKUP_FILE"
echo "📦 Compressing backup..."

gzip "$BACKUP_FILE"

echo "✅ Compressed backup: ${BACKUP_FILE}.gz"
echo "📊 Backup size: $(du -h ${BACKUP_FILE}.gz | cut -f1)"
