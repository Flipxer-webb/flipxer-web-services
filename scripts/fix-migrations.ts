/**
 * Fix Migration Script
 * 
 * Kills lock holder, marks failed migration as rolled back, and applies migrations.
 * Does all operations in quick succession to avoid new lock contention.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PRISMA_MIGRATE_LOCK_ID = 72707369;

async function main() {
    console.log('='.repeat(60));
    console.log('FIX PRISMA MIGRATIONS');
    console.log('='.repeat(60));
    console.log('');

    try {
        // Step 1: Kill any lock holders
        console.log('Step 1: Checking for lock holders...');
        const lockHolders = await prisma.$queryRaw<any[]>`
            SELECT l.pid
            FROM pg_locks l
            WHERE l.locktype = 'advisory' 
            AND l.objid = ${PRISMA_MIGRATE_LOCK_ID}
            AND l.granted = true
        `;

        if (lockHolders.length > 0) {
            for (const holder of lockHolders) {
                console.log(`   Terminating PID: ${holder.pid}...`);
                await prisma.$queryRawUnsafe<any[]>(
                    `SELECT pg_terminate_backend(${holder.pid}::int) as terminated`
                );
                console.log(`   ✅ PID ${holder.pid} terminated`);
            }
        } else {
            console.log('   No lock holders found');
        }

        // Step 2: Check for failed migrations
        console.log('');
        console.log('Step 2: Checking migration status...');
        const failedMigrations = await prisma.$queryRaw<any[]>`
            SELECT migration_name, started_at, finished_at, rolled_back_at
            FROM _prisma_migrations
            WHERE finished_at IS NULL 
            AND rolled_back_at IS NULL
        `;

        if (failedMigrations.length > 0) {
            console.log(`   Found ${failedMigrations.length} failed migration(s):`);
            for (const m of failedMigrations) {
                console.log(`   - ${m.migration_name} (started: ${m.started_at})`);

                // Mark as rolled back
                console.log(`     Marking as rolled back...`);
                await prisma.$queryRawUnsafe(`
                    UPDATE _prisma_migrations 
                    SET rolled_back_at = NOW() 
                    WHERE migration_name = '${m.migration_name}'
                `);
                console.log(`     ✅ Marked`);
            }
        } else {
            console.log('   No failed migrations found');
        }

        // Step 3: Check what needs to be applied
        console.log('');
        console.log('Step 3: Checking pending migrations...');
        const migrations = await prisma.$queryRaw<any[]>`
            SELECT migration_name, applied_steps_count, finished_at, rolled_back_at
            FROM _prisma_migrations
            ORDER BY started_at DESC
            LIMIT 10
        `;

        console.log('   Recent migrations:');
        for (const m of migrations) {
            const status = m.finished_at ? '✅' : (m.rolled_back_at ? '🔙' : '❌');
            console.log(`   ${status} ${m.migration_name}`);
        }

        console.log('');
        console.log('='.repeat(60));
        console.log('NEXT STEPS');
        console.log('='.repeat(60));
        console.log('Now run: npx prisma migrate deploy');
        console.log('');

    } catch (error) {
        console.error('❌ ERROR:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
