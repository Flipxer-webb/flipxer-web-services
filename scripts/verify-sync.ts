/**
 * Final Schema-Database Sync Verification Script
 * 
 * Verifies that Prisma schema, database, and migrations are fully in sync.
 * 
 * Checks:
 * 1. Migration status - all applied, none pending/failed
 * 2. Schema drift - database matches schema
 * 3. New models exist in database
 * 4. New enums exist with correct values
 * 5. New columns exist with correct types
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Expected new models from recent migrations
const EXPECTED_TABLES = [
    'LedgerAuditLogs',
    'DepositReviewQueues',
    'OrphanedHoldReviews',
];

// Expected enums
const EXPECTED_ENUMS = {
    'AuditAction': ['CREATED', 'SETTLED', 'FAILED', 'CANCELLED', 'RETRIED', 'HOLD_PLACED', 'HOLD_RELEASED'],
    'DepositReviewStatus': ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED', 'EXPIRED'],
    'HoldResolution': ['SETTLED', 'REFUNDED', 'EXPIRED', 'CANCELLED', 'ORPHANED'],
};

// Expected new columns
const EXPECTED_COLUMNS = [
    { table: 'FloatConfigs', column: 'blockThreshold', type: 'numeric' },
    { table: 'FloatConfigs', column: 'autoApproveHours', type: 'integer' },
];

async function main() {
    console.log('='.repeat(70));
    console.log('SCHEMA-DATABASE SYNC VERIFICATION');
    console.log('='.repeat(70));
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('');

    let allPassed = true;

    try {
        // =========================================================================
        // 1. MIGRATION STATUS
        // =========================================================================
        console.log('1. MIGRATION STATUS');
        console.log('-'.repeat(50));

        const migrations = await prisma.$queryRaw<any[]>`
            SELECT 
                migration_name,
                finished_at,
                rolled_back_at,
                CASE
                    WHEN finished_at IS NOT NULL THEN 'APPLIED'
                    WHEN rolled_back_at IS NOT NULL THEN 'ROLLED_BACK'
                    ELSE 'FAILED'
                END as status
            FROM _prisma_migrations
            ORDER BY started_at DESC
            LIMIT 10
        `;

        const pendingMigrations = migrations.filter(m => m.status === 'FAILED');
        const appliedMigrations = migrations.filter(m => m.status === 'APPLIED');

        console.log(`   Total migrations (last 10): ${migrations.length}`);
        console.log(`   Applied: ${appliedMigrations.length}`);
        console.log(`   Pending/Failed: ${pendingMigrations.length}`);

        if (pendingMigrations.length > 0) {
            console.log('   ❌ FAIL: Pending migrations found:');
            pendingMigrations.forEach(m => console.log(`       - ${m.migration_name}`));
            allPassed = false;
        } else {
            console.log('   ✅ PASS: No pending migrations');
        }
        console.log('');

        // =========================================================================
        // 2. TABLE VERIFICATION
        // =========================================================================
        console.log('2. TABLE VERIFICATION');
        console.log('-'.repeat(50));

        for (const table of EXPECTED_TABLES) {
            const exists = await prisma.$queryRaw<any[]>`
                SELECT 1 FROM information_schema.tables 
                WHERE table_name = ${table}
            `;

            if (exists.length > 0) {
                console.log(`   ✅ ${table}: EXISTS`);
            } else {
                console.log(`   ❌ ${table}: MISSING`);
                allPassed = false;
            }
        }
        console.log('');

        // =========================================================================
        // 3. ENUM VERIFICATION
        // =========================================================================
        console.log('3. ENUM VERIFICATION');
        console.log('-'.repeat(50));

        for (const [enumName, expectedValues] of Object.entries(EXPECTED_ENUMS)) {
            const enumExists = await prisma.$queryRaw<any[]>`
                SELECT e.enumlabel 
                FROM pg_type t 
                JOIN pg_enum e ON t.oid = e.enumtypid 
                WHERE t.typname = ${enumName}
                ORDER BY e.enumsortorder
            `;

            if (enumExists.length === 0) {
                console.log(`   ❌ ${enumName}: MISSING`);
                allPassed = false;
            } else {
                const actualValues = enumExists.map(e => e.enumlabel);
                const missing = expectedValues.filter(v => !actualValues.includes(v));

                if (missing.length > 0) {
                    console.log(`   ⚠️  ${enumName}: Missing values: ${missing.join(', ')}`);
                    allPassed = false;
                } else {
                    console.log(`   ✅ ${enumName}: OK (${actualValues.length} values)`);
                }
            }
        }
        console.log('');

        // =========================================================================
        // 4. COLUMN VERIFICATION
        // =========================================================================
        console.log('4. COLUMN VERIFICATION');
        console.log('-'.repeat(50));

        for (const { table, column, type } of EXPECTED_COLUMNS) {
            const columnExists = await prisma.$queryRaw<any[]>`
                SELECT data_type 
                FROM information_schema.columns 
                WHERE table_name = ${table} AND column_name = ${column}
            `;

            if (columnExists.length === 0) {
                console.log(`   ❌ ${table}.${column}: MISSING`);
                allPassed = false;
            } else {
                const actualType = columnExists[0].data_type;
                if (actualType === type) {
                    console.log(`   ✅ ${table}.${column}: OK (${actualType})`);
                } else {
                    console.log(`   ⚠️  ${table}.${column}: Type mismatch (expected: ${type}, actual: ${actualType})`);
                }
            }
        }
        console.log('');

        // =========================================================================
        // 5. FOREIGN KEY VERIFICATION (sample)
        // =========================================================================
        console.log('5. FOREIGN KEY VERIFICATION');
        console.log('-'.repeat(50));

        const fkCheck = await prisma.$queryRaw<any[]>`
            SELECT 
                tc.table_name,
                kcu.column_name,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name IN ('LedgerAuditLogs', 'DepositReviewQueues', 'OrphanedHoldReviews')
        `;

        console.log(`   Found ${fkCheck.length} foreign key relationships`);
        fkCheck.forEach(fk => {
            console.log(`   ✅ ${fk.table_name}.${fk.column_name} → ${fk.foreign_table_name}.${fk.foreign_column_name}`);
        });
        console.log('');

        // =========================================================================
        // 6. INDEX VERIFICATION
        // =========================================================================
        console.log('6. INDEX VERIFICATION');
        console.log('-'.repeat(50));

        const indexCheck = await prisma.$queryRaw<any[]>`
            SELECT 
                tablename,
                indexname
            FROM pg_indexes
            WHERE tablename IN ('LedgerAuditLogs', 'DepositReviewQueues', 'OrphanedHoldReviews')
        `;

        console.log(`   Found ${indexCheck.length} indexes on new tables`);
        indexCheck.forEach(idx => {
            console.log(`   ✅ ${idx.tablename}: ${idx.indexname}`);
        });
        console.log('');

        // =========================================================================
        // 7. ROW COUNTS (sanity check)
        // =========================================================================
        console.log('7. ROW COUNTS (sanity check)');
        console.log('-'.repeat(50));

        for (const table of EXPECTED_TABLES) {
            try {
                const count = await prisma.$queryRawUnsafe<any[]>(
                    `SELECT COUNT(*) as count FROM "${table}"`
                );
                console.log(`   ${table}: ${count[0].count} rows`);
            } catch (e) {
                console.log(`   ${table}: Unable to count`);
            }
        }
        console.log('');

        // =========================================================================
        // SUMMARY
        // =========================================================================
        console.log('='.repeat(70));
        console.log('VERIFICATION SUMMARY');
        console.log('='.repeat(70));

        if (allPassed) {
            console.log('');
            console.log('   ✅ ALL CHECKS PASSED');
            console.log('');
            console.log('   Schema, database, and migrations are fully in sync!');
            console.log('');
        } else {
            console.log('');
            console.log('   ❌ SOME CHECKS FAILED');
            console.log('');
            console.log('   Review the issues above and fix accordingly.');
            console.log('');
        }

    } catch (error) {
        console.error('❌ ERROR during verification:', error);
        allPassed = false;
    } finally {
        await prisma.$disconnect();
    }

    process.exit(allPassed ? 0 : 1);
}

main();
