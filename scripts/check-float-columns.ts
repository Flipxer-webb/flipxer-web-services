/**
 * Check and fix FloatConfigs columns
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Checking FloatConfigs table columns...\n');

    try {
        // Check current columns
        const columns = await prisma.$queryRaw<any[]>`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'FloatConfigs'
        `;

        console.log('Current columns in FloatConfigs:');
        columns.forEach(c => console.log(`  - ${c.column_name} (${c.data_type})`));

        const hasBlockThreshold = columns.some(c => c.column_name === 'blockThreshold');
        const hasAutoApproveHours = columns.some(c => c.column_name === 'autoApproveHours');

        console.log('');
        console.log(`blockThreshold exists: ${hasBlockThreshold}`);
        console.log(`autoApproveHours exists: ${hasAutoApproveHours}`);

        // Check if DepositReviewQueues exists
        const tableExists = await prisma.$queryRaw<any[]>`
            SELECT 1 FROM information_schema.tables 
            WHERE table_name = 'DepositReviewQueues'
        `;
        console.log(`DepositReviewQueues table exists: ${tableExists.length > 0}`);

        // If columns exist, we need to modify the migration
        if (hasBlockThreshold || hasAutoApproveHours) {
            console.log('\n🔴 FloatConfigs columns already exist from partial migration');
            console.log('   Need to mark migration as applied without running column additions');
        }

        // Mark failed migration
        console.log('\nMarking failed migration as rolled back...');
        await prisma.$queryRawUnsafe(`
            UPDATE _prisma_migrations 
            SET rolled_back_at = NOW() 
            WHERE migration_name = '20260115124000_add_deposit_review_queue'
            AND finished_at IS NULL
        `);
        console.log('✅ Done');

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
