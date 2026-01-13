import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== Fixing Table Schemas ===\n');

  // Drop and recreate MigrationRuns with correct schema
  console.log('Fixing MigrationRuns...');
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "MigrationRuns" CASCADE;`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "MigrationRuns" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "lastUserId" INTEGER NOT NULL DEFAULT 0,
        "totalUsers" INTEGER NOT NULL DEFAULT 0,
        "processedUsers" INTEGER NOT NULL DEFAULT 0,
        "status" "MigrationStatus" NOT NULL DEFAULT 'RUNNING',
        "errorMessage" TEXT,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" TIMESTAMP(3),
        CONSTRAINT "MigrationRuns_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "MigrationRuns_name_status_idx" ON "MigrationRuns"("name", "status");`);
  console.log('  ✅ MigrationRuns table recreated');

  // Drop and recreate AdminQueueSeen with correct schema (note: it's AdminQueueSeens in the schema)
  console.log('Fixing AdminQueueSeen...');
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "AdminQueueSeen" CASCADE;`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "AdminQueueSeens" CASCADE;`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "AdminQueueSeens" (
        "id" TEXT NOT NULL,
        "adminUserId" INTEGER NOT NULL,
        "lastSeenQueueId" TEXT,
        "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AdminQueueSeens_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AdminQueueSeens_adminUserId_key" ON "AdminQueueSeens"("adminUserId");`);
  console.log('  ✅ AdminQueueSeens table recreated');

  // Update LedgerEntries index to match schema (includes createdAt)
  console.log('Fixing LedgerEntries indexes...');
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "LedgerEntries_userId_currency_idx";`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LedgerEntries_userId_currency_createdAt_idx" ON "LedgerEntries"("userId", "currency", "createdAt" DESC);`);
  console.log('  ✅ LedgerEntries indexes updated');

  console.log('\n✅ All table schemas fixed');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
