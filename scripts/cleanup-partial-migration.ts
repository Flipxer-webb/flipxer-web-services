/**
 * Drop Partial Migration Artifacts Script
 * 
 * Drops the AuditAction enum and LedgerAuditLogs table if they exist
 * from a partial migration run.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('='.repeat(60));
    console.log('CLEANUP PARTIAL MIGRATION ARTIFACTS');
    console.log('='.repeat(60));
    console.log('');

    try {
        // Check if AuditAction enum exists
        console.log('Checking for AuditAction enum...');
        const enumExists = await prisma.$queryRaw<any[]>`
            SELECT 1 FROM pg_type WHERE typname = 'AuditAction'
        `;

        if (enumExists.length > 0) {
            console.log('   AuditAction enum exists, dropping...');

            // First check if LedgerAuditLogs table exists and uses it
            const tableExists = await prisma.$queryRaw<any[]>`
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = 'LedgerAuditLogs'
            `;

            if (tableExists.length > 0) {
                console.log('   Dropping LedgerAuditLogs table first...');
                await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "LedgerAuditLogs" CASCADE`);
                console.log('   ✅ Table dropped');
            }

            await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "AuditAction" CASCADE`);
            console.log('   ✅ AuditAction enum dropped');
        } else {
            console.log('   AuditAction enum does not exist');
        }

        // Check for DepositReviewStatus enum
        console.log('');
        console.log('Checking for DepositReviewStatus enum...');
        const enum2Exists = await prisma.$queryRaw<any[]>`
            SELECT 1 FROM pg_type WHERE typname = 'DepositReviewStatus'
        `;

        if (enum2Exists.length > 0) {
            console.log('   DepositReviewStatus enum exists, dropping...');

            const table2Exists = await prisma.$queryRaw<any[]>`
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = 'DepositReviewQueues'
            `;

            if (table2Exists.length > 0) {
                console.log('   Dropping DepositReviewQueues table first...');
                await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "DepositReviewQueues" CASCADE`);
                console.log('   ✅ Table dropped');
            }

            await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "DepositReviewStatus" CASCADE`);
            console.log('   ✅ DepositReviewStatus enum dropped');
        } else {
            console.log('   DepositReviewStatus enum does not exist');
        }

        // Now mark the failed migration as rolled back again
        console.log('');
        console.log('Marking failed migrations as rolled back...');
        await prisma.$queryRawUnsafe(`
            UPDATE _prisma_migrations 
            SET rolled_back_at = NOW() 
            WHERE finished_at IS NULL AND rolled_back_at IS NULL
        `);
        console.log('✅ Done');

        console.log('');
        console.log('='.repeat(60));
        console.log('Now run: npx prisma migrate deploy');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('❌ ERROR:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
