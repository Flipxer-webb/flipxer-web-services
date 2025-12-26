/**
 * Database Backup Utilities
 * 
 * Provides commands for:
 * - backup: Create a database backup
 * - list: List available backups
 * - restore: Restore from a backup file
 * 
 * Usage:
 *   node scripts/backup-utils.js backup
 *   node scripts/backup-utils.js list
 *   node scripts/backup-utils.js restore <filename>
 */

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const DATABASE_URL = process.env.DATABASE_URL;

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function createBackup() {
    console.log('🔄 Starting database backup...\n');

    if (!DATABASE_URL) {
        console.error('❌ DATABASE_URL environment variable is not set');
        console.log('\nTo create a backup, set DATABASE_URL or use Render CLI:');
        console.log('  render psql dpg-YOUR-DATABASE-ID --output backup.sql');
        process.exit(1);
    }

    const timestamp = getTimestamp();
    const backupFile = path.join(BACKUP_DIR, `backup_${timestamp}.sql`);

    // Check if pg_dump is available
    exec('pg_dump --version', (error) => {
        if (error) {
            console.log('⚠️  pg_dump not found locally.\n');
            console.log('Options for backing up your database:\n');
            console.log('1. Use Render Dashboard (Recommended):');
            console.log('   - Go to: https://dashboard.render.com');
            console.log('   - Select your PostgreSQL database');
            console.log('   - Click "Backups" tab');
            console.log('   - View automatic backups or create manual snapshot\n');
            console.log('2. Use Render CLI:');
            console.log('   render psql dpg-d538qter433s73c6evk0-a\n');
            console.log('3. Install PostgreSQL tools:');
            console.log('   - Windows: https://www.postgresql.org/download/windows/');
            console.log('   - Then run: pnpm db:backup');
            return;
        }

        // pg_dump is available
        const command = `pg_dump "${DATABASE_URL}" -f "${backupFile}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ Backup failed:', error.message);
                process.exit(1);
            }

            const stats = fs.statSync(backupFile);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

            console.log('✅ Backup created successfully!');
            console.log(`📁 File: ${backupFile}`);
            console.log(`📊 Size: ${sizeMB} MB`);
        });
    });
}

function listBackups() {
    console.log('📋 Available backups in', BACKUP_DIR, '\n');

    if (!fs.existsSync(BACKUP_DIR)) {
        console.log('No backups found.');
        return;
    }

    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz'))
        .sort()
        .reverse();

    if (files.length === 0) {
        console.log('No backups found.');
        console.log('\nTo create a backup, run: pnpm db:backup');
        return;
    }

    files.forEach((file, index) => {
        const filePath = path.join(BACKUP_DIR, file);
        const stats = fs.statSync(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        const date = stats.mtime.toLocaleString();
        console.log(`${index + 1}. ${file}`);
        console.log(`   Size: ${sizeMB} MB | Created: ${date}\n`);
    });
}

function restoreBackup(filename) {
    if (!filename) {
        console.error('❌ Please specify a backup file to restore');
        console.log('\nUsage: pnpm db:backup:restore <filename>');
        console.log('\nAvailable backups:');
        listBackups();
        process.exit(1);
    }

    const backupFile = path.join(BACKUP_DIR, filename);

    if (!fs.existsSync(backupFile)) {
        console.error(`❌ Backup file not found: ${backupFile}`);
        process.exit(1);
    }

    console.log('⚠️  WARNING: This will restore the database from backup!');
    console.log(`📁 File: ${backupFile}\n`);
    console.log('To restore, use Render Dashboard or run:');
    console.log(`  psql "${process.env.DATABASE_URL}" < "${backupFile}"`);
    console.log('\nOr restore from Render Dashboard:');
    console.log('  1. Go to https://dashboard.render.com');
    console.log('  2. Select your PostgreSQL database');
    console.log('  3. Click "Backups" tab');
    console.log('  4. Choose a restore point');
}

function showHelp() {
    console.log(`
Database Backup Utilities

Commands:
  backup              Create a new database backup
  list                List available backup files
  restore <filename>  Show instructions for restoring a backup
  help                Show this help message

Examples:
  pnpm db:backup
  pnpm db:backup:list
  pnpm db:backup:restore backup_2024-01-15T10-30-00.sql

Render Dashboard Backups:
  Your Render PostgreSQL database has automatic daily backups.
  Access them at: https://dashboard.render.com
    `);
}

// Main
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
    case 'backup':
        createBackup();
        break;
    case 'list':
        listBackups();
        break;
    case 'restore':
        restoreBackup(arg);
        break;
    case 'help':
    case '--help':
    case '-h':
        showHelp();
        break;
    default:
        showHelp();
}
