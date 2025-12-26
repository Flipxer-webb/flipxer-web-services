# Database Backup Guide

## Render Automatic Backups (Recommended)

Your Render PostgreSQL database includes automatic backups:
- **Daily backups** with 7-day retention
- **Point-in-time recovery** for the past 7 days

### Access Backups in Render Dashboard:
1. Go to https://dashboard.render.com
2. Select your PostgreSQL database (`dpg-d538qter433s73c6evk0-a`)
3. Click the **Backups** tab
4. View/restore from any available backup point

---

## Manual Backup Commands

```bash
# Create a backup
pnpm db:backup

# List available backups
pnpm db:backup:list

# Show restore instructions
pnpm db:backup:restore <filename>

# Show help
pnpm db:backup:help
```

---

## Pre-Deployment Checklist

Before running migrations or making database changes:

1. **Check Render backups** - Ensure a recent backup exists
2. **Run pre-check** - `pnpm db:pre-check`
3. **Consider manual backup** - `pnpm db:backup` (if pg_dump available)
4. **Deploy with confidence**

---

## Restore from Render Dashboard

1. Navigate to your database in Render Dashboard
2. Go to **Backups** tab
3. Find the desired restore point
4. Click **Restore** and confirm

> ⚠️ Restoration will replace current data with the backup point.

---

## Local Backup Restoration

If you have a local `.sql` backup file:

```bash
# Using psql (requires PostgreSQL tools installed)
psql "$DATABASE_URL" < backups/backup_TIMESTAMP.sql
```
