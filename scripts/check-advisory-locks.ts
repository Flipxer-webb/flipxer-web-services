/**
 * Database Advisory Lock Diagnostic Script
 * 
 * This script checks why Prisma migrations might be timing out on advisory locks.
 * It queries PostgreSQL system views to find:
 * - Active advisory locks
 * - Long-running queries
 * - Connection count and status
 * - Potential blocking queries
 * 
 * Usage: npx ts-node scripts/check-advisory-locks.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    log: ['error'],
});

// Prisma uses this specific lock ID for migrations
const PRISMA_MIGRATE_LOCK_ID = 72707369;

async function main() {
    console.log('='.repeat(60));
    console.log('DATABASE ADVISORY LOCK DIAGNOSTIC');
    console.log('='.repeat(60));
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('');

    try {
        // 1. Check database connection
        console.log('1. DATABASE CONNECTION');
        console.log('-'.repeat(40));
        const dbResult = await prisma.$queryRaw<any[]>`SELECT current_database() as db, current_user as user, now() as time`;
        console.log(`   Database: ${dbResult[0].db}`);
        console.log(`   User: ${dbResult[0].user}`);
        console.log(`   Server Time: ${dbResult[0].time}`);
        console.log('');

        // 2. Check active connections
        console.log('2. ACTIVE CONNECTIONS');
        console.log('-'.repeat(40));
        const connections = await prisma.$queryRaw<any[]>`
            SELECT 
                state,
                COUNT(*) as count
            FROM pg_stat_activity 
            WHERE datname = current_database()
            GROUP BY state
            ORDER BY count DESC
        `;
        connections.forEach((conn: any) => {
            console.log(`   ${conn.state || 'NULL'}: ${conn.count} connections`);
        });
        console.log('');

        // 3. Check for Prisma's specific advisory lock
        console.log('3. PRISMA MIGRATION LOCK STATUS');
        console.log('-'.repeat(40));
        console.log(`   Lock ID: ${PRISMA_MIGRATE_LOCK_ID}`);

        const advisoryLocks = await prisma.$queryRaw<any[]>`
            SELECT 
                classid,
                objid,
                virtualtransaction,
                pid,
                mode,
                granted
            FROM pg_locks 
            WHERE locktype = 'advisory'
        `;

        if (advisoryLocks.length === 0) {
            console.log('   ✅ No advisory locks currently held');
        } else {
            console.log(`   ⚠️  ${advisoryLocks.length} advisory lock(s) found:`);
            advisoryLocks.forEach((lock: any) => {
                const isPrismaLock = lock.objid === PRISMA_MIGRATE_LOCK_ID;
                console.log(`   - Lock ID: ${lock.objid} | PID: ${lock.pid} | Granted: ${lock.granted} ${isPrismaLock ? '🔴 PRISMA LOCK' : ''}`);
            });
        }
        console.log('');

        // 4. Check for processes holding Prisma lock
        console.log('4. PROCESSES HOLDING PRISMA LOCK');
        console.log('-'.repeat(40));
        const prismaLockHolders = await prisma.$queryRaw<any[]>`
            SELECT 
                l.pid,
                a.usename,
                a.application_name,
                a.client_addr,
                a.state,
                a.query_start,
                now() - a.query_start as query_duration,
                LEFT(a.query, 100) as query_preview
            FROM pg_locks l
            JOIN pg_stat_activity a ON l.pid = a.pid
            WHERE l.locktype = 'advisory' 
            AND l.objid = ${PRISMA_MIGRATE_LOCK_ID}
        `;

        if (prismaLockHolders.length === 0) {
            console.log('   ✅ No process currently holds the Prisma migration lock');
        } else {
            console.log(`   🔴 ${prismaLockHolders.length} process(es) holding Prisma lock:`);
            prismaLockHolders.forEach((proc: any) => {
                console.log(`   PID: ${proc.pid}`);
                console.log(`   User: ${proc.usename}`);
                console.log(`   App: ${proc.application_name}`);
                console.log(`   Client: ${proc.client_addr}`);
                console.log(`   State: ${proc.state}`);
                console.log(`   Duration: ${proc.query_duration}`);
                console.log(`   Query: ${proc.query_preview}...`);
                console.log('');
            });
        }
        console.log('');

        // 5. Check long-running queries
        console.log('5. LONG-RUNNING QUERIES (>30s)');
        console.log('-'.repeat(40));
        const longQueries = await prisma.$queryRaw<any[]>`
            SELECT 
                pid,
                usename,
                application_name,
                state,
                now() - query_start as duration,
                LEFT(query, 80) as query_preview
            FROM pg_stat_activity
            WHERE datname = current_database()
            AND state != 'idle'
            AND now() - query_start > interval '30 seconds'
            ORDER BY query_start
        `;

        if (longQueries.length === 0) {
            console.log('   ✅ No long-running queries (>30s)');
        } else {
            console.log(`   ⚠️  ${longQueries.length} long-running query(ies):`);
            longQueries.forEach((q: any) => {
                console.log(`   - PID: ${q.pid} | Duration: ${q.duration} | State: ${q.state}`);
                console.log(`     Query: ${q.query_preview}...`);
            });
        }
        console.log('');

        // 6. Check blocked queries
        console.log('6. BLOCKED QUERIES');
        console.log('-'.repeat(40));
        const blockedQueries = await prisma.$queryRaw<any[]>`
            SELECT 
                blocked.pid as blocked_pid,
                blocked.usename as blocked_user,
                blocking.pid as blocking_pid,
                blocking.usename as blocking_user,
                LEFT(blocked.query, 60) as blocked_query
            FROM pg_stat_activity blocked
            JOIN pg_locks blocked_locks ON blocked.pid = blocked_locks.pid
            JOIN pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
                AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
                AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
                AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
                AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
                AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
                AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
                AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
                AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
                AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
                AND blocking_locks.pid != blocked_locks.pid
            JOIN pg_stat_activity blocking ON blocking_locks.pid = blocking.pid
            WHERE NOT blocked_locks.granted
            LIMIT 10
        `;

        if (blockedQueries.length === 0) {
            console.log('   ✅ No blocked queries');
        } else {
            console.log(`   🔴 ${blockedQueries.length} blocked query(ies):`);
            blockedQueries.forEach((bq: any) => {
                console.log(`   - Blocked PID ${bq.blocked_pid} (${bq.blocked_user}) waiting on PID ${bq.blocking_pid} (${bq.blocking_user})`);
            });
        }
        console.log('');

        // 7. Max connections check
        console.log('7. CONNECTION LIMITS');
        console.log('-'.repeat(40));
        const maxConns = await prisma.$queryRaw<any[]>`
            SELECT 
                setting::int as max_connections
            FROM pg_settings 
            WHERE name = 'max_connections'
        `;
        const activeConns = await prisma.$queryRaw<any[]>`
            SELECT COUNT(*) as count FROM pg_stat_activity WHERE datname = current_database()
        `;
        console.log(`   Max Connections: ${maxConns[0].max_connections}`);
        console.log(`   Active Connections: ${activeConns[0].count}`);
        console.log(`   Available: ${maxConns[0].max_connections - parseInt(activeConns[0].count)}`);
        console.log('');

        // Summary
        console.log('='.repeat(60));
        console.log('DIAGNOSIS SUMMARY');
        console.log('='.repeat(60));

        if (prismaLockHolders.length > 0) {
            console.log('❌ ISSUE FOUND: Another process holds the Prisma migration lock');
            console.log('   SOLUTION: Wait for current migration to complete, or terminate the blocking PID');
            console.log(`   To terminate: SELECT pg_terminate_backend(${prismaLockHolders[0].pid});`);
        } else if (longQueries.length > 0) {
            console.log('⚠️  POSSIBLE ISSUE: Long-running queries may cause contention');
            console.log('   SOLUTION: Consider running migrations during low-traffic periods');
        } else {
            console.log('✅ No obvious lock issues found');
            console.log('   The timeout may be caused by:');
            console.log('   - Network latency to remote database');
            console.log('   - Database server under heavy load');
            console.log('   - Firewall/connection pool issues');
            console.log('   TIP: Try running migrations from Render Shell (same network)');
        }
        console.log('');

    } catch (error) {
        console.error('❌ ERROR connecting to database:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
