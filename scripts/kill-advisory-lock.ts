/**
 * Terminate Advisory Lock Holder Script
 * 
 * Terminates the process holding the Prisma migration advisory lock.
 * USE WITH CAUTION - this will kill any migration in progress.
 * 
 * Usage: npx ts-node scripts/kill-advisory-lock.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PRISMA_MIGRATE_LOCK_ID = 72707369;

async function main() {
    console.log('='.repeat(60));
    console.log('KILL PRISMA ADVISORY LOCK HOLDER');
    console.log('='.repeat(60));
    console.log('');

    try {
        // Find the process holding the lock
        const lockHolders = await prisma.$queryRaw<any[]>`
            SELECT l.pid
            FROM pg_locks l
            WHERE l.locktype = 'advisory' 
            AND l.objid = ${PRISMA_MIGRATE_LOCK_ID}
            AND l.granted = true
        `;

        if (lockHolders.length === 0) {
            console.log('✅ No process is currently holding the Prisma migration lock');
            console.log('   You can proceed with: npx prisma migrate deploy');
            return;
        }

        console.log(`🔴 Found ${lockHolders.length} process(es) holding the lock:`);

        for (const holder of lockHolders) {
            console.log(`   Terminating PID: ${holder.pid}...`);

            // Terminate the process (cast to int)
            const result = await prisma.$queryRawUnsafe<any[]>(
                `SELECT pg_terminate_backend(${holder.pid}::int) as terminated`
            );

            if (result[0].terminated) {
                console.log(`   ✅ PID ${holder.pid} terminated successfully`);
            } else {
                console.log(`   ⚠️  Failed to terminate PID ${holder.pid} (may have already ended)`);
            }
        }

        console.log('');
        console.log('✅ Lock should now be released');
        console.log('   Run: npx prisma migrate deploy');

    } catch (error) {
        console.error('❌ ERROR:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
