import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check what tables exist
  const tables = await prisma.$queryRaw<{tablename: string}[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
  `;
  
  console.log('\n=== Tables in database ===');
  tables.forEach(t => console.log(`  - ${t.tablename}`));
  
  // Check if LedgerEntry table exists
  const ledgerTable = tables.find(t => t.tablename === 'LedgerEntry' || t.tablename === 'LedgerEntries');
  console.log(`\nLedgerEntry table: ${ledgerTable ? 'EXISTS' : 'DOES NOT EXIST'}`);
  
  // Check migration history
  console.log('\n=== Migration History ===');
  const migrations = await prisma.$queryRaw<{migration_name: string}[]>`
    SELECT migration_name FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 10;
  `;
  migrations.forEach(m => console.log(`  - ${m.migration_name}`));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
