/**
 * Pre-Migration Safety Check
 * Run this before applying any database migrations
 * 
 * Usage: npx ts-node prisma/scripts/pre-migrate-check.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TableCount {
  table: string;
  count: number;
}

async function preMigrateCheck(): Promise<void> {
  console.log('🔍 PRE-MIGRATION SAFETY CHECK\n');
  console.log('='.repeat(50));
  
  try {
    // 1. Check current database stats
    console.log('\n📊 CURRENT DATABASE STATE:\n');
    
    const tables: TableCount[] = [];
    
    // Count records in critical tables
    const userCount = await prisma.user.count();
    tables.push({ table: 'User', count: userCount });
    
    const orderCount = await prisma.order.count();
    tables.push({ table: 'Order', count: orderCount });
    
    const paymentCount = await prisma.payment.count();
    tables.push({ table: 'Payment', count: paymentCount });
    
    const walletCount = await prisma.wallet.count();
    tables.push({ table: 'Wallet', count: walletCount });
    
    const transactionCount = await prisma.transaction.count();
    tables.push({ table: 'Transaction', count: transactionCount });
    
    // Display counts
    tables.forEach(({ table, count }) => {
      const status = count > 0 ? '⚠️ ' : '✅ ';
      console.log(`  ${status}${table}: ${count.toLocaleString()} records`);
    });
    
    // 2. Check for pending migrations
    console.log('\n📋 MIGRATION STATUS:\n');
    
    const migrations = await prisma.$queryRaw<{ migration_name: string; finished_at: Date }[]>`
      SELECT migration_name, finished_at 
      FROM _prisma_migrations 
      ORDER BY finished_at DESC 
      LIMIT 5
    `.catch(() => []);
    
    if (migrations.length > 0) {
      console.log('  Last 5 applied migrations:');
      migrations.forEach((m) => {
        console.log(`    - ${m.migration_name}`);
      });
    } else {
      console.log('  ⚠️  No migration history found (using db push?)');
    }
    
    // 3. Warnings
    console.log('\n⚠️  WARNINGS:\n');
    
    const hasData = tables.some(t => t.count > 0);
    
    if (hasData) {
      console.log('  🚨 DATABASE CONTAINS DATA!');
      console.log('  📌 Before proceeding:');
      console.log('     1. Create a backup: npx ts-node prisma/scripts/backup-database.ps1');
      console.log('     2. Review the migration SQL in prisma/migrations/');
      console.log('     3. Test on a staging database first');
      console.log('     4. NEVER use "prisma db push" on production\n');
    } else {
      console.log('  ✅ Database is empty - safe to proceed\n');
    }
    
    // 4. Recommendations
    console.log('📝 SAFE MIGRATION COMMANDS:\n');
    console.log('  Development:');
    console.log('    npx prisma migrate dev --name <migration-name>\n');
    console.log('  Production:');
    console.log('    npx prisma migrate deploy\n');
    console.log('  ❌ AVOID:');
    console.log('    npx prisma db push (development only)');
    console.log('    npx prisma db push --accept-data-loss (DESTROYS DATA)\n');
    
  } catch (error) {
    console.error('Error during pre-migration check:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

preMigrateCheck();
